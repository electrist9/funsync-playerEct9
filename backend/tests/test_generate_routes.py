"""Tests for the generation routes (routes/generate.py).

These exercise the HTTP contract the renderer depends on: job start, polling,
cancel, the busy guard, and the generated-script store. The happy paths run
the real engines on a synthetic clip, which is also the end-to-end check that
analysis -> build -> store -> fetch actually hangs together.

The job table is module state, so every test starts from reset_jobs_for_tests()
and the store is pointed at a scratch directory instead of the user's data dir.
"""

import json
import os
import shutil
import subprocess
import sys
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import routes.generate as gen  # noqa: E402
from services.ffmpeg import FFMPEG  # noqa: E402
from services.generated_store import FileGeneratedScriptStore, set_store  # noqa: E402

pytestmark = pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not available")

BURST_SOURCE = "aevalsrc=(random(0)-0.5)*lt(mod(t\\,0.5)\\,0.002):d=12:s=8000"
MOVING_GRAPH = "[0:v][1:v]overlay=x='32+32*sin(2*PI*t)':y=22:shortest=1"


@pytest.fixture()
def app(media_dir):
    set_store(FileGeneratedScriptStore(os.path.join(media_dir, "store")))
    gen.reset_jobs_for_tests()
    application = FastAPI()
    application.include_router(gen.router, prefix="/api/generate")
    yield application
    gen.reset_jobs_for_tests()
    set_store(None)


@pytest.fixture()
def client(app):
    return TestClient(app)


@pytest.fixture(scope="session")
def clicks_wav(media_dir):
    path = os.path.join(media_dir, "route_clicks.wav")
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", BURST_SOURCE,
         "-c:a", "pcm_s16le", path],
        check=True,
    )
    return path


@pytest.fixture(scope="session")
def moving_mp4(media_dir):
    path = os.path.join(media_dir, "route_moving.mp4")
    subprocess.run(
        [FFMPEG, "-v", "error",
         "-f", "lavfi", "-i", "color=c=black:s=128x72:r=10:d=3",
         "-f", "lavfi", "-i", "color=c=white:s=48x27:r=10:d=3",
         "-filter_complex", MOVING_GRAPH,
         "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
        check=True,
    )
    return path


@pytest.fixture(scope="session")
def silent_mp4(media_dir):
    path = os.path.join(media_dir, "route_silent.mp4")
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi",
         "-i", "color=c=gray:s=64x36:r=10:d=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
        check=True,
    )
    return path


def _wait(client, job_id, timeout=60.0):
    """Poll until the job reaches a terminal state."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = client.get(f"/api/generate/{job_id}").json()
        if payload["status"] in ("done", "error", "cancelled"):
            return payload
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} never finished: {payload}")


def _start(client, path, **body):
    payload = {"video_path": path}
    payload.update(body)
    response = client.post("/api/generate/audio", json=payload)
    assert response.status_code == 200, response.text
    return response.json()["job_id"]


class TestStartValidation:
    def test_missing_video_path_is_400(self, client):
        response = client.post("/api/generate/audio", json={})
        assert response.status_code == 400
        assert response.json()["detail"]["field"] == "video_path"

    def test_unknown_video_is_404(self, client):
        response = client.post("/api/generate/audio",
                               json={"video_path": "Z:/nope/missing.mp4"})
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "noVideo"

    def test_end_before_start_is_400(self, client, clicks_wav):
        response = client.post("/api/generate/audio",
                               json={"video_path": clicks_wav,
                                     "start_ms": 5000, "end_ms": 4000})
        assert response.status_code == 400
        assert response.json()["detail"]["field"] == "end_ms"

    def test_unknown_device_is_400(self, client, clicks_wav):
        response = client.post("/api/generate/audio",
                               json={"video_path": clicks_wav,
                                     "device": "flux-9000"})
        assert response.status_code == 400
        assert response.json()["detail"]["field"] == "device"

    def test_unknown_job_is_404(self, client):
        assert client.get("/api/generate/no-such-job").status_code == 404
        assert client.post("/api/generate/no-such-job/cancel").status_code == 404


class TestBusyGuard:
    def test_second_request_is_409(self, client, clicks_wav):
        running = gen._Job("audio", clicks_wav, {})
        running.status = "running"
        with gen._lock:
            gen._jobs[running.id] = running
            gen._active = running
        response = client.post("/api/generate/audio",
                               json={"video_path": clicks_wav})
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "busy"
        assert detail["job_id"] == running.id

    def test_cancel_reaches_a_running_job(self, client):
        running = gen._Job("audio", "x", {})
        running.status = "running"
        with gen._lock:
            gen._jobs[running.id] = running
            gen._active = running
        response = client.post(f"/api/generate/{running.id}/cancel")
        assert response.status_code == 200
        assert running.cancel_event.is_set()


class TestAudioJob:
    def test_happy_path_builds_a_script(self, client, clicks_wav):
        job_id = _start(client, clicks_wav)
        payload = _wait(client, job_id)
        assert payload["status"] == "done", payload
        assert payload["progress"] == 1.0

        script = payload["script"]
        assert script["version"] == "1.0"
        actions = script["actions"]
        assert len(actions) >= 16, len(actions)
        assert all(0 <= action["pos"] <= 100 for action in actions)
        assert [a["at"] for a in actions] == sorted(a["at"] for a in actions)

        summary = payload["summary"]
        assert summary["event_count"] >= 16
        assert abs(summary["bpm"] - 120.0) <= 3.0
        assert summary["action_count"] == len(actions)

    def test_result_is_saved_to_the_store(self, client, clicks_wav):
        job_id = _start(client, clicks_wav)
        payload = _wait(client, job_id)
        script_id = payload["script_id"]
        assert script_id
        assert "video_hash" in payload["summary"]

        listed = client.get("/api/generate/store",
                            params={"video_path": clicks_wav}).json()
        # The store keeps every generation of a video, so the list is a
        # history: this job's entry is in it, not necessarily alone in it.
        assert script_id in [item["id"] for item in listed["items"]]

        fetched = client.get(f"/api/generate/store/{script_id}").json()
        assert fetched["record"]["id"] == script_id
        assert fetched["script"]["actions"] == payload["script"]["actions"]

        assert client.delete(f"/api/generate/store/{script_id}").json() == {"ok": True}
        assert client.get(f"/api/generate/store/{script_id}").status_code == 404

    def test_save_can_be_skipped(self, client, clicks_wav):
        before = client.get("/api/generate/store",
                            params={"video_path": clicks_wav}).json()["items"]
        job_id = _start(client, clicks_wav, save=False)
        payload = _wait(client, job_id)
        assert payload["status"] == "done"
        assert "script_id" not in payload
        after = client.get("/api/generate/store",
                           params={"video_path": clicks_wav}).json()["items"]
        assert [item["id"] for item in after] == [item["id"] for item in before]

    def test_video_without_audio_reports_no_audio(self, client, silent_mp4):
        job_id = _start(client, silent_mp4)
        payload = _wait(client, job_id)
        assert payload["status"] == "error"
        assert payload["error_code"] == "noAudio"

    def test_range_limits_the_script_to_the_slice(self, client, clicks_wav):
        job_id = _start(client, clicks_wav, start_ms=2000, end_ms=6000)
        payload = _wait(client, job_id)
        assert payload["status"] == "done"
        for action in payload["script"]["actions"]:
            assert 2000 <= action["at"] <= 6000

    def test_style_changes_the_shape(self, client, clicks_wav):
        alternating = _wait(client, _start(client, clicks_wav, style="alternating"))
        sine = _wait(client, _start(client, clicks_wav, style="sine"))
        assert alternating["script"]["actions"] != sine["script"]["actions"]


class TestMotionJob:
    def test_happy_path_builds_a_script(self, client, moving_mp4):
        response = client.post("/api/generate/motion",
                               json={"video_path": moving_mp4, "quality": "fast"})
        assert response.status_code == 200, response.text
        payload = _wait(client, response.json()["job_id"])
        assert payload["status"] == "done", payload
        assert payload["summary"]["motion_engine"] == "v1"
        # Five interior peaks on the 3 s oscillating-box fixture, minus
        # whatever the keyframe reduction folds away.
        assert payload["summary"]["action_count"] >= 4
        assert all(0 <= a["pos"] <= 100 for a in payload["script"]["actions"])

    def test_static_video_is_reported_empty(self, client, silent_mp4):
        response = client.post("/api/generate/motion",
                               json={"video_path": silent_mp4, "quality": "fast"})
        payload = _wait(client, response.json()["job_id"])
        assert payload["status"] == "done"
        assert payload["summary"].get("empty") is True
        # Nothing detected: the only keyframes left are the idle hold, which
        # parks the device at its rest position (min_pos) through the clip.
        assert all(action["pos"] == 0 for action in payload["script"]["actions"])
        assert "script_id" not in payload


class TestStoreRoutes:
    def test_store_for_an_unknown_video_is_empty(self, client):
        listed = client.get("/api/generate/store",
                            params={"video_path": "Z:/nope/missing.mp4"}).json()
        assert listed["items"] == []


@pytest.fixture()
def export_video(media_dir, clicks_wav):
    """A private copy of the click track for the export tests.

    Exporting writes a sidecar next to the video and one test removes the
    video itself, so these cannot run against the shared session fixtures.
    """
    path = os.path.join(media_dir, "export-copy.wav")
    shutil.copyfile(clicks_wav, path)
    yield path
    for leftover in (path, os.path.splitext(path)[0] + ".funscript"):
        if os.path.exists(leftover):
            os.remove(leftover)


def _generated_id(client, video_path):
    """Generate for a video and return the id the store gave the script."""
    payload = _wait(client, _start(client, video_path))
    assert payload["status"] == "done", payload
    return payload["script_id"], payload


class TestExportToSidecar:
    def test_export_writes_a_sidecar_next_to_the_video(self, client, export_video):
        script_id, payload = _generated_id(client, export_video)
        response = client.post(f"/api/generate/store/{script_id}/export")
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["ok"] is True
        assert result["filename"] == "export-copy.funscript"
        assert result["overwrote"] is False

        sidecar = os.path.splitext(export_video)[0] + ".funscript"
        with open(sidecar, "r", encoding="utf-8") as handle:
            written = json.load(handle)
        assert written["version"] == "1.0"
        assert written["actions"] == payload["script"]["actions"]

    def test_a_hand_made_sidecar_survives_without_confirmation(
        self, client, export_video
    ):
        sidecar = os.path.splitext(export_video)[0] + ".funscript"
        with open(sidecar, "w", encoding="utf-8") as handle:
            handle.write("hand made")
        script_id, _ = _generated_id(client, export_video)

        response = client.post(f"/api/generate/store/{script_id}/export")
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "exists"
        assert detail["filename"] == "export-copy.funscript"
        with open(sidecar, "r", encoding="utf-8") as handle:
            assert handle.read() == "hand made"

    def test_overwrite_needs_to_be_asked_for_explicitly(
        self, client, export_video
    ):
        sidecar = os.path.splitext(export_video)[0] + ".funscript"
        with open(sidecar, "w", encoding="utf-8") as handle:
            handle.write("hand made")
        script_id, payload = _generated_id(client, export_video)

        response = client.post(f"/api/generate/store/{script_id}/export",
                               json={"overwrite": True})
        assert response.status_code == 200, response.text
        assert response.json()["overwrote"] is True
        with open(sidecar, "r", encoding="utf-8") as handle:
            written = json.load(handle)
        assert written["actions"] == payload["script"]["actions"]

    def test_unknown_script_is_404(self, client):
        response = client.post("/api/generate/store/nosuchid/export")
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "notFound"

    def test_a_video_that_moved_on_is_404(self, client, export_video):
        script_id, _ = _generated_id(client, export_video)
        os.remove(export_video)
        response = client.post(f"/api/generate/store/{script_id}/export")
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "noVideo"
