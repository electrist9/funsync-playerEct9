"""Tests for the audio funscript engine.

These run the real ffmpeg/ffprobe the backend ships with, against synthetic
media built on the fly: a 120 BPM noise-burst track (broadband clicks on a
500 ms grid, which is what onset detection has to lock onto) plus a version
that falls silent after 12 s. Everything is local; nothing touches the
network.
"""

import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.ffmpeg import FFMPEG
from services.generate_errors import GenerateError

pytestmark = pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not available")

# 2 ms noise burst every 500 ms = a 120 BPM click track.
BURST_SOURCE = "aevalsrc=(random(0)-0.5)*lt(mod(t\\,0.5)\\,0.002):d=12:s=8000"

# media_dir comes from tests/conftest.py: a workspace-local scratch directory
# that ffmpeg, running as a child process, can actually write into.


@pytest.fixture(scope="session")
def clicks_wav(media_dir):
    path = os.path.join(media_dir, "clicks.wav")
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", BURST_SOURCE,
         "-c:a", "pcm_s16le", path],
        check=True,
    )
    return path


@pytest.fixture(scope="session")
def clicks_then_silence_wav(media_dir):
    path = os.path.join(media_dir, "clicks_then_silence.wav")
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", BURST_SOURCE,
         "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono:d=6",
         "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
         "-c:a", "pcm_s16le", path],
        check=True,
    )
    return path


@pytest.fixture(scope="session")
def video_without_audio(media_dir):
    path = os.path.join(media_dir, "no_audio.mp4")
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=10:d=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", path],
        check=True,
    )
    return path


def _off_grid_ms(events):
    """Worst distance from any event time to the nearest 500 ms beat."""
    return max(abs(at - round(at / 500.0) * 500.0) for at, _strength in events)


class TestOnsetDetection:
    def test_events_land_on_the_beat_grid(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_wav)
        events = result["events"]
        # 24 clicks in the track; onset detection is allowed to miss a few of
        # the weakest ones, but it must not invent events between beats.
        assert len(events) >= 16
        assert _off_grid_ms(events) <= 60.0

    def test_events_are_ordered_and_absolute(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_wav)
        times = [at for at, _ in result["events"]]
        assert times == sorted(times)
        assert times[0] >= 0
        assert times[-1] <= result["duration_ms"]

    def test_strengths_are_normalised(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_wav)
        strengths = [s for _, s in result["events"]]
        assert all(0.0 <= s <= 1.0 for s in strengths)
        assert max(strengths) > 0.5


class TestSensitivity:
    def test_out_of_band_values_are_clamped_to_the_band_edge(self, clicks_wav):
        # The UI slider offers 0.1..1.5 while the engine accepts a wider band,
        # but a hand-crafted request (or the web remote) can ask for anything.
        # The engine clamps instead of rejecting, so an out-of-band value
        # behaves exactly like the nearest band edge.
        from services.audio_analysis import SENSITIVITY_MAX, SENSITIVITY_MIN, analyze_audio

        low = analyze_audio(clicks_wav, sensitivity=-5.0)["events"]
        assert low == analyze_audio(clicks_wav, sensitivity=SENSITIVITY_MIN)["events"]

        high = analyze_audio(clicks_wav, sensitivity=999.0)["events"]
        assert high == analyze_audio(clicks_wav, sensitivity=SENSITIVITY_MAX)["events"]

    def test_lower_sensitivity_finds_at_least_as_many_onsets(self, clicks_wav):
        # The direction the UI hint promises: lower value -> more beats.
        from services.audio_analysis import MIN_BEAT_GAP_MS, analyze_audio

        default = analyze_audio(clicks_wav)["events"]
        dense = analyze_audio(clicks_wav, sensitivity=0.3)["events"]
        assert len(dense) >= len(default)

        # ...but never denser than the beat gap, however low the value goes.
        gaps = [b[0] - a[0] for a, b in zip(dense, dense[1:])]
        assert all(gap >= MIN_BEAT_GAP_MS - 1.0 for gap in gaps)


class TestTempo:
    def test_tempo_matches_the_click_track(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_wav)
        assert abs(result["tempo"]["bpm"] - 120.0) <= 3.0
        assert result["tempo"]["strength"] > 0.3

    def test_bpm_is_a_plain_float_for_json(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_wav)
        assert type(result["tempo"]["bpm"]) is float


class TestIdleWindows:
    def test_silence_becomes_an_idle_window(self, clicks_then_silence_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_then_silence_wav)
        windows = result["idle_windows"]
        assert windows, "the silent tail should produce an idle window"
        start, end = windows[-1]
        assert start >= 11000
        assert end >= 17000

    def test_no_events_inside_idle_windows(self, clicks_then_silence_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_then_silence_wav)
        for at, _strength in result["events"]:
            for start, end in result["idle_windows"]:
                assert not (start <= at <= end)

    def test_a_uniform_track_has_no_idle_windows(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        assert analyze_audio(clicks_wav)["idle_windows"] == []


class TestRangeSelection:
    def test_slice_returns_absolute_times_inside_the_range(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        result = analyze_audio(clicks_wav, 2000, 6000)
        events = result["events"]
        assert len(events) >= 6
        assert all(2000 <= at <= 6000 for at, _ in events)

    def test_end_before_start_is_rejected(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        with pytest.raises(GenerateError) as exc:
            analyze_audio(clicks_wav, 5000, 5000)
        assert exc.value.code == "badRange"


class TestErrorPaths:
    def test_video_without_audio_track(self, video_without_audio):
        from services.audio_analysis import analyze_audio

        with pytest.raises(GenerateError) as exc:
            analyze_audio(video_without_audio)
        assert exc.value.code == "noAudio"

    def test_missing_file(self, media_dir):
        from services.audio_analysis import analyze_audio

        with pytest.raises(GenerateError) as exc:
            analyze_audio(os.path.join(media_dir, "does-not-exist.mp4"))
        assert exc.value.code == "noVideo"

    def test_cancellation_stops_the_stream(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        calls = {"n": 0}

        def cancel_cb():
            calls["n"] += 1
            return calls["n"] > 3

        with pytest.raises(GenerateError) as exc:
            analyze_audio(clicks_wav, cancel_cb=cancel_cb)
        assert exc.value.code == "cancelled"


class TestProgress:
    def test_progress_is_monotonic_and_bounded(self, clicks_wav):
        from services.audio_analysis import analyze_audio

        seen = []
        analyze_audio(clicks_wav, progress_cb=seen.append)
        assert seen
        assert all(b >= a for a, b in zip(seen, seen[1:]))
        assert all(0.0 <= v <= 1.0 for v in seen)
