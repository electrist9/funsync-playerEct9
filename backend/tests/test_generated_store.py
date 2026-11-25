"""Tests for the generated-script store.

What the store owes the user: generated scripts are named after the video
they came from (`<video name>-audio.funscript` / `<video name>-motion.funscript`)
rather than after an opaque hash, one script per video and engine family so
regenerating replaces instead of piling up, and the old hash-named files from
version 1 of the index are thrown away rather than migrated.

The folder the store lives in is the user's choice too (the settings panel
writes `settings.library.generatedStoreDir` into the Electron config), so a
requested folder is checked before anything lands in it and the scripts are
copied — not moved — when it changes.
"""

import json
import os
import uuid

import pytest

from services.generated_store import (
    INDEX_VERSION,
    FileGeneratedScriptStore,
    StoreDirError,
    copy_store_to,
    default_store_root,
    effective_store_dir,
    engine_family,
    generated_filename,
    get_store,
    set_store,
    validate_store_dir,
    video_identity,
)
from services.paths import get_user_data_dir, set_user_data_dir

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


def test_script_path_resolves_a_record_to_its_file(store_dir, video_file):
    """The route hands these to the player, which addresses variations by path."""
    store = FileGeneratedScriptStore(store_dir)
    record = store.save(engine="audio", video=video_identity(video_file), params={}, script=_script(0), duration_ms=1)

    path = store.script_path(record)
    assert path == os.path.join(store_dir, "clip-audio.funscript")
    assert os.path.isfile(path)
    # Listed records resolve the same way as the one save() returned.
    assert store.script_path(store.list_all()[0]) == path
    assert store.script_path({}) is None
    assert store.script_path({"filename": ""}) is None


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
    # The path a record resolves to stays inside the store, and is not the
    # file the record tried to point at.
    assert store.script_path({"filename": "../escape.funscript"}) == os.path.join(
        store_dir, "escape.funscript"
    )
    store.delete("abc123")
    assert os.path.isfile(escape)


# -- where the store lives ---------------------------------------------------

@pytest.fixture
def user_data(media_dir):
    """A stand-in Electron userData dir, waiting for a config.json.

    services.paths keeps the value in a module global, so the fixture puts
    back what it found — and clears the memoized store, because a later test
    must not inherit one pointed at a directory pytest has already deleted.
    """
    previous = get_user_data_dir()
    path = os.path.join(media_dir, "user-data-" + uuid.uuid4().hex[:8])
    os.makedirs(path)
    set_user_data_dir(path)
    try:
        yield path
    finally:
        set_user_data_dir(previous)
        set_store(None)


def _choose_folder(user_data, path):
    """Save the setting the way the settings panel does it."""
    with open(os.path.join(user_data, "config.json"), "w", encoding="utf-8") as handle:
        json.dump({"settings": {"library": {"generatedStoreDir": path}}}, handle)


def _save_pair(store, video_file):
    """One audio and one motion script for the same video."""
    audio = store.save(engine="audio", video=video_identity(video_file),
                       params={}, script=_script(0, 1), duration_ms=1000)
    motion = store.save(engine="motion", video=video_identity(video_file),
                        params={}, script=_script(2, 3), duration_ms=1000)
    return audio, motion


def test_the_store_follows_the_folder_from_the_config(user_data, store_dir):
    _choose_folder(user_data, store_dir)
    assert get_store().root_dir == store_dir
    # Same setting, same instance: reading the config again is cheap,
    # rebuilding the store on every request is not.
    assert get_store() is get_store()


def test_a_changed_setting_moves_the_store_without_a_restart(user_data, store_dir, video_file):
    _choose_folder(user_data, store_dir)
    record = get_store().save(engine="audio", video=video_identity(video_file),
                              params={}, script=_script(0, 1), duration_ms=1000)
    assert os.path.isfile(os.path.join(store_dir, "clip-audio.funscript"))

    elsewhere = store_dir + "-elsewhere"
    _choose_folder(user_data, elsewhere)
    assert get_store().root_dir == elsewhere
    # Each folder has its own index.json, so the new one starts empty.
    assert get_store().list_all() == []
    assert get_store().get_script(record["id"]) is None

    _choose_folder(user_data, store_dir)
    assert get_store().get_script(record["id"]) is not None


def test_an_unusable_folder_in_the_config_falls_back_to_the_default(user_data, store_dir):
    blocked = os.path.join(store_dir, "not-a-folder")
    with open(blocked, "w", encoding="utf-8") as handle:
        handle.write("a file where a folder should be")
    _choose_folder(user_data, blocked)

    snapshot = effective_store_dir()
    assert snapshot["configured"] == blocked
    assert snapshot["effective"] == default_store_root()
    assert snapshot["writable"] is True
    # Generation still works; the store just uses the default folder.
    assert get_store().root_dir == default_store_root()


def test_validate_refuses_paths_that_cannot_be_a_folder(store_dir):
    a_file = os.path.join(store_dir, "file.txt")
    with open(a_file, "w", encoding="utf-8") as handle:
        handle.write("x")
    refused = [
        "", "   ",
        "relative/here",            # the store needs an absolute folder
        a_file,                     # a file, not a folder
        os.path.join(store_dir, "st*ars"),   # Windows would reject the write
        os.path.join(store_dir, "trailing."),  # quietly trimmed by Windows
    ]
    for candidate in refused:
        with pytest.raises(StoreDirError) as info:
            validate_store_dir(candidate)
        assert info.value.code == "invalid", candidate


def test_validate_creates_a_folder_that_is_not_there_yet(store_dir):
    wanted = os.path.join(store_dir, "deep", "deeper", "scripts")
    assert validate_store_dir(wanted) == wanted
    assert os.path.isdir(wanted)
    # Second time round it is still fine — the folder already exists.
    assert validate_store_dir(wanted) == wanted


def test_validate_refuses_a_folder_nested_in_the_store(store_dir):
    inner = os.path.join(store_dir, "inside")
    with pytest.raises(StoreDirError) as info:
        validate_store_dir(inner, current_root=store_dir)
    assert info.value.code == "nested"

    # And the other way round: the old store must not end up inside the new
    # folder, or the same scripts would be listed from both roots.
    os.makedirs(inner, exist_ok=True)
    with pytest.raises(StoreDirError) as info:
        validate_store_dir(store_dir, current_root=inner)
    assert info.value.code == "nested"

    # The same folder written differently is not nesting; it is the no-op the
    # caller reports as "already there".
    assert validate_store_dir(store_dir + os.sep + ".", current_root=store_dir) == store_dir


def test_validate_refuses_a_folder_that_cannot_be_written(store_dir):
    a_file = os.path.join(store_dir, "file.txt")
    with open(a_file, "w", encoding="utf-8") as handle:
        handle.write("x")
    with pytest.raises(StoreDirError) as info:
        validate_store_dir(os.path.join(a_file, "child"))
    assert info.value.code == "notWritable"


def test_copying_the_store_leaves_the_old_folder_where_it_is(store_dir, video_file):
    audio, motion = _save_pair(FileGeneratedScriptStore(store_dir), video_file)
    target = store_dir + "-copy"

    assert copy_store_to(target, source_root=store_dir) == {"copied": 2, "skipped": 0}

    fresh = FileGeneratedScriptStore(target)
    assert sorted(entry["id"] for entry in fresh.list_all()) == sorted([audio["id"], motion["id"]])
    for record in (audio, motion):
        path = fresh.script_path(record)
        assert os.path.isfile(path)
        # Same name as before: a file name comes from the video, not from
        # which folder the store happens to use.
        assert os.path.basename(path) == record["filename"]
    # Nothing was deleted, so pointing the setting back at the old folder
    # brings those scripts right back.
    assert os.path.isfile(os.path.join(store_dir, "clip-audio.funscript"))
    assert len(FileGeneratedScriptStore(store_dir).list_all()) == 2


def test_repeating_the_copy_does_not_double_up(store_dir, video_file):
    _save_pair(FileGeneratedScriptStore(store_dir), video_file)
    target = store_dir + "-copy"
    copy_store_to(target, source_root=store_dir)

    assert copy_store_to(target, source_root=store_dir) == {"copied": 0, "skipped": 2}
    assert len(FileGeneratedScriptStore(target).list_all()) == 2


def test_a_copy_the_new_folder_already_has_keeps_its_own(store_dir, video_file):
    source = FileGeneratedScriptStore(store_dir)
    _save_pair(source, video_file)

    target_dir = store_dir + "-copy"
    target = FileGeneratedScriptStore(target_dir)
    kept = target.save(engine="audio", video=video_identity(video_file),
                       params={}, script=_script(9, 9), duration_ms=1)

    # The audio pair is already there and wins; motion has nothing to clash
    # with and comes over.
    assert copy_store_to(target_dir, source_root=store_dir) == {"copied": 1, "skipped": 1}
    assert target.get(kept["id"]) is not None
    assert target.get_script(kept["id"])["actions"][0]["pos"] == 9


def test_a_record_whose_file_has_gone_is_left_behind(store_dir, video_file):
    _, motion = _save_pair(FileGeneratedScriptStore(store_dir), video_file)
    os.remove(os.path.join(store_dir, motion["filename"]))
    target = store_dir + "-copy"

    assert copy_store_to(target, source_root=store_dir) == {"copied": 1, "skipped": 1}
    assert len(FileGeneratedScriptStore(target).list_all()) == 1
