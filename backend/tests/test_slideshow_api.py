"""Tests for the slideshow endpoints backing the VR photo slideshow.

Routes under test (see routes/slideshow.py):
  - GET /api/remote/slideshow/config
  - GET /api/remote/slideshow/images
  - GET /api/media/slideshow/image/{token}/{index}

The configured folder comes from config.json settings.player.slideshowFolder
via the shared user-data-dir plumbing (same fixture style as test_locale.py).
"""

import json
import os
import tempfile

import pytest
from httpx import AsyncClient, ASGITransport

from main import app
from routes.locale import set_user_data_dir
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
    slideshow._listing_cache.clear()
    yield
    set_user_data_dir(None)
    slideshow._listing_cache.clear()


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


# --- natural sort helper (unit level) ---------------------------------------

def test_natural_compare_key_orders_numerics_first():
    names = ["img10.png", "img2.png", "img1.png", "3.png"]
    assert sorted(names, key=slideshow.natural_compare_key) == [
        "3.png", "img1.png", "img2.png", "img10.png",
    ]
