"""Tests for the slideshow endpoints backing the VR photo slideshow.

Routes under test (see routes/slideshow.py):
  - GET /api/remote/slideshow/config
  - GET /api/remote/slideshow/images
  - GET /api/media/slideshow/image/{token}/{index}
  - GET /api/remote/slideshow/browse   (VR folder picker)
  - PUT /api/remote/slideshow/folder   (VR folder picker)
  - GET /api/media/slideshow/thumb     (VR picker cover/photo thumbnails)

The configured folder comes from config.json settings.player.slideshowFolder
via the shared user-data-dir plumbing (same fixture style as test_locale.py).
"""

import json
import os
import tempfile
from urllib.parse import quote

import pytest
from httpx import AsyncClient, ASGITransport

from main import app
from routes.locale import set_user_data_dir
from routes.media import register_sources
import routes.slideshow as slideshow


# A 2x2 black PNG — real image bytes so FileResponse sniffs image/* too.
import base64
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91Jpz"
    "AAAAF0lEQVR4nGP6z4DAwMDABQDMDQEBQMKjgAAAAABJRU5ErkJggg=="
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def tmp_user_data():
    with tempfile.TemporaryDirectory() as td:
        yield td


@pytest.fixture(autouse=True)
def reset_state():
    set_user_data_dir(None)
    register_sources([])
    slideshow._listing_cache.clear()
    yield
    set_user_data_dir(None)
    register_sources([])
    slideshow._listing_cache.clear()


@pytest.fixture
def source_root():
    with tempfile.TemporaryDirectory() as td:
        yield td


def write_config(user_dir: str, player: dict) -> None:
    with open(os.path.join(user_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"settings": {"player": player}}, f)


def make_photos(root: str, names) -> None:
    os.makedirs(root, exist_ok=True)
    for name in names:
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(PNG_BYTES)


# --- /config ---------------------------------------------------------------

async def test_config_not_configured(client, tmp_user_data):
    set_user_data_dir(tmp_user_data)
    res = await client.get("/api/remote/slideshow/config")
    assert res.status_code == 200
    assert res.json() == {"configured": False}


async def test_config_no_user_data_dir(client):
    res = await client.get("/api/remote/slideshow/config")
    assert res.status_code == 200
    assert res.json() == {"configured": False}


async def test_config_configured_with_defaults(client, tmp_user_data):
    photos = os.path.join(tmp_user_data, "photos")
    make_photos(photos, ["a.png"])
    write_config(tmp_user_data, {"slideshowFolder": photos})
    set_user_data_dir(tmp_user_data)
    body = (await client.get("/api/remote/slideshow/config")).json()
    assert body["configured"] is True
    assert body["folderExists"] is True
    # Desktop defaults (electron/store.js).
    assert body["corner"] == "bottom_right"
    assert body["sizeDenom"] == 8
    assert body["imageOrder"] == "name"
    assert body["transition"] == "crossfade"
    assert body["background"] == "solid"
    assert body["presets"] == []
    # Never leak the raw filesystem path.
    assert photos not in json.dumps(body)


async def test_config_missing_folder_flagged(client, tmp_user_data):
    ghost = os.path.join(tmp_user_data, "gone")
    write_config(tmp_user_data, {"slideshowFolder": ghost})
    set_user_data_dir(tmp_user_data)
    body = (await client.get("/api/remote/slideshow/config")).json()
    assert body["configured"] is True
    assert body["folderExists"] is False


async def test_config_exposes_folder_only_within_sources(client, tmp_user_data, source_root, monkeypatch):
    # Inside a registered source root the path is already visible through
    # /browse, so /config reveals it (the VR picker opens at this folder).
    photos = os.path.join(source_root, "photos")
    make_photos(photos, ["a.png"])
    write_config(tmp_user_data, {"slideshowFolder": photos})
    set_user_data_dir(tmp_user_data)
    register_sources([{"id": "1", "name": "S", "path": source_root}])
    body = (await client.get("/api/remote/slideshow/config")).json()
    assert body["folder"] == photos
    # Outside every root the raw path stays private (desktop-only setting).
    # Windows _browse_roots() probes drive letters (the picker can already
    # browse whole drives), so pin the roots to source_root to exercise the
    # not-browsable case deterministically.
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    outside = os.path.join(tmp_user_data, "outside")
    make_photos(outside, ["a.png"])
    write_config(tmp_user_data, {"slideshowFolder": outside})
    body = (await client.get("/api/remote/slideshow/config")).json()
    assert "folder" not in body
    assert outside not in json.dumps(body)


async def test_config_sanitizes_bad_values(client, tmp_user_data):
    photos = os.path.join(tmp_user_data, "photos")
    make_photos(photos, ["a.png"])
    write_config(tmp_user_data, {
        "slideshowFolder": photos,
        "slideshowCorner": "middle",
        "slideshowSizeDenom": 3,
        "slideshowImageOrder": "shuffle",
        "slideshowTransition": "explode",
        "slideshowBackground": "kaleidoscope",
        "slideshowPreset": 42,
        "slideshowPresets": [
            {"name": "good", "mode": "peak", "threshold": -5, "step": "120", "order": "pingpong"},
            {"name": "", "mode": "up"},
            {"name": "bad-mode", "mode": "vibes"},
            "not-a-dict",
            {"name": "bad-numbers", "mode": "up", "threshold": "x"},
        ],
    })
    set_user_data_dir(tmp_user_data)
    body = (await client.get("/api/remote/slideshow/config")).json()
    assert body["corner"] == "bottom_right"
    assert body["sizeDenom"] == 8
    assert body["imageOrder"] == "name"
    assert body["transition"] == "crossfade"
    assert body["background"] == "solid"
    assert body["preset"] == ""
    # Only the one well-formed preset survives, with clamped/coerced numbers.
    assert body["presets"] == [
        {"name": "good", "mode": "peak", "threshold": 0.0, "step": 120.0, "order": "pingpong"},
    ]


# --- /images ---------------------------------------------------------------

async def test_images_404_without_config(client, tmp_user_data):
    set_user_data_dir(tmp_user_data)
    assert (await client.get("/api/remote/slideshow/images")).status_code == 404


async def test_images_404_when_folder_missing(client, tmp_user_data):
    write_config(tmp_user_data, {"slideshowFolder": os.path.join(tmp_user_data, "gone")})
    set_user_data_dir(tmp_user_data)
    assert (await client.get("/api/remote/slideshow/images")).status_code == 404


async def test_images_natural_order_and_filters(client, tmp_user_data):
    photos = os.path.join(tmp_user_data, "photos")
    make_photos(photos, [
        "img2.png", "img10.png", "img1.png",
        "sub/3.png",            # nested, picked up
        ".hidden.png",          # dot-file skipped
        "notes.txt",            # non-image skipped
        ".thumbnails/skip.png", # dot-directory skipped
    ])
    write_config(tmp_user_data, {"slideshowFolder": photos})
    set_user_data_dir(tmp_user_data)
    body = (await client.get("/api/remote/slideshow/images")).json()
    assert body["count"] == 4
    assert body["token"] == slideshow.folder_token(photos)
    # Recursion + natural sort by basename; numeric runs sort before text.
    urls = [img["url"] for img in body["images"]]
    assert [img["index"] for img in body["images"]] == [0, 1, 2, 3]
    for i, url in enumerate(urls):
        assert url.startswith(f"/api/media/slideshow/image/{body['token']}/{i}?v=")
    # URLs carry the hashed token only — never the folder path.
    assert photos not in json.dumps(body)


async def test_image_endpoint_serves_bytes(client, tmp_user_data):
    photos = os.path.join(tmp_user_data, "photos")
    make_photos(photos, ["a.png"])
    write_config(tmp_user_data, {"slideshowFolder": photos})
    set_user_data_dir(tmp_user_data)
    body = (await client.get("/api/remote/slideshow/images")).json()
    res = await client.get(body["images"][0]["url"])
    assert res.status_code == 200
    assert res.content == PNG_BYTES
    assert res.headers["content-type"].startswith("image/")


async def test_image_endpoint_rejects_bad_token(client, tmp_user_data):
    photos = os.path.join(tmp_user_data, "photos")
    make_photos(photos, ["a.png"])
    write_config(tmp_user_data, {"slideshowFolder": photos})
    set_user_data_dir(tmp_user_data)
    assert (await client.get("/api/media/slideshow/image/not-a-token/0")).status_code == 404


async def test_image_endpoint_rejects_out_of_range(client, tmp_user_data):
    photos = os.path.join(tmp_user_data, "photos")
    make_photos(photos, ["a.png"])
    write_config(tmp_user_data, {"slideshowFolder": photos})
    set_user_data_dir(tmp_user_data)
    token = slideshow.folder_token(photos)
    assert (await client.get(f"/api/media/slideshow/image/{token}/999")).status_code == 404
    assert (await client.get(f"/api/media/slideshow/image/{token}/-1")).status_code == 404


async def test_image_endpoint_stale_token_after_folder_swap(client, tmp_user_data):
    photos_a = os.path.join(tmp_user_data, "a")
    photos_b = os.path.join(tmp_user_data, "b")
    make_photos(photos_a, ["a.png"])
    make_photos(photos_b, ["b.png"])
    write_config(tmp_user_data, {"slideshowFolder": photos_a})
    set_user_data_dir(tmp_user_data)
    token_a = slideshow.folder_token(photos_a)
    res = await client.get(f"/api/media/slideshow/image/{token_a}/0")
    assert res.status_code == 200
    # Desktop points at folder B — old URLs must die, new token works.
    write_config(tmp_user_data, {"slideshowFolder": photos_b})
    assert (await client.get(f"/api/media/slideshow/image/{token_a}/0")).status_code == 404
    token_b = slideshow.folder_token(photos_b)
    assert (await client.get(f"/api/media/slideshow/image/{token_b}/0")).status_code == 200


# --- /browse + /folder (VR folder picker) -----------------------------------

async def test_browse_roots_include_sources_hide_disabled(client, source_root):
    off = os.path.join(source_root, "off-src")
    os.makedirs(off)
    register_sources([
        {"id": "1", "name": "PhotoSrc", "path": source_root},
        {"id": "2", "name": "OffSrc", "path": off, "enabled": False},
    ])
    body = (await client.get("/api/remote/slideshow/browse")).json()
    assert body["path"] == ""
    assert body["parent"] is None
    entries = {d["path"]: d["name"] for d in body["dirs"]}
    assert entries.get(os.path.realpath(source_root)) == "PhotoSrc"
    assert os.path.realpath(off) not in entries


async def test_browse_lists_subdirs_only_naturally_sorted(client, source_root):
    for name in ["img10", "img2", "img1", ".hidden", "b", "a"]:
        os.makedirs(os.path.join(source_root, name))
    with open(os.path.join(source_root, "file.txt"), "wb") as f:
        f.write(PNG_BYTES)
    register_sources([{"id": "1", "name": "S", "path": source_root}])
    body = (await client.get(f"/api/remote/slideshow/browse?path={quote(source_root)}")).json()
    assert body["path"] == source_root
    names = [d["name"] for d in body["dirs"]]
    assert names == ["a", "b", "img1", "img2", "img10"]
    assert body["dirs"][0]["path"] == os.path.join(source_root, "a")


async def test_browse_parent_stops_at_root(client, source_root, monkeypatch):
    # Pin the roots to source_root — on Windows the drive roots would let the
    # picker legitimately climb above the source, which is intended there.
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    sub = os.path.join(source_root, "sub")
    os.makedirs(sub)
    register_sources([{"id": "1", "name": "S", "path": source_root}])
    body = (await client.get(f"/api/remote/slideshow/browse?path={quote(sub)}")).json()
    assert body["parent"] == os.path.dirname(os.path.normpath(sub))
    body = (await client.get(f"/api/remote/slideshow/browse?path={quote(source_root)}")).json()
    assert body["parent"] is None


async def test_browse_missing_folder_404(client, source_root):
    register_sources([{"id": "1", "name": "S", "path": source_root}])
    missing = os.path.join(source_root, "nope")
    res = await client.get(f"/api/remote/slideshow/browse?path={quote(missing)}")
    assert res.status_code == 404


async def test_browse_and_folder_confined_to_roots(client, source_root, tmp_path, monkeypatch):
    # Windows adds drive roots, which would contain every temp path — pin the
    # roots to source_root so "outside" is actually outside.
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    outside = tmp_path / "outside"
    outside.mkdir()
    res = await client.get(f"/api/remote/slideshow/browse?path={quote(str(outside))}")
    assert res.status_code == 403
    res = await client.put("/api/remote/slideshow/folder", json={"path": str(outside)})
    assert res.status_code == 403
    res = await client.put("/api/remote/slideshow/folder", json={"path": os.path.join(source_root, "missing")})
    assert res.status_code == 404
    res = await client.put("/api/remote/slideshow/folder", json={})
    assert res.status_code == 400


async def test_folder_put_requires_user_data_dir(client, source_root):
    register_sources([{"id": "1", "name": "S", "path": source_root}])
    res = await client.put("/api/remote/slideshow/folder", json={"path": source_root})
    assert res.status_code == 503


async def test_folder_put_writes_config_preserving_siblings(client, tmp_user_data, source_root):
    photos = os.path.join(source_root, "photos")
    make_photos(photos, ["a.png"])
    write_config(tmp_user_data, {
        "slideshowFolder": os.path.join(source_root, "old"),
        "slideshowCorner": "bottom_left",
    })
    set_user_data_dir(tmp_user_data)
    register_sources([{"id": "1", "name": "S", "path": source_root}])
    res = await client.put("/api/remote/slideshow/folder", json={"path": photos})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    with open(os.path.join(tmp_user_data, "config.json"), "r", encoding="utf-8") as f:
        data = json.load(f)
    player = data["settings"]["player"]
    assert player["slideshowFolder"] == os.path.abspath(photos)
    assert player["slideshowCorner"] == "bottom_left"  # merge-preserving
    cfg = (await client.get("/api/remote/slideshow/config")).json()
    assert cfg["configured"] is True
    assert cfg["folderExists"] is True
    assert cfg["folder"] == os.path.abspath(photos)  # within the source root
    body = (await client.get("/api/remote/slideshow/images")).json()
    assert body["count"] == 1
    assert body["token"] == slideshow.folder_token(photos)


# --- /browse dir summaries (desktop-parity covers + photo counts) ----------

async def test_browse_dirs_carry_cover_and_photo_counts(client, source_root, monkeypatch):
    # sub: one shallow photo + two nested ones. The single shallow image
    # makes the BFS cover deterministic regardless of readdir order.
    sub = os.path.join(source_root, "sub")
    make_photos(sub, ["a.png"])
    make_photos(os.path.join(sub, "deep"), ["b.png", "c.png"])
    with open(os.path.join(sub, "notes.txt"), "wb") as f:
        f.write(PNG_BYTES)
    make_photos(source_root, ["p2.png", "p1.png"])
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    body = (await client.get(f"/api/remote/slideshow/browse?path={quote(source_root)}")).json()
    assert body["dirs"] == [{
        "name": "sub",
        "path": sub,
        "photoCount": 3,
        "capped": False,
        "coverPath": os.path.join(sub, "a.png"),
    }]
    # Shallow slideshow images ride along for the VR picker's photo tiles.
    assert body["images"] == [
        {"name": "p1.png", "path": os.path.join(source_root, "p1.png")},
        {"name": "p2.png", "path": os.path.join(source_root, "p2.png")},
    ]
    assert body["truncated"] == {"dirs": False, "images": False}


async def test_browse_photo_count_capped_and_images_truncated(client, source_root, monkeypatch):
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    monkeypatch.setattr(slideshow, "_BROWSE_COUNT_CAP", 3)
    monkeypatch.setattr(slideshow, "_BROWSE_MAX_IMAGES", 2)
    sub = os.path.join(source_root, "sub")
    make_photos(sub, ["a.png", "b.png", "c.png", "d.png"])
    make_photos(source_root, ["p1.png", "p2.png", "p3.png"])
    body = (await client.get(f"/api/remote/slideshow/browse?path={quote(source_root)}")).json()
    assert body["dirs"][0]["photoCount"] == 3
    assert body["dirs"][0]["capped"] is True
    assert body["dirs"][0]["coverPath"]  # capped still yields a cover
    assert [i["name"] for i in body["images"]] == ["p1.png", "p2.png"]
    assert body["truncated"] == {"dirs": False, "images": True}


async def test_browse_empty_dir_summary_has_no_cover(client, source_root, monkeypatch):
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    empty = os.path.join(source_root, "empty")
    os.makedirs(empty)
    body = (await client.get(f"/api/remote/slideshow/browse?path={quote(source_root)}")).json()
    assert body["dirs"][0]["photoCount"] == 0
    assert body["dirs"][0]["coverPath"] is None
    assert body["images"] == []


async def test_browse_roots_view_shape_unchanged(client, source_root, monkeypatch):
    # The roots view stays name/path-only (back-compat: the VR client
    # tolerates dirs without photoCount/coverPath).
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    body = (await client.get("/api/remote/slideshow/browse")).json()
    assert [set(d.keys()) for d in body["dirs"]] == [{"name", "path"}]
    assert "images" not in body or body.get("images") == []


# --- /api/media/slideshow/thumb (VR picker thumbnails) ----------------------

async def test_thumb_confined_to_roots(client, source_root, tmp_path, monkeypatch):
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    outside = tmp_path / "outside.png"
    outside.write_bytes(PNG_BYTES)
    res = await client.get(f"/api/media/slideshow/thumb?path={quote(str(outside))}")
    assert res.status_code == 403

    txt = os.path.join(source_root, "notes.txt")
    with open(txt, "wb") as f:
        f.write(PNG_BYTES)
    res = await client.get(f"/api/media/slideshow/thumb?path={quote(txt)}")
    assert res.status_code == 404  # non-image extension never reaches ffmpeg

    ghost = os.path.join(source_root, "ghost.png")
    res = await client.get(f"/api/media/slideshow/thumb?path={quote(ghost)}")
    assert res.status_code == 404  # missing file inside a root

    res = await client.get("/api/media/slideshow/thumb?path=")
    assert res.status_code == 400


async def test_thumb_serves_jpeg_with_clamped_width_and_cache_header(client, source_root, tmp_path, monkeypatch):
    photo = os.path.join(source_root, "cover.png")
    make_photos(source_root, ["cover.png"])
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])

    # Patch the module attribute — the endpoint's import is a lazy
    # in-function one, and this keeps the suite ffmpeg-free.
    import services.ffmpeg as ffmpeg_mod
    dims = []

    def fake_gen(image_path, max_dim):
        assert image_path == photo
        dims.append(max_dim)
        out = tmp_path / "thumb.jpg"
        out.write_bytes(b"\xff\xd8\xff\xe0fake")
        return str(out)

    monkeypatch.setattr(ffmpeg_mod, "generate_photo_thumbnail", fake_gen)

    res = await client.get(f"/api/media/slideshow/thumb?path={quote(photo)}&w=384")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/jpeg"
    assert res.headers["cache-control"] == "public, max-age=300"
    assert res.content == b"\xff\xd8\xff\xe0fake"

    await client.get(f"/api/media/slideshow/thumb?path={quote(photo)}&w=9999")
    await client.get(f"/api/media/slideshow/thumb?path={quote(photo)}&w=10")
    assert dims == [384, 512, 64]  # clamped into the 64..512 box


async def test_thumb_maps_generation_failures(client, source_root, monkeypatch):
    photo = os.path.join(source_root, "broken.webp")
    make_photos(source_root, ["broken.webp"])
    monkeypatch.setattr(slideshow, "_browse_roots", lambda: [{"name": "S", "path": source_root}])
    import services.ffmpeg as ffmpeg_mod

    def fake_missing(image_path, max_dim):
        raise FileNotFoundError(image_path)

    monkeypatch.setattr(ffmpeg_mod, "generate_photo_thumbnail", fake_missing)
    res = await client.get(f"/api/media/slideshow/thumb?path={quote(photo)}")
    assert res.status_code == 404

    def fake_failed(image_path, max_dim):
        raise RuntimeError("ffmpeg photo-thumbnail failed: boom")

    monkeypatch.setattr(ffmpeg_mod, "generate_photo_thumbnail", fake_failed)
    res = await client.get(f"/api/media/slideshow/thumb?path={quote(photo)}")
    assert res.status_code == 502
    assert "boom" not in res.text  # ffmpeg stderr never surfaced to clients


# --- natural sort helper (unit level) ---------------------------------------

def test_natural_compare_key_orders_numerics_first():
    names = ["img10.png", "img2.png", "img1.png", "3.png"]
    assert sorted(names, key=slideshow.natural_compare_key) == [
        "3.png", "img1.png", "img2.png", "img10.png",
    ]
