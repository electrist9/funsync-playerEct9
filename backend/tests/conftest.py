"""Shared fixtures for the backend test suite.

The sandbox this suite runs under lets child processes (ffmpeg) write inside
the project workspace but not under the system temp directory, and pytest's
own basetemp is not listable there either. Media fixtures therefore live in a
scratch directory under the workspace root, created and removed by the
fixture itself. Override the location with FUNSYNC_TEST_TMP when running the
suite from somewhere else.
"""

import os
import shutil
import uuid

import pytest

# tests -> backend -> funsync-player -> workspace root
_WORKSPACE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
_SCRATCH_ROOT = os.environ.get("FUNSYNC_TEST_TMP") or os.path.join(
    _WORKSPACE, "tmp-pytest-media"
)


@pytest.fixture(scope="session")
def media_dir():
    """A scratch directory for media built by the fixtures below.

    Lives under the workspace so ffmpeg (a child process) can write into it;
    the system temp directory is off-limits to child processes under the
    sandbox, and pytest's tmp_path machinery cannot be re-listed there.

    The unique name is made with os.makedirs, not tempfile.mkdtemp: on
    Windows mkdtemp creates a directory whose ACL the sandbox does not carry
    over to child processes, so ffmpeg fails to open its output file.
    """
    path = os.path.join(_SCRATCH_ROOT, "media-" + uuid.uuid4().hex[:8])
    os.makedirs(path)
    yield path
    shutil.rmtree(path, ignore_errors=True)
