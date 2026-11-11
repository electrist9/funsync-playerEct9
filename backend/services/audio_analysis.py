"""Audio-driven funscript generation (engine 1 of 2).

Pipeline, all CPU, no models:

  ffmpeg (streamed PCM)  ->  numpy STFT  ->  spectral-flux onset envelope
                         ->  adaptive-threshold peak picking
                         ->  tempo estimate (autocorrelation) + grid snap
                         ->  per-onset strength + silence/idle windows

Design notes and why it is shaped this way:

* Streaming. ffmpeg writes mono 8 kHz s16le to stdout and we consume it in
  small chunks. 8 kHz mono is ~57 MB per hour of video, and because the
  onset envelope is computed per chunk the peak memory is a few MB
  regardless of how long the video is. The renderer's existing beat
  detector (renderer/js/beat-detector.js) fetches and decodes the *whole*
  file, which is fine for a short clip and unusable for a multi-GB VR
  file — this module exists to replace that path for generation.

* 8 kHz is deliberate. Onsets live in transients, and the useful band for
  them reaches well below the 4 kHz Nyquist here. It also lets the FFT be
  cheap (1024-point, hop 64 = 8 ms).

* Low-band down-weighting. A thrust is not a kick drum: the 20-150 Hz
  region carries bass energy that produces huge spectral flux with no
  visual/rhythm meaning for a stroke, so those bins are weighted down.
  (The renderer's JS detector has the same idea; keeping the two
  consistent means a user who used the beat modal recognises the result.)

* Tempo is optional polish. Autocorrelating the onset envelope over
  30-200 BPM finds a grid when the source is musical; when it is not
  (ambient, spoken, most amateur video) the strength comes back low and
  the raw onsets are kept, because forcing a wrong grid is worse than no
  grid. librosa's `fourier_tempogram` is the heavyweight alternative;
  autocorrelation is a few hundred thousand multiply-adds and needs no
  extra dependency.

numpy is imported at module level, but this module is imported lazily by
routes/generate.py (inside the job thread), so backend startup and /health
never pay for it.
"""

from __future__ import annotations

import math
import subprocess
import time
from typing import Any, Callable, Sequence

import numpy as np

from services.ffmpeg import FFMPEG, probe_streams, run_silent_stream
from services.generate_errors import GenerateError

SAMPLE_RATE = 8000
FFT_SIZE = 1024
HOP_SIZE = 64  # 8 ms at 8 kHz

# Chunk of PCM samples pulled from ffmpeg per read. 8192 samples = 16 KiB
# on the pipe, ~1 s of audio, ~113 STFT frames per batch.
CHUNK_SAMPLES = 8192

# Onset detection defaults, chosen to match renderer/js/beat-detector.js
# (sensitivity 1.4, min beat gap 150 ms) so both entry points feel alike.
DEFAULT_SENSITIVITY = 1.4
MIN_BEAT_GAP_MS = 150
# Accepted band for the sensitivity multiplier. The UI slider offers a narrower
# band (renderer/js/generate-panel.js), but the engine clamps whatever it is
# given rather than rejecting it: below SENSITIVITY_MIN the threshold sinks
# under the flux median, so every local peak becomes an onset and the output is
# only ever bounded by MIN_BEAT_GAP_MS; above SENSITIVITY_MAX nothing is found.
SENSITIVITY_MIN = 0.05
SENSITIVITY_MAX = 6.0
# Block length for the robust onset threshold statistics, and the floor as a
# fraction of the clip's 95th-percentile flux (see _detect_onsets).
ONSET_STATS_BLOCK_S = 1.0
ONSET_FLOOR_RATIO = 0.02

# Tempo: 30..200 BPM, and a normalized autocorrelation peak must clear
# this before onsets are snapped to the grid.
TEMPO_MIN_BPM = 30.0
TEMPO_MAX_BPM = 200.0
TEMPO_MIN_STRENGTH = 0.30
SNAP_TOLERANCE_MS = 40

# Silence / idle detection. A stretch whose level sits this many dB below
# the median level of the clip — and below an absolute floor — becomes a
# pause in the generated script instead of more stroking.
IDLE_WINDOW_S = 1.5
IDLE_DROPDB = 24.0
IDLE_FLOOR_DB = -55.0


def _require_audio_stream(video_path: str) -> dict[str, Any]:
    try:
        info = probe_streams(video_path)
    except FileNotFoundError as exc:
        raise GenerateError("noVideo", "Video file not found") from exc
    except RuntimeError as exc:
        if "ffprobe not found" in str(exc):
            raise GenerateError("noFfmpeg", str(exc)) from exc
        raise GenerateError("failed", str(exc)) from exc
    audio = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio:
        raise GenerateError("noAudio", "Video has no audio track")
    return audio[0]


def _frame_matrix(samples: np.ndarray, fft_size: int, hop: int) -> np.ndarray:
    """View `samples` as overlapping FFT frames (copy, but only per chunk)."""
    n = (len(samples) - fft_size) // hop + 1
    if n <= 0:
        return np.empty((0, fft_size), dtype=np.float32)
    idx = np.arange(fft_size)[None, :] + hop * np.arange(n)[:, None]
    return samples[idx]


def _stream_pcm(video_path: str, start_s: float | None, end_s: float | None,
                sample_rate: int, progress_cb: Callable[[float], None] | None,
                cancel_cb: Callable[[], bool] | None,
                fft_size: int, hop: int) -> dict[str, np.ndarray]:
    """Read PCM from ffmpeg and compute the per-frame features as we go.

    Returns flux / rms_db / low_energy arrays, one entry per STFT frame.
    """
    cmd = [FFMPEG, "-v", "error"]
    if start_s is not None:
        cmd += ["-ss", f"{start_s:.3f}"]
    if end_s is not None:
        # -to as an *input* option is an absolute position on the input
        # timeline, so -ss 60 -to 120 selects 60 seconds starting at 60 s.
        cmd += ["-to", f"{end_s:.3f}"]
    cmd += ["-i", video_path, "-vn", "-ac", "1", "-ar", str(sample_rate),
            "-f", "s16le", "-"]

    try:
        # run_silent_stream: no console window on Windows (console=False in
        # the PyInstaller build makes a bare Popen flash one).
        proc = run_silent_stream(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 bufsize=CHUNK_SAMPLES * 4)
    except FileNotFoundError as exc:
        raise GenerateError("noFfmpeg", "ffmpeg not found") from exc

    bin_hz = sample_rate / fft_size
    low_hi = max(2, int(round(150.0 / bin_hz)))
    weights = np.ones(fft_size // 2 + 1, dtype=np.float32)
    weights[1:low_hi + 1] = 0.35  # bass carries rhythm energy, not strokes
    window = np.hanning(fft_size).astype(np.float32)

    flux_parts: list[np.ndarray] = []
    rms_parts: list[np.ndarray] = []
    low_parts: list[np.ndarray] = []
    leftover = np.zeros(0, dtype=np.float32)
    prev_mag: np.ndarray | None = None

    expected_bytes = None
    if end_s is not None and start_s is not None:
        expected_bytes = max(1, int((end_s - start_s) * sample_rate * 2))
    read_bytes = 0

    try:
        while True:
            if cancel_cb and cancel_cb():
                _terminate(proc)
                raise GenerateError("cancelled", "Generation cancelled")
            block = proc.stdout.read(CHUNK_SAMPLES * 2)
            if not block:
                break
            read_bytes += len(block)
            if read_bytes % 2:  # never act on half a sample
                block = block[:-1]
            samples = np.frombuffer(block, dtype="<i2").astype(np.float32) / 32768.0
            if expected_bytes and progress_cb:
                progress_cb(min(0.95, read_bytes / expected_bytes))

            if leftover.size:
                samples = np.concatenate((leftover, samples))
            if len(samples) < fft_size:
                # Too little audio for even one window yet: carry it forward.
                leftover = samples
                continue

            frames = _frame_matrix(samples, fft_size, hop)
            if frames.shape[0] == 0:
                leftover = samples
                continue
            # Re-analyze the last fft_size-hop samples together with the next
            # chunk. Without that overlap the frame grid jumps at every chunk
            # boundary, the frame index drifts off the audio timeline, and
            # onset times come out systematically wrong.
            leftover = samples[len(samples) - (fft_size - hop):]

            mag_lin = np.abs(np.fft.rfft(frames * window, axis=1))
            # log compression: flux across a 30 dB dynamic range otherwise
            # drowns the quiet onsets that matter in a dialogue-heavy clip.
            mag = np.log1p(mag_lin * 8.0)

            if prev_mag is None:
                # First frame of the clip has no predecessor; use it as the
                # baseline so its flux is ~0 rather than a spurious spike.
                d = np.zeros_like(mag)
            else:
                d = mag - prev_mag
            prev_mag = mag[-1]
            flux_parts.append(np.sum(np.clip(d, 0.0, None) * weights, axis=1).astype(np.float32))
            rms_parts.append(np.sqrt(np.mean(frames * frames, axis=1)).astype(np.float32))
            low_parts.append(np.sqrt(np.mean(mag_lin[:, 1:low_hi + 1] ** 2, axis=1)).astype(np.float32))
            # Yield the GIL so the event loop keeps answering /health while
            # this thread works (see tests/test_backend_responsiveness.py).
            time.sleep(0)
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        stderr = b""
        try:
            stderr = proc.stderr.read() or b""
        except OSError:
            pass
        try:
            proc.stderr.close()
        except OSError:
            pass
        code = proc.wait(timeout=30)
        if code not in (0, None) and read_bytes == 0:
            raise GenerateError("failed", f"ffmpeg audio extraction failed: {stderr.decode('utf-8', 'replace')[:400]}")

    if not flux_parts:
        raise GenerateError("noAudio", "Audio track produced no decodable samples")

    return {
        "flux": np.concatenate(flux_parts),
        "rms": np.concatenate(rms_parts),
        "low": np.concatenate(low_parts),
    }


def _terminate(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    except OSError:
        pass


def _detect_onsets(flux: np.ndarray, frame_rate: float, sensitivity: float) -> list[int]:
    """Adaptive-threshold peak picking on the spectral-flux envelope.

    The local threshold is a robust estimate — median + sensitivity * 1.4826 *
    MAD over non-overlapping one-second blocks — not the textbook mean + k *
    std: one loud onset inflates the mean *and* the standard deviation of its
    own window, which is exactly what buries the weaker onsets next to it.
    Block statistics (instead of a sliding window over the whole envelope)
    keep memory flat for long tracks.
    """
    n = len(flux)
    if n == 0:
        return []
    env = np.convolve(flux, np.ones(3, dtype=np.float32) / 3.0, mode="same")
    block = max(8, int(round(ONSET_STATS_BLOCK_S * frame_rate)))
    pad = (-n) % block
    padded = env if pad == 0 else np.concatenate(
        [env, np.full(pad, float(np.median(env)), dtype=env.dtype)])
    stacked = padded.reshape(-1, block)
    med = np.median(stacked, axis=1)
    mad = 1.4826 * np.median(np.abs(stacked - med[:, None]), axis=1)
    threshold = np.repeat(med + sensitivity * mad, block)[:n]
    # Floor: in a genuinely quiet stretch the robust stats collapse to zero and
    # every bit of dither crosses the threshold. A fraction of the clip's loud
    # peaks keeps the noise out of the script.
    loud = float(np.percentile(env, 95)) if n else 0.0
    threshold = np.maximum(threshold, ONSET_FLOOR_RATIO * loud)

    min_gap = max(1, int(round(MIN_BEAT_GAP_MS / 1000.0 * frame_rate)))
    peaks: list[int] = []
    last = -10 ** 9
    for i in range(1, n - 1):
        if env[i] > threshold[i] and env[i] >= env[i - 1] and env[i] > env[i + 1]:
            if i - last >= min_gap:
                peaks.append(i)
                last = i
    return peaks


def _estimate_tempo(env: np.ndarray, frame_rate: float) -> tuple[float | None, float]:
    """Autocorrelate the onset envelope over 30-200 BPM.

    Returns (bpm, strength) where strength is the normalized autocorrelation
    peak — low strength means "there is no grid here", and the caller keeps
    the raw onsets.
    """
    if len(env) < 32:
        return None, 0.0
    # Decimating to ~50 Hz keeps the autocorrelation cheap on a 30-minute clip
    # while leaving enough lag resolution that the parabolic refinement below
    # can land inside a percent or two of the true tempo.
    factor = max(1, int(round(frame_rate / 50.0)))
    usable = (len(env) // factor) * factor
    if usable < 32:
        return None, 0.0
    dec = env[:usable].reshape(-1, factor).sum(axis=1).astype(np.float64)
    rate = frame_rate / factor
    dec = dec - dec.mean()
    denom = float(np.dot(dec, dec))
    if denom <= 0:
        return None, 0.0
    m = len(dec)
    lag_lo = max(2, int(math.floor(60.0 / TEMPO_MAX_BPM * rate)))
    lag_hi = min(m - 2, int(math.ceil(60.0 / TEMPO_MIN_BPM * rate)))
    if lag_hi < lag_lo:
        return None, 0.0
    acs = np.array([float(np.dot(dec[:-lag], dec[lag:])) / denom
                    for lag in range(lag_lo, lag_hi + 1)], dtype=np.float64)
    k = int(np.argmax(acs))
    best_val = float(acs[k])
    # Sub-lag refinement: the raw lag grid quantizes the tempo (at 62.5 Hz a
    # 120 BPM grid is 31.25 samples), which would bias the beat grid and the
    # reported BPM. A parabola through the three points around the peak fixes
    # that for the price of two extra dot products.
    refined = float(k)
    if 0 < k < len(acs) - 1:
        a, b, c = acs[k - 1], acs[k], acs[k + 1]
        curve = a - 2.0 * b + c
        if curve != 0.0:
            shift = 0.5 * (a - c) / curve
            if -1.0 <= shift <= 1.0:
                refined = k + shift
    lag = lag_lo + refined
    if lag <= 0:
        return None, 0.0
    # Plain Python floats: numpy scalars would otherwise leak into the API
    # JSON and into every downstream consumer of the analysis result.
    return float(60.0 * rate / lag), float(max(0.0, best_val))


def _snap_to_grid(peaks: Sequence[int], bpm: float, env: np.ndarray, frame_rate: float) -> list[int]:
    """Move onsets onto the nearest beat-grid point when they are already
    close to it. Onsets far from the grid are left alone — they are real
    events the grid does not explain."""
    period = 60.0 * frame_rate / bpm
    if period < 2:
        return list(peaks)
    best_offset, best_score = 0.0, -1.0
    for offset in np.linspace(0.0, period, 32, endpoint=False):
        grid = np.arange(offset, len(env), period).astype(np.int64)
        if grid.size == 0:
            continue
        score = float(env[grid].sum())
        if score > best_score:
            best_score, best_offset = score, float(offset)
    tol = SNAP_TOLERANCE_MS / 1000.0 * frame_rate
    snapped = []
    for p in peaks:
        grid_point = best_offset + round((p - best_offset) / period) * period
        snapped.append(int(round(grid_point)) if abs(grid_point - p) <= tol else int(p))
    return sorted(set(snapped))


def _idle_windows(rms: np.ndarray, frame_rate: float) -> list[tuple[float, float]]:
    """Silent stretches (ms, absolute) that should become holds in the script."""
    if rms.size == 0:
        return []
    db = 20.0 * np.log10(np.maximum(rms, 1e-6))
    median = float(np.median(db))
    floor = max(IDLE_FLOOR_DB, median - IDLE_DROPDB)
    silent = db < floor
    # Require the quiet to be sustained, not a single breath between words.
    win = max(1, int(round(0.25 * frame_rate)))
    frac = np.convolve(silent.astype(np.float32), np.ones(win, dtype=np.float32) / win, mode="same")
    silent = frac > 0.9

    windows: list[tuple[int, int]] = []
    start: int | None = None
    for i, flag in enumerate(silent):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            if (i - start) / frame_rate >= IDLE_WINDOW_S:
                windows.append((start, i))
            start = None
    if start is not None and (len(silent) - start) / frame_rate >= IDLE_WINDOW_S:
        windows.append((start, len(silent)))

    merged: list[tuple[int, int]] = []
    for s, e in windows:
        if merged and s - merged[-1][1] < frame_rate:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return [(s / frame_rate * 1000.0, e / frame_rate * 1000.0) for s, e in merged]


def analyze_audio(video_path: str,
                  start_ms: float | None = None,
                  end_ms: float | None = None,
                  *,
                  sensitivity: float = DEFAULT_SENSITIVITY,
                  sample_rate: int = SAMPLE_RATE,
                  fft_size: int = FFT_SIZE,
                  hop_size: int = HOP_SIZE,
                  progress_cb: Callable[[float], None] | None = None,
                  cancel_cb: Callable[[], bool] | None = None) -> dict[str, Any]:
    """Generate the raw material for a funscript from a video's audio track.

    Times in the result are absolute milliseconds in the video's timeline
    (the selected range is added back in), which is what the editor and the
    generated-script store both need.

    Returns:
        {
          "events": [(at_ms, strength 0..1)],
          "idle_windows": [(start_ms, end_ms)],
          "tempo": {"bpm": float|None, "strength": float, "snapped": int},
          "duration_ms": int,
        }
    Raises:
        GenerateError: noFfmpeg / noAudio / badRange / cancelled / failed
    """
    if start_ms is not None and end_ms is not None and end_ms <= start_ms:
        raise GenerateError("badRange", "Selection range is empty")
    sensitivity = min(SENSITIVITY_MAX, max(SENSITIVITY_MIN, float(sensitivity)))
    _require_audio_stream(video_path)

    start_s = None if start_ms in (None, 0) else start_ms / 1000.0
    end_s = None if end_ms is None else end_ms / 1000.0

    features = _stream_pcm(video_path, start_s, end_s, sample_rate, progress_cb,
                           cancel_cb, fft_size, hop_size)
    flux, rms, low = features["flux"], features["rms"], features["low"]
    frame_rate = sample_rate / hop_size
    offset_ms = start_ms or 0.0

    peaks = _detect_onsets(flux, frame_rate, sensitivity)
    bpm, tempo_strength = _estimate_tempo(flux, frame_rate)
    snapped = 0
    if bpm and tempo_strength >= TEMPO_MIN_STRENGTH and peaks:
        grid = _snap_to_grid(peaks, bpm, flux, frame_rate)
        snapped = sum(1 for a, b in zip(peaks, grid) if a != b)
        peaks = grid

    idle = _idle_windows(rms, frame_rate)
    idle_abs = [(s + offset_ms, e + offset_ms) for s, e in idle]

    def in_idle(t_ms: float) -> bool:
        return any(s <= t_ms <= e for s, e in idle_abs)

    low_ref = float(np.percentile(low, 90)) if low.size else 0.0
    flux_ref = float(np.percentile(flux, 90)) if flux.size else 0.0
    events: list[tuple[float, float]] = []
    for frame in peaks:
        t_ms = (frame * hop_size + fft_size / 2.0) / sample_rate * 1000.0 + offset_ms
        if in_idle(t_ms):
            continue
        low_score = low[frame] / low_ref if low_ref > 0 else 0.0
        flux_score = flux[frame] / flux_ref if flux_ref > 0 else 0.0
        strength = max(0.05, min(1.0, 0.5 * low_score + 0.5 * flux_score))
        events.append((float(t_ms), float(strength)))

    if progress_cb:
        progress_cb(1.0)

    return {
        "events": events,
        "idle_windows": idle_abs,
        "tempo": {"bpm": bpm, "strength": round(tempo_strength, 3), "snapped": snapped},
        "duration_ms": int(len(flux) * hop_size / sample_rate * 1000.0),
        "frame_rate": frame_rate,
    }
