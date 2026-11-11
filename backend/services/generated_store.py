"""Storage area for funscripts produced by the generation engines.

The user asked for a dedicated place to keep generated scripts, separate
from sidecar `.funscript` files next to the video: a generated script is
an experiment, and overwriting a hand-made sidecar with one is the worst
possible failure mode. So generation writes here, and exporting to a
sidecar is an explicit, separate action from the UI.

Layout:

    <userData>/generated-scripts/
        index.json                        # catalogue of everything stored
        <video name>-audio.funscript      # audio-driven generation
        <video name>-motion.funscript     # picture-motion generation

File names come from the video file's base name plus the engine family, so
the folder stays readable and one video keeps at most one generated script
per engine: regenerating replaces that file instead of piling up
hash-named ones. The UI asks before a regeneration replaces an existing
script. `id` stays an opaque hash and is what the API addresses records
with — file names are for humans, and two videos sharing a base name in
different folders are told apart by a short hash suffix on the file.

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

# Version 2 added the per-record `filename` and switched the files on disk
# from `<id>.funscript` to `<video name>-<engine>.funscript`. Version 1
# stores are discarded rather than migrated: the generated scripts are
# reproducible experiments, and the user asked for a clean start.
INDEX_VERSION = 2
STORE_DIR_NAME = "generated-scripts"
SCRIPT_SUFFIX = ".funscript"

# Engine families a generated file can be named after. The engine name in a
# record carries a variant (`motion:high`); the file name does not.
ENGINE_FAMILIES = ("audio", "motion")

# Characters a Windows file name cannot contain, plus control characters.
ILLEGAL_NAME_CHARS = set('\\/:*?"<>|')
MAX_STEM_LENGTH = 120


def engine_family(engine: str) -> str:
    """`audio` / `motion` for an engine name, whatever variant it carries.

    Returns "" for anything else, so a record written by another version
    simply never matches instead of raising inside the store.
    """
    family = str(engine or "").split(":", 1)[0].strip().lower()
    return family if family in ENGINE_FAMILIES else ""


def _safe_stem(base: str) -> str:
    """Turn a video's base name into something usable as a file stem."""
    cleaned = "".join(
        "-" if ch in ILLEGAL_NAME_CHARS or ord(ch) < 32 else ch for ch in str(base)
    ).strip(" .")
    if not cleaned:
        cleaned = "video"
    if len(cleaned) > MAX_STEM_LENGTH:
        # Long names would push the path past the Windows limit; keep a hash
        # of the full name so two long-but-different names stay distinct.
        digest = hashlib.md5(cleaned.encode()).hexdigest()[:8]
        cleaned = f"{cleaned[:MAX_STEM_LENGTH - 9].strip(' .')}-{digest}"
    return cleaned


def generated_filename(video_path: str, engine: str) -> str:
    """File name for a generated script: `<video name>-audio.funscript` or
    `<video name>-motion.funscript`.

    Only the base name of the video is used — the store never mirrors the
    video's folder structure.
    """
    base = os.path.splitext(os.path.basename(str(video_path or "")))[0]
    family = engine_family(engine)
    if not family:
        raise ValueError(f"Unknown generation engine: {engine!r}")
    return f"{_safe_stem(base)}-{family}{SCRIPT_SUFFIX}"


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
        """Persist a generated script; returns the stored record (with `id`).

        One script per (video, engine family): any previous one is replaced,
        its file removed with it.
        """
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
        self._legacy_swept = False

    # -- paths ---------------------------------------------------------------

    def _index_path(self) -> str:
        return os.path.join(self.root_dir, "index.json")

    def _script_path(self, filename: str) -> str:
        # File names come from the index, which we wrote, but they are built
        # from a user's video name: keep them inside the store directory.
        safe = os.path.basename(str(filename).strip())
        safe = "".join(
            "-" if ch in ILLEGAL_NAME_CHARS or ord(ch) < 32 else ch for ch in safe
        )
        if not safe.strip(" .") or not safe.endswith(SCRIPT_SUFFIX):
            raise ValueError("Invalid script file name")
        return os.path.join(self.root_dir, safe)

    def _ensure_dir(self) -> None:
        os.makedirs(self.root_dir, exist_ok=True)

    # -- index ---------------------------------------------------------------

    def _read_index_locked(self) -> list[dict[str, Any]]:
        try:
            with open(self._index_path(), encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError, ValueError):
            return []
        if not isinstance(payload, dict):
            return []
        entries = payload.get("entries")
        entries = (
            [e for e in entries if isinstance(e, dict) and e.get("id")]
            if isinstance(entries, list) else []
        )
        if payload.get("version") == INDEX_VERSION:
            return [e for e in entries if e.get("filename")]
        # Older index (version 1) named files after the record id. Those
        # scripts are thrown away, not migrated — see the module docstring.
        if not self._legacy_swept:
            self._legacy_swept = True
            for entry in entries:
                self._remove_file_locked(entry)
        return []

    def _remove_file_locked(self, entry: dict[str, Any]) -> None:
        """Best-effort delete of the file an entry points at."""
        name = entry.get("filename") or f"{entry.get('id')}{SCRIPT_SUFFIX}"
        try:
            os.remove(self._script_path(name))
        except (OSError, ValueError):
            pass

    def _unique_filename_locked(self, entries: list[dict[str, Any]], filename: str,
                                video_hash: Any) -> str:
        """A file name no other record is using.

        Two videos with the same base name in different folders would want
        the same generated file, so the second one is tagged with its video
        identity hash and a counter covers the (rare) clash after that.
        """
        taken = {e.get("filename") for e in entries}
        if filename not in taken:
            return filename
        stem = filename[: -len(SCRIPT_SUFFIX)]
        tagged = f"{stem}-{str(video_hash or '')[:6]}{SCRIPT_SUFFIX}"
        if tagged not in taken:
            return tagged
        counter = 2
        while f"{stem}-{counter}{SCRIPT_SUFFIX}" in taken:
            counter += 1
        return f"{stem}-{counter}{SCRIPT_SUFFIX}"

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
        family = engine_family(engine)
        video_hash = video.get("video_hash")

        actions = script.get("actions", [])
        record = {
            "id": script_id,
            "engine": engine,
            "filename": "",
            "video_path": video.get("video_path"),
            "video_hash": video_hash,
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
            entries = self._read_index_locked()
            # One script per (video, engine family): the new one replaces the
            # previous one, including its file on disk.
            stale = [
                e for e in entries
                if e.get("video_hash") == video_hash and engine_family(e.get("engine")) == family
            ]
            for entry in stale:
                entries.remove(entry)
            filename = self._unique_filename_locked(
                entries, generated_filename(video.get("video_path"), engine), video_hash,
            )
            record["filename"] = filename
            for entry in stale:
                self._remove_file_locked(entry)
            with open(self._script_path(filename), "w", encoding="utf-8") as f:
                json.dump(script, f, ensure_ascii=False)
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
        with self._lock:
            record = next(
                (e for e in self._read_index_locked() if e.get("id") == script_id), None
            )
            if record is None:
                return None
            try:
                path = self._script_path(record["filename"])
            except (ValueError, KeyError, TypeError):
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
            removed = [e for e in entries if e.get("id") == script_id]
            if not removed:
                return False
            self._write_index_locked(remaining)
            for entry in removed:
                self._remove_file_locked(entry)
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
