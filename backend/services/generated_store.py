"""Storage area for funscripts produced by the generation engines.

The user asked for a dedicated place to keep generated scripts, separate
from sidecar `.funscript` files next to the video: a generated script is
an experiment, and overwriting a hand-made sidecar with one is the worst
possible failure mode. So generation writes here, and exporting to a
sidecar is an explicit, separate action from the UI.

Layout (provisional — the exact UX is still being specified, which is why
everything goes through this interface rather than through paths):

    <userData>/generated-scripts/
        index.json                 # catalogue of everything stored
        <id>.funscript             # one JSON funscript per generation

`index.json` entries carry the video identity (path + the same
path/size/mtime hash the thumbnail cache uses), the engine that produced
the script, the parameters it was made with, and the time range it
covers. That is what lets the player offer "load the generated version"
for a video that has no sidecar, and what lets the UI show *why* a script
exists and regenerate it with different settings.

Fallback: when the backend runs without --user-data-dir (dev, tests) the
store lives in the OS temp dir next to the thumbnail cache, mirroring
services/ffmpeg.py's behaviour.

Thread-safety: FastAPI runs sync handlers in a threadpool, so the index
is guarded by a lock and written atomically (tmp + os.replace).
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
from typing import Any

from services.paths import get_user_data_dir

INDEX_VERSION = 1
STORE_DIR_NAME = "generated-scripts"


def video_identity(video_path: str) -> dict[str, Any]:
    """Stable identity for a video file: the same (path, size, mtime) key the
    thumbnail/metadata caches use, so a moved or edited file stops matching.

    Returns {"video_path", "video_hash", "size", "mtime"}. Raises
    FileNotFoundError for a missing file (the caller turns that into a 404).
    """
    stat = os.stat(video_path)
    key = f"{video_path}:{stat.st_size}:{stat.st_mtime}"
    return {
        "video_path": video_path,
        "video_hash": hashlib.md5(key.encode()).hexdigest()[:12],
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }


class GeneratedScriptStore:
    """Interface the rest of the backend talks to.

    Implementations must be safe to call from any thread.
    """

    def save(self, *, engine: str, video: dict[str, Any], params: dict[str, Any],
             script: dict[str, Any], duration_ms: float) -> dict[str, Any]:
        """Persist a generated script; returns the stored record (with `id`)."""
        raise NotImplementedError

    def get(self, script_id: str) -> dict[str, Any] | None:
        """The record for an id, or None."""
        raise NotImplementedError

    def get_script(self, script_id: str) -> dict[str, Any] | None:
        """The funscript document for an id, or None."""
        raise NotImplementedError

    def list_for_video(self, video_hash: str) -> list[dict[str, Any]]:
        """Records for a video, newest first."""
        raise NotImplementedError

    def list_all(self) -> list[dict[str, Any]]:
        """Every record, newest first."""
        raise NotImplementedError

    def delete(self, script_id: str) -> bool:
        """Remove a record and its file. True if it existed."""
        raise NotImplementedError


class FileGeneratedScriptStore(GeneratedScriptStore):
    """JSON-on-disk store. One file per script plus an index."""

    def __init__(self, root_dir: str):
        self.root_dir = root_dir
        self._lock = threading.Lock()

    # -- paths ---------------------------------------------------------------

    def _index_path(self) -> str:
        return os.path.join(self.root_dir, "index.json")

    def _script_path(self, script_id: str) -> str:
        # ids are generated here (hex), but guard anyway: this path is built
        # from a URL parameter.
        safe = "".join(ch for ch in str(script_id) if ch.isalnum() or ch in "-_")
        if not safe:
            raise ValueError("Invalid script id")
        return os.path.join(self.root_dir, f"{safe}.funscript")

    def _ensure_dir(self) -> None:
        os.makedirs(self.root_dir, exist_ok=True)

    # -- index ---------------------------------------------------------------

    def _read_index_locked(self) -> list[dict[str, Any]]:
        try:
            with open(self._index_path(), encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError, ValueError):
            return []
        if isinstance(payload, dict) and payload.get("version") == INDEX_VERSION:
            entries = payload.get("entries")
            if isinstance(entries, list):
                return [e for e in entries if isinstance(e, dict) and e.get("id")]
        return []

    def _write_index_locked(self, entries: list[dict[str, Any]]) -> None:
        self._ensure_dir()
        payload = {"version": INDEX_VERSION, "entries": entries}
        tmp = self._index_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self._index_path())

    # -- api -----------------------------------------------------------------

    def save(self, *, engine: str, video: dict[str, Any], params: dict[str, Any],
             script: dict[str, Any], duration_ms: float) -> dict[str, Any]:
        self._ensure_dir()
        created_at = time.time()
        seed = f"{video.get('video_hash')}:{engine}:{created_at}:{os.getpid()}"
        script_id = hashlib.md5(seed.encode()).hexdigest()[:12]

        actions = script.get("actions", [])
        record = {
            "id": script_id,
            "engine": engine,
            "video_path": video.get("video_path"),
            "video_hash": video.get("video_hash"),
            "params": params,
            "created_at": created_at,
            "duration_ms": int(round(duration_ms)),
            "action_count": len(actions),
            "range": [
                actions[0]["at"] if actions else 0,
                actions[-1]["at"] if actions else 0,
            ],
        }
        with self._lock:
            with open(self._script_path(script_id), "w", encoding="utf-8") as f:
                json.dump(script, f, ensure_ascii=False)
            entries = self._read_index_locked()
            entries.append(record)
            self._write_index_locked(entries)
        return record

    def get(self, script_id: str) -> dict[str, Any] | None:
        with self._lock:
            for entry in self._read_index_locked():
                if entry.get("id") == script_id:
                    return entry
        return None

    def get_script(self, script_id: str) -> dict[str, Any] | None:
        try:
            path = self._script_path(script_id)
        except ValueError:
            return None
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError, ValueError):
            return None

    def list_for_video(self, video_hash: str) -> list[dict[str, Any]]:
        with self._lock:
            entries = [e for e in self._read_index_locked() if e.get("video_hash") == video_hash]
        return sorted(entries, key=lambda e: e.get("created_at", 0), reverse=True)

    def list_all(self) -> list[dict[str, Any]]:
        with self._lock:
            entries = self._read_index_locked()
        return sorted(entries, key=lambda e: e.get("created_at", 0), reverse=True)

    def delete(self, script_id: str) -> bool:
        with self._lock:
            entries = self._read_index_locked()
            remaining = [e for e in entries if e.get("id") != script_id]
            if len(remaining) == len(entries):
                return False
            self._write_index_locked(remaining)
            try:
                os.remove(self._script_path(script_id))
            except OSError:
                pass
        return True


_store: GeneratedScriptStore | None = None
_store_lock = threading.Lock()


def get_store() -> GeneratedScriptStore:
    """The process-wide store, rooted at <userData>/generated-scripts (or the
    temp dir when no userData dir was configured)."""
    global _store
    with _store_lock:
        if _store is None:
            user_data = get_user_data_dir()
            root = (os.path.join(user_data, STORE_DIR_NAME)
                    if user_data else os.path.join(tempfile.gettempdir(), "funsync_thumbs", STORE_DIR_NAME))
            _store = FileGeneratedScriptStore(root)
        return _store


def set_store(store: GeneratedScriptStore | None) -> None:
    """Test seam: swap in (or clear) the store."""
    global _store
    with _store_lock:
        _store = store
