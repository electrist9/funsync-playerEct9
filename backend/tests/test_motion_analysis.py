"""Tests for the video-motion engine (services/motion_analysis.py).

The fixtures are synthetic lavfi clips: a white box sliding left/right over a
black field (periodic motion, one direction change every half second) and a
flat grey field (no motion at all). Synthetic media keeps the expectations
exact — a real video would only tell us the engine found *something*.

media_dir comes from tests/conftest.py: a workspace-local scratch directory
that ffmpeg, running as a child process, can actually write into.
"""

import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.ffmpeg import FFMPEG  # noqa: E402
from services.generate_errors import GenerateError  # noqa: E402
from services.motion_analysis import analyze_motion  # noqa: E402

pytestmark = pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not available")

# A 48x27 white box oscillating across a 128x72 field at 1 Hz: two direction
# changes per second. drawbox has no per-frame eval in ffmpeg 9, so the box is
# a second input moved with overlay's x expression.
MOVING_GRAPH = (
    "[0:v][1:v]overlay=x='32+32*sin(2*PI*t)':y=22:shortest=1"
)


@pytest.fixture(scope="session")
def moving_mp4(media_dir):
    path = os.path.join(media_dir, "moving.mp4")
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
def static_mp4(media_dir):
    path = os.path.join(media_dir, "static.mp4")
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi",
         "-i", "color=c=gray:s=64x36:r=10:d=3",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
        check=True,
    )
    return path


class TestEvents:
    def test_periodic_motion_produces_events(self, moving_mp4):
        result = analyze_motion(moving_mp4, quality="fast")
        events = result["events"]
        # v1 is direction-blind: it fires where the box moves *fastest*, which
        # for a 1 Hz sine sweep is every half second. Over three seconds that
        # leaves five interior peaks (the ones at the clip edges are not
        # countable), so five is the expected count, not six turning points.
        assert len(events) >= 5, events
        assert result["engine"] == "v1"

    def test_events_are_ordered_and_absolute(self, moving_mp4):
        events = analyze_motion(moving_mp4, quality="fast")["events"]
        times = [at for at, _strength in events]
        assert times == sorted(times)
        assert all(0.0 <= at <= 3000.0 for at in times)

    def test_events_are_not_clumped_together(self, moving_mp4):
        events = analyze_motion(moving_mp4, quality="fast")["events"]
        gaps = [b[0] - a[0] for a, b in zip(events, events[1:])]
        assert all(gap >= 150.0 for gap in gaps), gaps

    def test_strengths_are_normalised(self, moving_mp4):
        events = analyze_motion(moving_mp4, quality="fast")["events"]
        strengths = [strength for _at, strength in events]
        assert all(0.0 < strength <= 1.0 for strength in strengths)
        assert max(strengths) > 0.5


class TestStaticVideo:
    def test_no_motion_produces_no_events(self, static_mp4):
        assert analyze_motion(static_mp4, quality="fast")["events"] == []

    def test_no_motion_becomes_one_idle_window(self, static_mp4):
        windows = analyze_motion(static_mp4, quality="fast")["idle_windows"]
        assert len(windows) == 1
        start, end = windows[0]
        assert start <= 500.0
        assert end >= 2500.0


class TestSignalEngine:
    def test_v2_returns_a_bounded_signal(self, moving_mp4):
        result = analyze_motion(moving_mp4, quality="standard")
        assert result["engine"] == "v2"
        signal = result["signal"]
        assert len(signal) > 10
        assert all(-1.0 <= value <= 1.0 for _at, value in signal)
        # A constant signal would mean the block search found nothing.
        values = [value for _at, value in signal]
        assert max(values) - min(values) > 0.2

    def test_v2_signal_is_ordered(self, moving_mp4):
        signal = analyze_motion(moving_mp4, quality="standard")["signal"]
        times = [at for at, _value in signal]
        assert times == sorted(times)

    def test_static_video_signal_is_flat(self, static_mp4):
        signal = analyze_motion(static_mp4, quality="standard")["signal"]
        values = [value for _at, value in signal]
        assert values and max(values) - min(values) < 0.2


class TestPresetsAndOverrides:
    def test_engine_override_wins_over_quality(self, moving_mp4):
        result = analyze_motion(moving_mp4, quality="high", engine="v1")
        assert result["engine"] == "v1"
        assert "events" in result and "signal" not in result

    def test_fps_override_changes_the_frame_count(self, moving_mp4):
        slow = analyze_motion(moving_mp4, quality="fast", fps=5)
        assert slow["fps"] == 5


class TestRangeSelection:
    def test_slice_returns_absolute_times(self, moving_mp4):
        result = analyze_motion(moving_mp4, 1000, 2000, quality="fast")
        for at, _strength in result["events"]:
            assert 1000.0 <= at <= 2000.0

    def test_end_before_start_is_rejected(self, moving_mp4):
        with pytest.raises(GenerateError) as excinfo:
            analyze_motion(moving_mp4, 2000, 1000)
        assert excinfo.value.code == "badRange"


class TestErrorPaths:
    def test_missing_file(self, media_dir):
        with pytest.raises(GenerateError) as excinfo:
            analyze_motion(os.path.join(media_dir, "does-not-exist.mp4"))
        assert excinfo.value.code in ("noVideo", "noFfmpeg")

    def test_cancellation_stops_the_stream(self, moving_mp4):
        calls = {"n": 0}

        def cancel_cb():
            calls["n"] += 1
            return calls["n"] > 3

        with pytest.raises(GenerateError) as excinfo:
            analyze_motion(moving_mp4, quality="fast", cancel_cb=cancel_cb)
        assert excinfo.value.code == "cancelled"


class TestProgress:
    def test_progress_is_monotonic_and_bounded(self, moving_mp4):
        seen = []
        analyze_motion(moving_mp4, quality="fast", progress_cb=seen.append)
        assert seen
        assert all(0.0 <= value <= 1.0 for value in seen)
        assert seen == sorted(seen)
