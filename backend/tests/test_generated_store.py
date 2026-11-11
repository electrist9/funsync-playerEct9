"""Tests for the generated-script store.

What the store owes the user: generated scripts are named after the video
they came from (`<video name>-audio.funscript` / `<video name>-motion.funscript`)
rather than after an opaque hash, one script per video and engine family so
regenerating replaces instead of piling up, and the old hash-named files from
version 1 of the index are thrown away rather than migrated.
"""

import json
import os
import uuid

import pytest

from services.generated_store import (
    INDEX_VERSION,
    FileGeneratedScriptStore,
    engine_family,
    generated_filename,
    video_identity,
)

SCRIPT_SUFFIX = ".funscript"


def _script(*positions):
    """A minimal funscript document with one action per position."""
    return {
        "version": 1,
        "actions": [
            {"at": index * 500, "pos": position}
            for index, position in enumerate(positions)
        ],
    }


@pytest.fixture
def store_dir(media_dir):
    """An empty store directory, unique per test."""
    path = os.path.join(media_dir, "store-" + uuid.uuid4().hex[:8])
    os.makedirs(path)
    return path


@pytest.fixture
def video_file(media_dir):
    """A real file on disk: the store hashes (path, size, mtime) to identify it."""
    path = os.path.join(media_dir, "clip.mp4")
    with open(path, "wb") as handle:
        handle.write(b"not really a video")
    return path


def _make_video(media_dir, name):
    path = os.path.join(media_dir, name)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(b"0123456789")
    return path


# -- naming -------------------------------------------------------------------

def test_engine_family_collapses_the_variant():
    assert engine_family("audio") == "audio"
    assert engine_family("motion:standard") == "motion"
    assert engine_family("MOTION:high") == "motion"
    assert engine_family("telekinesis") == ""
    assert engine_family("") == ""


def test_generated_filename_uses_the_video_base_name():
    assert generated_filename("/media/My Video.mp4", "audio") == "My Video-audio.funscript"
    assert generated_filename("/media/My Video.mkv", "motion:high") == "My Video-motion.funscript"


def test_generated_filename_ignores_the_video_folder():
    assert generated_filename("/deep/nested/folders/clip.mp4", "audio") == "clip-audio.funscript"


def test_generated_filename_rejects_an_unknown_engine():
    with pytest.raises(ValueError):
        generated_filename("/media/clip.mp4", "vibes")


def test_generated_filename_sanitises_characters_windows_refuses():
    # Every illegal character becomes a dash, so a name full of them reads as
    # dashes — never a path separator or a Windows-reserved character.
    assert generated_filename("/media/b:c*d?.mp4", "audio") == "b-c-d--audio.funscript"
    assert generated_filename("/media/a\x01b.mp4", "audio") == "a-b-audio.funscript"
    assert "\\" not in generated_filename("C:\\media\\clip.mp4", "audio")


def test_generated_filename_falls_back_when_nothing_is_left():
    assert generated_filename("", "audio") == "video-audio.funscript"
    assert generated_filename("/media/...", "motion") == "video-motion.funscript"


def test_generated_filename_keeps_long_names_within_the_limit():
    filename = generated_filename("/media/" + "x" * 300 + ".mp4", "audio")
    stem = filename[: -len("-audio" + SCRIPT_SUFFIX)]
    assert len(stem) == 120
    assert stem.startswith("x" * 20)
    # Two different over-long names must not collapse onto one file.
    other = generated_filename("/media/" + "y" * 300 + ".mp4", "audio")
    assert other != filename


# -- the store on disk --------------------------------------------------------

def test_save_names_the_file_after_the_video(store_dir, video_file):
    store = FileGeneratedScriptStore(store_dir)
    record = store.save(
        engine="audio", video=video_identity(video_file),
        params={"sensitivity": 0.2}, script=_script(0, 1), duration_ms=1000,
    )

    assert record["filename"] == "clip-audio.funscript"
    path = os.path.join(store_dir, "clip-audio.funscript")
    assert os.path.isfile(path)
    with open(path, encoding="utf-8") as handle:
        assert json.load(handle)["actions"] == _script(0, 1)["actions"]
    assert store.get_script(record["id"])["actions"] == _script(0, 1)["actions"]
    listed = store.list_for_video(record["video_hash"])
    assert [item["filename"] for item in listed] == ["clip-audio.funscript"]


def test_audio_and_motion_are_kept_apart(store_dir, video_file):
    store = FileGeneratedScriptStore(store_dir)
    identity = video_identity(video_file)
    audio = store.save(engine="audio", video=identity, params={}, script=_script(0, 1), duration_ms=1)
    motion = store.save(engine="motion:standard", video=identity, params={}, script=_script(1, 0), duration_ms=1)

    assert audio["filename"] == "clip-audio.funscript"
    assert motion["filename"] == "clip-motion.funscript"
    assert sorted(os.listdir(store_dir)) == [
        "clip-audio.funscript", "clip-motion.funscript", "index.json",
    ]


def test_regenerating_replaces_the_previous_script(store_dir, video_file):
    store = FileGeneratedScriptStore(store_dir)
    identity = video_identity(video_file)
    first = store.save(engine="audio", video=identity, params={}, script=_script(0, 1), duration_ms=1)
    second = store.save(engine="audio", video=identity, params={}, script=_script(1, 0, 1), duration_ms=2)

    assert first["id"] != second["id"]
    assert first["filename"] == second["filename"] == "clip-audio.funscript"
    assert store.get(first["id"]) is None
    assert store.get_script(first["id"]) is None
    assert store.delete(first["id"]) is False
    assert len(store.list_for_video(identity["video_hash"])) == 1
    assert os.listdir(store_dir) == ["clip-audio.funscript", "index.json"]
    assert store.get_script(second["id"])["actions"] == _script(1, 0, 1)["actions"]


def test_videos_sharing_a_base_name_get_distinct_files(store_dir, media_dir):
    one = _make_video(media_dir, os.path.join("folder-a", "clip.mp4"))
    two = _make_video(media_dir, os.path.join("folder-b", "clip.mp4"))
    store = FileGeneratedScriptStore(store_dir)

    first = store.save(engine="audio", video=video_identity(one), params={}, script=_script(0), duration_ms=1)
    assert first["filename"] == "clip-audio.funscript"

    second = store.save(engine="audio", video=video_identity(two), params={}, script=_script(1), duration_ms=1)
    tag = video_identity(two)["video_hash"][:6]
    assert second["filename"] == f"clip-audio-{tag}.funscript"
    assert os.path.isfile(os.path.join(store_dir, second["filename"]))
    assert len(store.list_all()) == 2

    # The first video regenerating still owns the plain name.
    third = store.save(engine="audio", video=video_identity(one), params={}, script=_script(1, 0), duration_ms=1)
    assert third["filename"] == "clip-audio.funscript"
    assert len(store.list_all()) == 2


def test_delete_removes_the_record_and_its_file(store_dir, video_file):
    store = FileGeneratedScriptStore(store_dir)
    record = store.save(engine="audio", video=video_identity(video_file), params={}, script=_script(0), duration_ms=1)

    assert store.delete(record["id"]) is True
    assert store.delete(record["id"]) is False
    assert store.list_all() == []
    assert os.listdir(store_dir) == ["index.json"]


# -- index versions and hostile file names ------------------------------------

def test_legacy_hash_named_scripts_are_discarded(store_dir, video_file):
    legacy_id = "0" * 12
    with open(os.path.join(store_dir, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {"version": 1, "entries": [{"id": legacy_id, "engine": "audio", "video_hash": "abc"}]},
            handle,
        )
    legacy_file = os.path.join(store_dir, f"{legacy_id}{SCRIPT_SUFFIX}")
    with open(legacy_file, "w", encoding="utf-8") as handle:
        json.dump({"actions": []}, handle)

    store = FileGeneratedScriptStore(store_dir)
    assert store.list_all() == []
    assert store.get(legacy_id) is None
    assert not os.path.exists(legacy_file)

    # The first new write replaces the old index outright.
    record = store.save(engine="audio", video=video_identity(video_file), params={}, script=_script(0), duration_ms=1)
    assert record["filename"] == "clip-audio.funscript"
    with open(os.path.join(store_dir, "index.json"), encoding="utf-8") as handle:
        assert json.load(handle)["version"] == INDEX_VERSION


def test_a_record_cannot_point_outside_the_store(store_dir, media_dir):
    escape = os.path.join(media_dir, "escape.funscript")
    with open(escape, "w", encoding="utf-8") as handle:
        json.dump({"actions": []}, handle)
    store = FileGeneratedScriptStore(store_dir)
    with open(os.path.join(store_dir, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {"version": INDEX_VERSION, "entries": [
                {"id": "abc123", "engine": "audio", "filename": "../escape.funscript"},
            ]},
            handle,
        )

    assert store.get_script("abc123") is None
    store.delete("abc123")
    assert os.path.isfile(escape)
