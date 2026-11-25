"""Storage area for funscripts produced by the generation engines.

The user asked for a dedicated place to keep generated scripts, separate
from sidecar `.funscript` files next to the video: a generated script is
an experiment, and overwriting a hand-made sidecar with one is the worst
possible failure mode. So generation writes here, and exporting to a
sidecar is an explicit, separate action from the UI.

Layout (default folder; the user can point the store at another folder in
the settings panel, which is stored as `settings.library.generatedStoreDir`
in the Electron config file — see `_configured_store_dir` below):

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
import logging
import os
import shutil
import tempfile
import threading
import time
from typing import Any

from services.paths import get_user_data_dir

log = logging.getLogger("funsync.generate")

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

# Characters a Windows *path* cannot contain. Unlike a file name, the
# separators and a drive colon are legal here, so this set is smaller.
ILLEGAL_PATH_CHARS = set('*?"<>|')

# Electron owns the config file and the backend only ever reads it (exactly
# like routes/locale.py reads `settings.player`). The folder the user picked
# for generated scripts lives at `settings.library.generatedStoreDir`; an
# empty or missing value means "use the default folder".
CONFIG_FILE_NAME = "config.json"
CONFIG_SETTING_PATH = ("settings", "library", "generatedStoreDir")

WRITE_PROBE_NAME = ".funsync-probe.tmp"


class StoreDirError(ValueError):
    """A requested store folder was refused.

    `code` is what the API turns into a client-visible reason:
    "invalid" (not a usable absolute path), "nested" (one folder inside the
    other), "notWritable" (could not be created or written to).
    """

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# -- where the store lives ---------------------------------------------------

def default_store_root() -> str:
    """`<userData>/generated-scripts`, or the temp dir without --user-data-dir."""
    user_data = get_user_data_dir()
    if user_data:
        return os.path.join(user_data, STORE_DIR_NAME)
    return os.path.join(tempfile.gettempdir(), "funsync_thumbs", STORE_DIR_NAME)


def _configured_store_dir() -> str | None:
    """The folder from the Electron config, or None when unset.

    Read per call, like routes/locale.py does: the setting can change while
    the backend runs, and the file is tiny. Any problem reading it means
    "no setting" — a broken config file must never break generation. The
    path itself is not logged (this module's privacy rule).
    """
    user_data = get_user_data_dir()
    if not user_data:
        return None
    try:
        with open(os.path.join(user_data, CONFIG_FILE_NAME), encoding="utf-8") as f:
            payload = json.load(f)
        value: Any = payload
        for key in CONFIG_SETTING_PATH:
            if not isinstance(value, dict):
                return None
            value = value.get(key)
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(value, str):
        return None
    return value.strip() or None


def same_store_dir(left: str, right: str) -> bool:
    """Compare two store folders the way Windows would see them."""
    return os.path.normcase(os.path.normpath(str(left))) == os.path.normcase(
        os.path.normpath(str(right))
    )


def _nested_under(inner: str, outer: str) -> bool:
    """True when `inner` is inside `outer` (not equal to it)."""
    try:
        return os.path.commonpath([inner, outer]) == os.path.normpath(outer)
    except ValueError:  # different drives, or a mix of absolute and relative
        return False


def _is_writable(directory: str) -> bool:
    """Can a file be written in `directory`? Creates it if needed."""
    probe = os.path.join(directory, WRITE_PROBE_NAME)
    try:
        os.makedirs(directory, exist_ok=True)
        with open(probe, "wb") as f:
            f.write(b"ok")
    except OSError:
        return False
    try:
        os.remove(probe)
    except OSError:
        pass
    return True


def validate_store_dir(path: str, *, current_root: str | None = None) -> str:
    """Normalize a requested store folder, or raise StoreDirError.

    The chosen folder *is* the store root: `index.json` and the generated
    `.funscript` files land directly in it, so it has to exist (or be
    creatable) and be writable. It may not be the current root's own
    subtree — two stores nested in each other would show the same scripts
    twice.
    """
    raw = str(path or "").strip().strip('"')
    if not raw or any(ord(ch) < 32 for ch in raw) or any(ch in ILLEGAL_PATH_CHARS for ch in raw):
        raise StoreDirError("invalid")
    normalized = os.path.normpath(raw)
    if not os.path.isabs(normalized):
        raise StoreDirError("invalid")
    # Windows silently trims trailing dots and spaces, which would leave the
    # setting pointing at a folder that is not quite the one it names.
    for part in os.path.splitdrive(normalized)[1].split(os.sep):
        if part and (part[-1] in " ."):
            raise StoreDirError("invalid")
    if os.path.exists(normalized) and not os.path.isdir(normalized):
        raise StoreDirError("invalid")
    if current_root and same_store_dir(normalized, current_root):
        # Not an error: the caller reports "nothing to do".
        return normalized
    if current_root and (_nested_under(normalized, current_root)
                         or _nested_under(current_root, normalized)):
        raise StoreDirError("nested")
    try:
        os.makedirs(normalized, exist_ok=True)
    except OSError as exc:
        raise StoreDirError("notWritable") from exc
    if not _is_writable(normalized):
        raise StoreDirError("notWritable")
    return normalized


def _resolve_store_root() -> str:
    """The folder the store should use right now: setting, default, or temp."""
    configured = _configured_store_dir()
    if configured:
        try:
            return validate_store_dir(configured)
        except StoreDirError as exc:
            log.warning("configured generated-script folder is unusable (%s); "
                        "using the default folder", exc.code)
    return default_store_root()


def effective_store_dir() -> dict[str, Any]:
    """Snapshot of where the store is, for the settings panel to show."""
    default_root = default_store_root()
    configured = _configured_store_dir()
    effective = default_root
    if configured:
        try:
            effective = validate_store_dir(configured)
        except StoreDirError:
            effective = default_root
    return {
        "configured": configured,
        "effective": effective,
        "default": default_root,
        "writable": _is_writable(effective),
    }


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

    def script_path(self, record: dict[str, Any]) -> str | None:
        """Absolute path of a record's file, or None when this store keeps its
        scripts somewhere a path cannot address.

        The index itself only ever holds the file name — the folder is
        whatever root the store was built for (the default under
        `--user-data-dir`, or the folder the user chose), so only the store
        knows where a record is. Callers that hand the path to someone else
        must check the file still exists.
        """
        return None


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

    def script_path(self, record: dict[str, Any]) -> str | None:
        """Absolute path of a record's file, or None if the record's file name
        cannot be resolved (a hand-edited index, say). No existence check —
        `get_script` reads through the same path."""
        try:
            return self._script_path(record["filename"])
        except (ValueError, KeyError, TypeError):
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
_store_root: str | None = None
_store_pinned = False
_store_lock = threading.Lock()


def get_store() -> GeneratedScriptStore:
    """The process-wide store, rooted at the folder in use right now.

    Default is `<userData>/generated-scripts` (or the temp dir when no
    --user-data-dir was given); the user can point it somewhere else from
    the settings panel. The folder is re-checked on every call so a change
    applies without restarting the backend, and the instance is only reused
    while the folder has not moved.
    """
    global _store, _store_root
    if _store_pinned:
        with _store_lock:
            if _store is not None:
                return _store
    root = _resolve_store_root()
    with _store_lock:
        if _store is None or _store_root != root:
            _store = FileGeneratedScriptStore(root)
            _store_root = root
        return _store


def set_store(store: GeneratedScriptStore | None) -> None:
    """Test seam: swap in (or clear) the store.

    An injected store is pinned, so `get_store()` hands it back untouched
    instead of re-rooting it at the configured folder.
    """
    global _store, _store_pinned
    with _store_lock:
        _store = store
        _store_pinned = store is not None


def copy_store_to(new_root: str, source_root: str | None = None) -> dict[str, int]:
    """Copy the stored scripts into `new_root`, leaving the old folder alone.

    Chosen over moving them: the user asked for the old copies to stay where
    they are, and pointing the setting back at the old folder then brings
    those scripts right back. The new folder keeps its own `index.json`, so
    `script_path()` and the variant listing simply start addressing the new
    copies.

    An entry whose file is gone is skipped, and so is one the new folder
    already holds — the same (video, engine family) pair there wins, which
    makes repeating the call harmless instead of piling up duplicates.
    Returns {"copied": n, "skipped": m}.
    """
    source = FileGeneratedScriptStore(source_root if source_root is not None
                                      else getattr(get_store(), "root_dir",
                                                   default_store_root()))
    target = FileGeneratedScriptStore(new_root)
    with source._lock:
        entries = source._read_index_locked()
    target._ensure_dir()
    copied = 0
    skipped = 0
    with target._lock:
        fresh = target._read_index_locked()
        taken_ids = {e.get("id") for e in fresh}
        taken_pairs = {(e.get("video_hash"), engine_family(e.get("engine"))) for e in fresh}
        for entry in entries:
            pair = (entry.get("video_hash"), engine_family(entry.get("engine")))
            if entry.get("id") in taken_ids or pair in taken_pairs:
                skipped += 1
                continue
            try:
                origin = source._script_path(entry.get("filename") or "")
            except ValueError:
                skipped += 1
                continue
            if not os.path.isfile(origin):
                skipped += 1
                continue
            filename = target._unique_filename_locked(
                fresh, os.path.basename(origin), entry.get("video_hash")
            )
            try:
                shutil.copy2(origin, target._script_path(filename))
            except OSError:
                skipped += 1
                continue
            record = dict(entry)
            record["filename"] = filename
            fresh.append(record)
            taken_ids.add(record.get("id"))
            taken_pairs.add(pair)
            copied += 1
        if copied:
            target._write_index_locked(fresh)
    return {"copied": copied, "skipped": skipped}
