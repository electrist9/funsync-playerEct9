"""Slideshow API — photo-folder read access for the VR (WebXR) client.

The desktop slideshow reads photos through Electron IPC
(electron/slideshow-images.js + main.js handlers). The VR client has no
Electron, so the backend exposes the SAME configured folder
(settings.player.slideshowFolder in config.json) over HTTP:

- GET /api/remote/slideshow/config  — is a folder configured + the desktop's
  appearance defaults (corner, size, order, transition, background, presets)
  so the VR UI can mirror them. Never returns the raw folder path.
- GET /api/remote/slideshow/images  — the configured folder's images,
  naturally sorted, as [{index, url}] pointing at the media endpoint below.
- GET /api/media/slideshow/image/{token}/{index} — serves image #index from
  the currently-configured folder. The token is a hash of the folder path
  (same _path_to_id-style hashing as the video stream), so the URL carries
  NO filesystem path — the server only ever opens files inside the folder it
  read from config.json, filtered to slideshow-image extensions. No new
  traversal surface.

Listing mirrors electron/slideshow-images.js: same extension whitelist,
dot-file/dot-directory skipping, natural (numeric-aware) sort by basename,
hard cap at MAX_IMAGES. Folder selection is NOT desktop-only: the VR picker
uses GET /browse (one level of the tree, roots = video sources + drives) and
PUT /folder (merge-preserving atomic write of settings.player.slideshowFolder
plus an observer push so a running desktop adopts the change).
"""

import hashlib
import json
import os
import re
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from services.paths import get_user_data_dir

# Two routers: the client-facing config/listing endpoints sit under the
# remote API prefix; the image bytes sit under the media prefix (they are
# media streaming, same as videos/thumbnails).
router = APIRouter()
media_router = APIRouter()

# Mirrors SLIDESHOW_IMAGE_EXTS in electron/slideshow-images.js.
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}
# Mirrors SLIDESHOW_MAX_IMAGES.
MAX_IMAGES = 5000

# Listing cache: token -> (monotonic_time, [paths]). The VR client fetches
# images one by one; re-walking the folder per image would be wasteful on
# big folders. Short TTL so a folder swap on the desktop is picked up fast.
_LIST_TTL_S = 10.0
_listing_cache: dict = {}

# Whitelists mirroring renderer/js/slideshow-timing.js sanitizers. Anything
# else from config.json falls back to the built-in default.
_CORNERS = ("top_left", "top_right", "bottom_left", "bottom_right")
_SIZES = (4, 8, 16)
_ORDERS = ("name", "random")
_TRANSITIONS = ("crossfade", "wipe_left", "wipe_right", "slide_left",
                "slide_right", "zoom", "random")
_BACKGROUNDS = ("solid", "dominant")


def _read_player_settings() -> dict:
    user_data_dir = get_user_data_dir()
    if not user_data_dir:
        return {}
    config_path = os.path.join(user_data_dir, "config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        player = data.get("settings", {}).get("player", {})
        return player if isinstance(player, dict) else {}
    except (OSError, json.JSONDecodeError, ValueError):
        return {}


def _configured_folder() -> str:
    player = _read_player_settings()
    folder = player.get("slideshowFolder")
    return folder if isinstance(folder, str) and folder else ""


def folder_token(folder: str) -> str:
    """Stable opaque handle for the configured folder (never expose paths)."""
    return hashlib.sha1(os.path.abspath(folder).encode("utf-8")).hexdigest()[:16]


# --- natural sort (mirrors naturalCompare in electron/slideshow-images.js) --

def natural_compare_key(s: str):
    """Sort key: split into runs, numeric runs become (0, value), text runs
    become (1, lowercased). Tuple compare == the JS naturalCompare result."""
    parts = re.findall(r"\d+|\D+", s)
    key = []
    for p in parts:
        if p.isdigit():
            key.append((0, int(p), ""))
        else:
            key.append((1, 0, p.lower()))
    return key


def is_slideshow_image_name(name: str) -> bool:
    if name.startswith("."):
        return False
    dot = name.rfind(".")
    if dot <= 0:
        return False
    return name[dot:].lower() in IMAGE_EXTS


def list_slideshow_images(folder: str) -> list:
    """Recursively collect slideshow images under `folder`, naturally
    sorted by basename, capped at MAX_IMAGES. Dot-directories and dot-files
    are skipped (mirrors collectSlideshowImages in electron/slideshow-images.js)."""
    token = folder_token(folder)
    now = time.monotonic()
    cached = _listing_cache.get(token)
    if cached and now - cached[0] < _LIST_TTL_S:
        return cached[1]

    images = []
    try:
        for root, dirnames, filenames in os.walk(folder):
            # Skip dot-directories in place so os.walk never descends into
            # them (e.g. .thumbnails).
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for fn in filenames:
                if not is_slideshow_image_name(fn):
                    continue
                images.append(os.path.join(root, fn))
                if len(images) >= MAX_IMAGES:
                    break
            if len(images) >= MAX_IMAGES:
                break
    except OSError:
        images = []
    images.sort(key=lambda p: natural_compare_key(os.path.basename(p)))
    _listing_cache[token] = (now, images)
    return images


# --- client-facing endpoints (mounted at /api/remote/slideshow) -------------

@router.get("/config")
async def slideshow_config():
    folder = _configured_folder()
    if not folder:
        return {"configured": False}
    player = _read_player_settings()

    corner = player.get("slideshowCorner")
    if corner not in _CORNERS:
        corner = "bottom_right"
    size_denom = player.get("slideshowSizeDenom")
    if size_denom not in _SIZES:
        size_denom = 8
    order = player.get("slideshowImageOrder")
    if order not in _ORDERS:
        order = "name"
    transition = player.get("slideshowTransition")
    if transition not in _TRANSITIONS:
        transition = "crossfade"
    background = player.get("slideshowBackground")
    if background not in _BACKGROUNDS:
        background = "solid"
    preset = player.get("slideshowPreset")
    preset = preset if isinstance(preset, str) else ""
    raw_presets = player.get("slideshowPresets")
    presets = []
    if isinstance(raw_presets, list):
        for p in raw_presets:
            if not isinstance(p, dict):
                continue
            name = p.get("name")
            mode = p.get("mode")
            if not isinstance(name, str) or not name or mode not in ("up", "peak", "cumulative"):
                continue
            try:
                threshold = max(0.0, float(p.get("threshold", 0)))
                step = max(0.0, float(p.get("step", 100)))
            except (TypeError, ValueError):
                continue
            p_order = p.get("order")
            presets.append({
                "name": name[:64],
                "mode": mode,
                "threshold": threshold,
                "step": step,
                "order": p_order if p_order in ("forward", "pingpong") else "forward",
            })

    body = {
        "configured": True,
        "folderExists": os.path.isdir(folder),
        "corner": corner,
        "sizeDenom": size_denom,
        "imageOrder": order,
        "transition": transition,
        "background": background,
        "preset": preset,
        "presets": presets,
    }
    # Reveal the folder path ONLY when it already sits inside a registered
    # media source root — the VR picker's browse API exposes those paths to
    # every client anyway, and the picker needs it to open AT the configured
    # folder. A desktop-configured folder outside all roots stays private.
    if _root_for(folder):
        body["folder"] = folder
    return body


@router.get("/images")
async def slideshow_images():
    from routes.remote import _BOOT_TOKEN  # version param for cache-busting, same as streamUrl
    folder = _configured_folder()
    if not folder:
        raise HTTPException(status_code=404, detail="no slideshow folder configured")
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="configured slideshow folder is missing")
    images = list_slideshow_images(folder)
    token = folder_token(folder)
    return {
        "count": len(images),
        "token": token,
        "images": [
            {
                "index": i,
                "url": f"/api/media/slideshow/image/{token}/{i}?v={_BOOT_TOKEN}",
            }
            for i in range(len(images))
        ],
    }


# --- folder browsing + selection (VR picker) --------------------------------

# The desktop settings own player.slideshowFolder (config.json), but the VR
# client can now change it too. Writing the file is done as a merge-
# preserving read-modify-write, and after every backend-side write the
# observer (remote_sync) is notified so a RUNNING desktop — electron-conf
# caches the whole store in memory and rewrites it on any change — adopts
# the new value instead of later clobbering it with a full save.

def _browse_roots() -> list:
    """Root folders the browse endpoint may list. Enabled video sources keep
    their display names; on Windows every drive root is also browsable, on
    POSIX the filesystem root. Listing exposes DIRECTORY NAMES only, never
    file contents, and the backend is LAN-bound — the same trust level as
    the existing video/thumbnail/slideshow streaming endpoints."""
    from routes.media import get_sources  # lazy import: avoid cycles
    roots = []
    seen = set()
    for s in get_sources():
        if s.get("enabled") is False:
            continue
        p = s.get("path") or ""
        if not p or not os.path.isdir(p):
            continue
        rp = os.path.realpath(p)
        if rp in seen:
            continue
        seen.add(rp)
        name = s.get("name") or os.path.basename(p.rstrip("\\/")) or p
        roots.append({"name": str(name), "path": rp})
    if os.name == "nt":
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = f"{letter}:\\"
            if os.path.isdir(drive):
                roots.append({"name": drive, "path": drive})
    else:
        roots.append({"name": "/", "path": "/"})
    return roots


def _within(root: str, path: str) -> bool:
    """True when `path` is `root` or below it (case-normalized on Windows)."""
    rr = os.path.normcase(os.path.realpath(root)).rstrip("\\/")
    rp = os.path.normcase(os.path.realpath(path))
    if not rr:
        return True  # POSIX filesystem root contains everything
    return rp == rr or rp.startswith(rr + os.sep)


def _root_for(path: str) -> str:
    """Realpath of the browse root containing `path`, or "" when none does."""
    for root in _browse_roots():
        if _within(root["path"], path):
            return os.path.realpath(root["path"])
    return ""


# Desktop-parity limits for the picker (mirrors electron/photo-browser.js:
# BROWSE_MAX_DIRS / BROWSE_MAX_IMAGES / BROWSE_COUNT_CAP / BROWSE_TOTAL_STAT_CAP).
_BROWSE_MAX_DIRS = 500
_BROWSE_MAX_IMAGES = 1000
_BROWSE_COUNT_CAP = 500
_BROWSE_TOTAL_STAT_CAP = 2000


def _summarize_dir(dir_path: str, count_cap: int, budget: list) -> tuple:
    """(photo_count, capped, cover_path) for one sub-directory, counting
    slideshow images with a breadth-first walk so shallow photos win. The
    cover is the FIRST image in readdir BFS order (deliberately not natural
    sort — same as the desktop's summarizeDir). `budget` is a one-element
    list of readdir ops left, shared across the whole browse hop so a huge
    tree can't make one /browse request drag. Unreadable sub-folders are
    skipped, never fatal."""
    cover = None
    count = 0
    queue = [dir_path]
    while queue and budget[0] > 0:
        current = queue.pop(0)
        budget[0] -= 1
        try:
            with os.scandir(current) as it:
                for e in it:
                    if e.name.startswith("."):
                        continue
                    try:
                        if e.is_dir():
                            queue.append(e.path)
                            continue
                    except OSError:
                        continue
                    if not is_slideshow_image_name(e.name):
                        continue
                    count += 1
                    if cover is None:
                        cover = e.path
                    if count >= count_cap:
                        return (count, True, cover)
        except OSError:
            continue
    return (count, False, cover)


@router.get("/browse")
async def slideshow_browse(path: str | None = None):
    """One level of the folder tree for the VR slideshow picker.

    No `path` → the browse roots (enabled video sources + drive roots).
    Otherwise the immediate sub-directories AND slideshow images of `path`,
    both naturally sorted, dot-entries skipped; each dir carries the
    desktop's cover/photo-count summary (photoCount/capped/coverPath) so
    the VR tiles can show thumbnails. Sub-paths outside the roots 403."""
    if not path:
        return {
            "path": "",
            "parent": None,
            "dirs": [{"name": r["name"], "path": r["path"]} for r in _browse_roots()],
        }
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail="folder not found")
    if not _root_for(path):
        raise HTTPException(status_code=403, detail="folder not browsable")
    dir_names = []
    image_names = []
    try:
        with os.scandir(path) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    if e.is_dir():
                        dir_names.append(e.name)
                    elif is_slideshow_image_name(e.name):
                        image_names.append(e.name)
                except OSError:
                    continue
    except OSError:
        raise HTTPException(status_code=404, detail="folder not readable")
    dir_names.sort(key=natural_compare_key)
    image_names.sort(key=natural_compare_key)
    truncated = {
        "dirs": len(dir_names) > _BROWSE_MAX_DIRS,
        "images": len(image_names) > _BROWSE_MAX_IMAGES,
    }
    dir_names = dir_names[:_BROWSE_MAX_DIRS]
    image_names = image_names[:_BROWSE_MAX_IMAGES]
    budget = [_BROWSE_TOTAL_STAT_CAP]
    dirs = []
    for n in dir_names:
        full = os.path.join(path, n)
        photo_count, capped, cover = _summarize_dir(full, _BROWSE_COUNT_CAP, budget)
        dirs.append({
            "name": n,
            "path": full,
            "photoCount": photo_count,
            "capped": capped,
            "coverPath": cover,
        })
    parent = os.path.dirname(os.path.normpath(path))
    if parent == os.path.normpath(path) or not _root_for(parent):
        parent = None  # stop the picker's "up" at the browse root (no 403 dead-end)
    return {
        "path": path,
        "parent": parent,
        "dirs": dirs,
        "images": [{"name": n, "path": os.path.join(path, n)} for n in image_names],
        "truncated": truncated,
    }


@router.put("/folder")
async def slideshow_set_folder(payload: dict):
    """Set settings.player.slideshowFolder from the VR picker ({path} body).

    Merge-preserving: config.json is read, only the player.slideshowFolder
    key is touched, and the result is written atomically (tmp + rename).
    Afterwards the observer is pushed a slideshow-folder-changed message so
    the running desktop's cached store stays current (no-op when the
    desktop is closed; the file write stands on its own then)."""
    folder = payload.get("path") if isinstance(payload, dict) else None
    if not isinstance(folder, str) or not folder:
        raise HTTPException(status_code=400, detail="path required")
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="folder not found")
    if not _root_for(folder):
        raise HTTPException(status_code=403, detail="folder not browsable")

    user_data_dir = get_user_data_dir()
    if not user_data_dir:
        raise HTTPException(status_code=503, detail="server storage unavailable")
    config_path = os.path.join(user_data_dir, "config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except FileNotFoundError:
        data = {}
    except (OSError, json.JSONDecodeError, ValueError):
        # Corrupt config.json: refuse rather than clobber the user's store.
        raise HTTPException(status_code=500, detail="could not read config.json")
    settings = data.get("settings")
    if not isinstance(settings, dict):
        settings = {}
    player = settings.get("player")
    if not isinstance(player, dict):
        player = {}
    player["slideshowFolder"] = folder
    settings["player"] = player
    data["settings"] = settings

    tmp_path = config_path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, config_path)
    except OSError:
        raise HTTPException(status_code=500, detail="could not write config.json")

    from routes.remote_sync import notify_observer  # lazy import: avoid cycles
    await notify_observer({"type": "slideshow-folder-changed", "path": folder})
    return {"ok": True}


# --- image bytes (mounted at /api/media/slideshow) ---------------------------

@media_router.get("/image/{token}/{index}")
async def slideshow_image(token: str, index: int):
    folder = _configured_folder()
    if not folder:
        raise HTTPException(status_code=404)
    # The URL token must match the CURRENTLY configured folder — a stale or
    # forged token 404s, and there is no way to name a folder from the URL.
    if token != folder_token(folder):
        raise HTTPException(status_code=404)
    if index < 0:
        raise HTTPException(status_code=404)
    images = list_slideshow_images(folder)
    if index >= len(images):
        raise HTTPException(status_code=404)
    path = images[index]
    # Extension guard: the listing only ever contains whitelisted images,
    # but a folder could have been swapped between cache fill and here.
    dot = path.rfind(".")
    if dot <= 0 or path[dot:].lower() not in IMAGE_EXTS:
        raise HTTPException(status_code=404)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404)
    return FileResponse(path)


@media_router.get("/thumb")
def slideshow_thumb(path: str, w: int = 256):
    """Scaled JPEG thumbnail of ONE photo file, for the VR picker's folder
    cover tiles and photo tiles (the analogue of the desktop IPC's
    read-slideshow-thumbnail). Plain `def` on purpose: the ffmpeg decode
    blocks, so FastAPI must run it in its thread pool, not the event loop.

    Security mirrors /browse: the file must live under a browse root, and
    its extension must be a whitelisted slideshow image — raw paths stay
    inside the LAN trust boundary already documented in _browse_roots."""
    if not path:
        raise HTTPException(status_code=400, detail="path required")
    if not _root_for(path):
        raise HTTPException(status_code=403, detail="file not browsable")
    dot = path.rfind(".")
    if dot <= 0 or path[dot:].lower() not in IMAGE_EXTS:
        raise HTTPException(status_code=404)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404)
    max_dim = min(512, max(64, w))
    from services.ffmpeg import generate_photo_thumbnail  # lazy import: keep server start lean
    try:
        thumb_path = generate_photo_thumbnail(path, max_dim)
    except FileNotFoundError:
        raise HTTPException(status_code=404)
    except RuntimeError:
        raise HTTPException(status_code=502, detail="thumbnail generation failed")
    # Short TTL: ffmpeg's own disk cache is mtime-keyed, so replacing the
    # photo refreshes the bytes quickly even if an HTTP cache holds a bit.
    return FileResponse(
        thumb_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=300"},
    )
