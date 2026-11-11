"""Funscript generation routes — audio engine and video-motion engine.

Contract with the renderer (renderer/js/funscript-generator.js):

  POST /api/generate/audio    {video_path, start_ms?, end_ms?, ...}  -> {job_id}
  POST /api/generate/motion   {video_path, start_ms?, end_ms?, ...}  -> {job_id}
  GET  /api/generate/{job_id}                                       -> {status, progress, ...}
  POST /api/generate/{job_id}/cancel                                -> {status}
  GET  /api/generate/store?video_path=...                           -> {items: [...]}
  GET  /api/generate/store/{script_id}                              -> {record, script}
  DELETE /api/generate/store/{script_id}                            -> {ok}
  POST /api/generate/store/{script_id}/export  {overwrite?}         -> {ok, filename}

Generation is deliberately a *job*, not a synchronous request: analysing a
30-minute video takes tens of seconds, and the renderer needs a progress bar
and a working Cancel button. It is also deliberately single-job — analysis
spawns an ffmpeg decode plus numpy work, and two at once would make the UI
lie about progress and starve the device-sync thread. A second request gets
409 with the id of the running job so the UI can point at it.

The analysis itself runs in a worker thread (asyncio.to_thread) so /health
keeps answering — see tests/test_backend_responsiveness.py. The engine
modules are imported *inside* that thread, which is what keeps numpy out of
backend startup and out of the PyInstaller import graph at boot.

Privacy: nothing here logs a file path or filename. Job ids and the store's
content hash are the only identifiers that leave this module.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from services.funscript_build import (
    DEFAULT_DEVICE,
    DEFAULT_MIN_INTERVAL_MS,
    DEFAULT_REDUCE_TOLERANCE,
    STYLES,
    BuildError,
    build_funscript,
    events_to_actions,
    signal_to_actions,
    speed_limit_for,
)
from services.generate_errors import GenerateError
from services.generated_store import get_store, video_identity

router = APIRouter()

MAX_FINISHED_JOBS = 20

_TERMINAL = ("done", "error", "cancelled")


class _Job:
    def __init__(self, engine: str, video_path: str, params: dict[str, Any]) -> None:
        self.id = f"g{int(time.time() * 1000):x}{threading.get_ident() & 0xffff:x}"
        self.engine = engine
        self.video_path = video_path
        self.params = params
        self.status = "queued"
        self.progress = 0.0
        self.created_at = time.time()
        self.error_code: str | None = None
        self.error_message: str | None = None
        self.script: dict[str, Any] | None = None
        self.summary: dict[str, Any] = {}
        self.script_id: str | None = None
        self.save_error: str | None = None
        self.cancel_event = threading.Event()

    def set_progress(self, value: float) -> None:
        # Progress only ever moves forward: engines report coarse stages and a
        # later stage must not make the bar jump backwards.
        if value > self.progress:
            self.progress = max(0.0, min(1.0, float(value)))

    def to_public(self, *, include_script: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "job_id": self.id,
            "engine": self.engine,
            "status": self.status,
            "progress": round(self.progress, 3),
            "summary": self.summary,
        }
        if self.error_code:
            payload["error_code"] = self.error_code
        if self.status == "error" and self.error_message:
            # Message goes to the log only; the UI shows error_code.
            payload["error_type"] = self.error_message.split(":", 1)[0]
        if self.script is not None and include_script:
            payload["script"] = self.script
            payload["action_count"] = len(self.script.get("actions", []))
        if self.script_id:
            payload["script_id"] = self.script_id
        if self.save_error:
            payload["save_error"] = self.save_error
        return payload


_jobs: dict[str, _Job] = {}
_active: _Job | None = None
_lock = threading.Lock()


def reset_jobs_for_tests() -> None:
    """Drop all job state (used by tests/test_generate_routes.py)."""
    global _active
    with _lock:
        _jobs.clear()
        _active = None


def _prune_locked() -> None:
    finished = [j for j in _jobs.values() if j.status in _TERMINAL]
    if len(finished) <= MAX_FINISHED_JOBS:
        return
    finished.sort(key=lambda j: j.created_at)
    for job in finished[:len(finished) - MAX_FINISHED_JOBS]:
        _jobs.pop(job.id, None)


async def _start_job(engine: str, request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"code": "badRange"})

    video_path = body.get("video_path")
    if not isinstance(video_path, str) or not video_path:
        raise HTTPException(status_code=400, detail={"code": "badRange", "field": "video_path"})
    if not os.path.isfile(video_path):
        raise HTTPException(status_code=404, detail={"code": "noVideo"})

    start_ms = _as_float(body.get("start_ms"), 0.0)
    end_ms = _as_float(body.get("end_ms"), None)
    if end_ms is not None and end_ms <= start_ms:
        raise HTTPException(status_code=400, detail={"code": "badRange", "field": "end_ms"})

    params: dict[str, Any] = {
        "start_ms": start_ms,
        "end_ms": end_ms,
        "style": body.get("style") if body.get("style") in STYLES else "alternating",
        "min_pos": _as_int(body.get("min_pos"), 0),
        "max_pos": _as_int(body.get("max_pos"), 100),
        "min_interval_ms": _as_int(body.get("min_interval_ms"), DEFAULT_MIN_INTERVAL_MS),
        "reduce_tolerance": _as_float(body.get("reduce_tolerance"), DEFAULT_REDUCE_TOLERANCE),
        "device": body.get("device") if isinstance(body.get("device"), str) else DEFAULT_DEVICE,
        "speed_limit": body.get("speed_limit") if body.get("speed_limit") in (None, "none") else _as_float(body.get("speed_limit"), None),
        "inverted": bool(body.get("inverted", False)),
        "save": bool(body.get("save", True)),
    }
    if engine == "audio":
        params["sensitivity"] = _as_float(body.get("sensitivity"), 1.4)
    else:
        quality = body.get("quality") if isinstance(body.get("quality"), str) else "standard"
        params["quality"] = quality
        params["crop_vr"] = bool(body.get("crop_vr", True))

    try:
        speed_limit_for(params["device"], int(params["speed_limit"]) if params["speed_limit"] else None)
    except BuildError:
        raise HTTPException(status_code=400, detail={"code": "badRange", "field": "device"})

    global _active
    with _lock:
        _prune_locked()
        if _active is not None and _active.status not in _TERMINAL:
            raise HTTPException(status_code=409, detail={
                "code": "busy",
                "job_id": _active.id,
                "engine": _active.engine,
            })
        job = _Job(engine, video_path, params)
        _jobs[job.id] = job
        _active = job
        job.status = "running"

    # to_thread keeps the event loop free for /health and device sync while
    # ffmpeg decodes in a worker. The engine import happens inside the thread.
    asyncio.create_task(asyncio.to_thread(_run_job, job))
    return {"job_id": job.id, "status": job.status}


def _as_float(value: Any, default: float | None) -> float | None:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value: Any, default: int) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _run_job(job: _Job) -> None:
    params = job.params
    start_ms = params["start_ms"] or None
    end_ms = params["end_ms"]
    cancel_cb = job.cancel_event.is_set

    try:
        if job.engine == "audio":
            from services.audio_analysis import analyze_audio  # lazy: pulls in numpy
            raw = analyze_audio(
                job.video_path, start_ms, end_ms,
                sensitivity=params["sensitivity"],
                progress_cb=job.set_progress,
                cancel_cb=cancel_cb,
            )
            events = raw.get("events", [])
            job.summary["event_count"] = len(events)
            tempo = raw.get("tempo") or {}
            if tempo.get("bpm"):
                job.summary["bpm"] = round(float(tempo["bpm"]), 1)
                job.summary["tempo_strength"] = tempo.get("strength")
            raw_actions = events_to_actions(events, style=params["style"],
                                            min_pos=params["min_pos"], max_pos=params["max_pos"])
        else:
            from services.motion_analysis import analyze_motion  # lazy: pulls in numpy
            raw = analyze_motion(
                job.video_path, start_ms, end_ms,
                quality=params["quality"],
                crop_vr=params["crop_vr"],
                progress_cb=job.set_progress,
                cancel_cb=cancel_cb,
            )
            job.summary["motion_engine"] = raw.get("engine")
            job.summary["cut_count"] = len(raw.get("cuts", []))
            if raw.get("vr_crop"):
                job.summary["vr_crop"] = True
            if raw.get("engine") == "v2":
                raw_actions = signal_to_actions(raw.get("signal", []),
                                                min_pos=params["min_pos"], max_pos=params["max_pos"])
            else:
                raw_actions = events_to_actions(raw.get("events", []), style=params["style"],
                                                min_pos=params["min_pos"], max_pos=params["max_pos"])

        job.summary["idle_windows"] = len(raw.get("idle_windows", []))
        speed_limit = speed_limit_for(params["device"],
                                      int(params["speed_limit"]) if params["speed_limit"] else None)
        job.summary["speed_limit"] = speed_limit

        script = build_funscript(
            raw_actions,
            start_ms=params["start_ms"],
            end_ms=end_ms,
            min_pos=params["min_pos"],
            max_pos=params["max_pos"],
            min_interval_ms=params["min_interval_ms"],
            speed_limit=speed_limit,
            reduce_tolerance=params["reduce_tolerance"],
            idle_windows=raw.get("idle_windows"),
            inverted=params["inverted"],
        )
        job.script = script
        job.summary["action_count"] = len(script.get("actions", []))
        if not raw_actions:
            # An empty result is a real result, not a success worth saving:
            # the UI needs to say "nothing detected" rather than show a
            # script with no strokes. Emptiness is judged on what the engine
            # detected, not on the final action list — the idle hold parks
            # the device through quiet stretches, which adds keyframes even
            # when nothing was detected.
            job.summary["empty"] = True

        if params["save"] and not job.summary.get("empty"):
            _save(job, script)

        job.set_progress(1.0)
        job.status = "cancelled" if job.cancel_event.is_set() else "done"
    except GenerateError as exc:
        if exc.code == "cancelled":
            job.status = "cancelled"
        else:
            job.error_code = exc.code
            job.error_message = f"{type(exc).__name__}: {exc}"
            job.status = "error"
    except BuildError as exc:
        job.error_code = "badRange"
        job.error_message = f"BuildError: {exc}"
        job.status = "error"
    except Exception as exc:  # never let a worker thread die silently
        job.error_code = "failed"
        job.error_message = f"{type(exc).__name__}: {exc}"
        job.status = "error"
    finally:
        global _active
        with _lock:
            if _active is job:
                _active = None


def _save(job: _Job, script: dict[str, Any]) -> None:
    """Persist to the generated-script store. A store failure does not fail
    the job — the script is already built and the user can still preview or
    export it; the response carries save_error so the UI can say so."""
    try:
        identity = video_identity(job.video_path)
    except (FileNotFoundError, OSError) as exc:
        job.save_error = f"{type(exc).__name__}"
        return
    try:
        actions = script.get("actions", [])
        duration = int(actions[-1]["at"]) if actions else int(job.params.get("end_ms") or 0)
        record = get_store().save(
            engine=job.engine if job.engine != "motion" else f"motion:{job.params.get('quality', 'standard')}",
            video=identity,
            params=job.params,
            script=script,
            duration_ms=duration,
        )
        job.script_id = record["id"]
        job.summary["video_hash"] = record["video_hash"]
        # The file name inside the generated-scripts folder (never a path),
        # so the UI can tell the user which script it just wrote.
        job.summary["filename"] = record["filename"]
    except OSError as exc:
        job.save_error = f"{type(exc).__name__}"


@router.post("/audio")
async def generate_audio(request: Request):
    """Start an audio-driven generation job."""
    return await _start_job("audio", request)


@router.post("/motion")
async def generate_motion(request: Request):
    """Start a video-motion-driven generation job."""
    return await _start_job("motion", request)


@router.get("/store")
async def list_store(video_path: str | None = None):
    """List generated scripts, optionally only those for one video.

    Matching is by the store's (path, size, mtime) hash, which is how the
    renderer auto-loads a generated script when a video has no sidecar.
    """
    store = get_store()
    if video_path:
        try:
            identity = video_identity(video_path)
        except (FileNotFoundError, OSError):
            return {"items": []}
        return {"items": store.list_for_video(identity["video_hash"])}
    return {"items": store.list_all()}


@router.get("/store/{script_id}")
async def get_stored(script_id: str):
    """Fetch one stored script's record and its full funscript."""
    store = get_store()
    record = store.get(script_id)
    if record is None:
        raise HTTPException(status_code=404, detail={"code": "notFound"})
    script = store.get_script(script_id)
    if script is None:
        raise HTTPException(status_code=404, detail={"code": "notFound"})
    return {"record": record, "script": script}


@router.delete("/store/{script_id}")
async def delete_stored(script_id: str):
    """Delete a stored script (used by the generate modal's list)."""
    if not get_store().delete(script_id):
        raise HTTPException(status_code=404, detail={"code": "notFound"})
    return {"ok": True}


SIDECAR_SUFFIX = ".funscript"


def _sidecar_path(video_path: str) -> str:
    """Where a generated script would be exported to: `<video>.funscript` next
    to the video — the same name the desktop library already discovers."""
    base, _ = os.path.splitext(video_path)
    return base + SIDECAR_SUFFIX


@router.post("/store/{script_id}/export")
async def export_stored(script_id: str, request: Request):
    """Write a stored script into the video's folder as a sidecar funscript.

    This is the only route that touches the video's own folder, and the UI
    reaches it only through an explicit button: a generated script must never
    replace a hand-made sidecar on its own. When the file already exists and
    `overwrite` was not sent, the answer is 409 so the UI can ask for
    confirmation before trying again.
    """
    try:
        body = await request.json()
    except (ValueError, AssertionError):
        body = {}  # no body at all: the safe default is "do not overwrite"
    if not isinstance(body, dict):
        body = {}
    overwrite = bool(body.get("overwrite"))

    store = get_store()
    record = store.get(script_id)
    script = store.get_script(script_id) if record else None
    if record is None or script is None:
        raise HTTPException(status_code=404, detail={"code": "notFound"})

    video_path = record.get("video_path") or ""
    if not video_path or not os.path.isfile(video_path):
        raise HTTPException(status_code=404, detail={"code": "noVideo"})

    target = _sidecar_path(video_path)
    existed = os.path.exists(target)
    if existed and not overwrite:
        # Basename only: enough for a confirm dialog, and it keeps the
        # folder out of anything that leaves this process.
        raise HTTPException(status_code=409, detail={
            "code": "exists",
            "filename": os.path.basename(target),
        })

    # Write beside the target and move it into place, so a failed write can
    # never leave a half-written script where the library will pick it up.
    tmp = target + ".funsync-tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(script, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, target)
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"code": "writeFailed"}) from exc
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    return {
        "ok": True,
        "filename": os.path.basename(target),
        "action_count": len(script.get("actions", [])),
        "overwrote": existed,
    }


@router.get("/{job_id}")
async def get_job(job_id: str):
    """Poll a generation job: status, progress, and the script when done."""
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "notFound"})
    return job.to_public()


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str):
    """Cancel a running job. The worker kills its ffmpeg child and discards
    whatever it had analysed so far."""
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "notFound"})
    if job.status in _TERMINAL:
        return job.to_public(include_script=False)
    job.cancel_event.set()
    return job.to_public(include_script=False)
