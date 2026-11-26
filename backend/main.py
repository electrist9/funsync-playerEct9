"""FunSync Player — Python Backend (FastAPI)"""

import argparse
import os
import sys
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from routes.scripts import router as scripts_router
from routes.thumbnails import router as thumbnails_router
from routes.metadata import router as metadata_router
from routes.media import router as media_router
from routes.vr_api import router as vr_api_router
from routes.remote import router as remote_router
from routes.remote_sync import router as remote_sync_router
from routes.locale import router as locale_router, set_user_data_dir
from routes.generate import router as generate_router
from routes.slideshow import router as slideshow_router
from routes.slideshow import media_router as slideshow_media_router

app = FastAPI(title="FunSync Backend", version="0.1.0")

# Set True by __main__ when uvicorn is started with the self-signed cert
# (--tls). Surfaced on /network-info so desktop + web clients can build the
# right scheme URLs for the headset.
_tls_serving = False

# Allow Electron renderer to call the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scripts_router, prefix="/scripts", tags=["scripts"])
app.include_router(thumbnails_router, prefix="/thumbnails", tags=["thumbnails"])
app.include_router(metadata_router, prefix="/metadata", tags=["metadata"])
app.include_router(media_router, prefix="/api/media", tags=["media"])
app.include_router(vr_api_router, tags=["vr"])
app.include_router(remote_router, prefix="/api/remote", tags=["remote"])
app.include_router(remote_sync_router, prefix="/api/remote", tags=["remote-sync"])
app.include_router(locale_router, prefix="/api/remote", tags=["locale"])
app.include_router(generate_router, prefix="/api/generate", tags=["generate"])
app.include_router(slideshow_router, prefix="/api/remote/slideshow", tags=["slideshow"])
app.include_router(slideshow_media_router, prefix="/api/media/slideshow", tags=["slideshow-media"])

# Web remote SPA served at /remote/ — static files live in backend/web-remote/.
# Resolve relative to this file so it works both in dev (python main.py) and
# packaged (PyInstaller rewrites __file__ to the temp bundle root).
_remote_base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
_remote_dir = os.path.join(_remote_base, "web-remote")
if os.path.isdir(_remote_dir):
    app.mount("/remote", StaticFiles(directory=_remote_dir, html=True), name="web-remote")


# WebXR (VR headset) SPA served at /vr/ — static files live in
# backend/vr-remote/. Same `_MEIPASS` resolution as /remote above; the
# PyInstaller spec bundles this folder as <_MEIPASS>/vr-remote.
_vr_dir = os.path.join(_remote_base, "vr-remote")
if os.path.isdir(_vr_dir):
    app.mount("/vr", StaticFiles(directory=_vr_dir, html=True), name="vr-remote")


# Shared ES modules reused by BOTH the 2D remote and the VR SPA (and by
# vitest straight from renderer/js/). Served at /shared-js/ with an explicit
# whitelist — never a directory listing, never arbitrary file reads. In dev
# the files live at <project>/renderer/js/; packaged builds ship a copy at
# <_MEIPASS>/shared-js/ (see funsync-backend.spec datas).
_SHARED_JS_ALLOW = {"slideshow-timing.js", "slideshow-color.js"}


def _resolve_shared_js_path(name: str) -> str | None:
    candidates = []
    if hasattr(sys, "_MEIPASS"):
        candidates.append(os.path.join(sys._MEIPASS, "shared-js", name))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.abspath(os.path.join(here, "..", "renderer", "js", name)))
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


@app.get("/shared-js/{name}")
async def shared_js(name: str):
    from fastapi import HTTPException
    from fastapi.responses import FileResponse
    if name not in _SHARED_JS_ALLOW:
        raise HTTPException(status_code=404)
    path = _resolve_shared_js_path(name)
    if not path:
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="application/javascript")


# Stale-asset guard for the web remote (2026-08-04): after an app update the
# phone would mix cached index.html/style.css with freshly-fetched app.js —
# broken hybrid UI until a manual reload (bit Dave live on the 0.9 remote
# rework; versioned URLs wouldn't fully fix it because app.js's sibling ES-
# module imports cache independently). `no-cache` forces revalidation on
# every /remote/ asset: StaticFiles serves ETags, so unchanged files are
# 304s — trivial on LAN — and changed files are always picked up.
@app.middleware("http")
async def _remote_no_stale_cache(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if (
        path == "/remote" or path.startswith("/remote/")
        or path == "/vr" or path.startswith("/vr/")
        or path.startswith("/shared-js/")
        or path.startswith("/locales/")
    ):
        response.headers["Cache-Control"] = "no-cache"
    return response

# Locale bundles for the web-remote i18n module. In packaged builds
# PyInstaller's spec ships renderer/locales/ as <_MEIPASS>/locales/.
# In dev they live at <project>/renderer/locales/ (two dirs up from
# backend/main.py). Web-remote fetches `/locales/<lang>.json` at boot.
def _resolve_locales_dir() -> str | None:
    candidates = []
    if hasattr(sys, "_MEIPASS"):
        candidates.append(os.path.join(sys._MEIPASS, "locales"))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.abspath(os.path.join(here, "..", "renderer", "locales")))
    for c in candidates:
        if os.path.isdir(c):
            return c
    return None

_locales_dir = _resolve_locales_dir()
if _locales_dir:
    app.mount("/locales", StaticFiles(directory=_locales_dir), name="locales")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/")
async def root():
    """Root URL — simple text so DeoVR's auto-discovery requests /deovr instead.

    DeoVR only enters 'Json mode' when the URL path contains '/deovr'.
    Returning JSON here would cause DeoVR to display raw text.
    """
    return {"status": "FunSync VR Server", "deovr": "/deovr", "heresphere": "/heresphere"}


@app.get("/network-info")
async def network_info():
    """Return the local network IP for VR server URL display.

    `scheme`/`tls` let the desktop (and the 2D remote) build a URL the
    headset will actually open: WebXR needs https (or an adb-reverse
    localhost fallback), so when --tls is on we advertise https here.
    """
    from services.network import get_local_ip
    return {
        "ip": get_local_ip(),
        "tls": _tls_serving,
        "scheme": "https" if _tls_serving else "http",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5123)
    parser.add_argument("--host", type=str, default="0.0.0.0")
    # Path to electron-conf's userData dir (contains config.json). Used
    # by the web-remote locale endpoint to mirror the desktop's chosen
    # language, and as the root of the generated-funscript store
    # (<userData>/generated-scripts, unless settings.library.generatedStoreDir
    # points it at another folder). Optional — both fall back if absent.
    parser.add_argument("--user-data-dir", type=str, default=None)
    # WebXR needs a secure context. `--tls` starts uvicorn with a locally
    # generated self-signed cert (see services/tls.py): import the .crt on
    # the headset once, or use the documented `adb reverse tcp:5123
    # tcp:5123` fallback and open http://localhost:5123/vr/ instead.
    parser.add_argument("--tls", action="store_true",
                        help="serve HTTPS with a self-signed cert (for WebXR)")
    args = parser.parse_args()

    if args.user_data_dir:
        set_user_data_dir(args.user_data_dir)

    ssl_kwargs = {}
    if args.tls:
        from services.tls import ensure_self_signed_cert
        cert_dir = (
            os.path.join(args.user_data_dir, "vr-certs")
            if args.user_data_dir
            else os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")
        )
        cert_path, key_path = ensure_self_signed_cert(cert_dir)
        ssl_kwargs = {"ssl_certfile": cert_path, "ssl_keyfile": key_path}
        # Module-level assignment: the route closures read this global at
        # request time (this module is `__main__` when run via python main.py).
        _tls_serving = True

    uvicorn.run(app, host=args.host, port=args.port, **ssl_kwargs)
