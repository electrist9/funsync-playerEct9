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
hard cap at MAX_IMAGES. Folder selection itself stays desktop-only.
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

    return {
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
