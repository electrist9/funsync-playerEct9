"""Video-motion-driven funscript generation (engine 2 of 2).

Two implementations, both pure numpy on tiny grayscale frames — no
optical-flow library, no model, no GPU:

  v1 "fast"     — center-weighted mean absolute difference between
                  consecutive downsampled frames; peaks become events.
                  Cheap, direction-blind, robust. Good enough for most
                  static-camera clips and the safest thing to run on 4K.

  v2 "standard"/"high" — block motion matching (8x8 blocks, +-3 px search)
                  -> displacement field -> divergence -> "center of motion"
                  -> projection of each block's motion onto the
                  center->block vector, summed with equal weight on all
                  sides. That yields a signed expansion(+)/contraction(-)
                  signal, integrated to a position — the same idea as the
                  community's Funscript-Flow, reimplemented here in numpy
                  so it ships inside the existing ffmpeg+numpy backend
                  instead of as a separate tool.

Why block matching and not dense optical flow: Farneback needs OpenCV
(+40-60 MB to the PyInstaller bundle, against the numpy-only decision) and
a 4K decode would dominate the cost anyway. Block matching on a 64x36
frame is ~50 small numpy ops per frame and reads 2.3 KB per frame from
ffmpeg's raw stream, so memory stays flat for a 30-minute file.

Scene cuts matter: a hard cut produces a huge fake motion spike, and
integrating through it drifts the position to a rail. Cuts are detected
from the frame stream itself (a mean-diff far above the running median)
rather than a separate `scdet` pass, because a second pass would decode
the whole video twice. After a cut the integrator resets and the first
frames are dropped.
"""

from __future__ import annotations

import subprocess
import time
from typing import Any, Callable

import numpy as np

from services.ffmpeg import FFMPEG, probe_streams, run_silent_stream
from services.generate_errors import GenerateError

# Quality presets. Resolution and fps are the knobs that decide cost; the
# engine decides the algorithm. Kept deliberately small — at 64x36 the
# whole frame is 2.3 KB and the block grid is 3x7.
QUALITY_PRESETS: dict[str, dict[str, Any]] = {
    "fast": {"engine": "v1", "width": 64, "height": 36, "fps": 8},
    "standard": {"engine": "v2", "width": 64, "height": 36, "fps": 10},
    "high": {"engine": "v2", "width": 96, "height": 54, "fps": 12},
}

BLOCK_SIZE = 8
SEARCH_RANGE = 3

# Cut detection: a frame whose mean absolute difference is this large, or
# this many times the running median, is a scene change.
CUT_ABS = 0.30
CUT_RATIO = 6.0
CUT_MEDIAN_WINDOW = 30
# Frames right after a cut are dropped: block matching across a cut is
# meaningless and the integrator would inherit a bogus displacement.
CUT_SETTLE_FRAMES = 2

# Static-frame threshold (mean abs diff of 0..1 frames) for idle windows.
STATIC_DIFF = 0.012
IDLE_WINDOW_S = 1.5

# v1 peak picking
MIN_EVENT_GAP_MS = 150
EVENT_SENSITIVITY = 1.3

# Detrend window for the v2 integrated signal.
DETREND_WINDOW_S = 1.5


def _require_video_stream(video_path: str) -> dict[str, Any]:
    try:
        info = probe_streams(video_path)
    except FileNotFoundError as exc:
        raise GenerateError("noVideo", "Video file not found") from exc
    except RuntimeError as exc:
        if "ffprobe not found" in str(exc):
            raise GenerateError("noFfmpeg", str(exc)) from exc
        raise GenerateError("failed", str(exc)) from exc
    for stream in info.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream
    raise GenerateError("noVideo", "Video has no video stream")


def detect_vr_crop(stream: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int] | None:
    """Crop box for equirectangular VR video, or None for a normal video.

    A 180/360 equirect frame is mostly floor, ceiling and the operator's
    own body at the edges; motion analysis over the whole sphere is
    dominated by that, so v2 looks at the centre third of the width —
    where the subject is for the usual 180-degree front-facing recording.
    (The audio engine is the better answer for VR; the UI says so.)
    """
    tags = stream.get("tags", {}) or {}
    side_data = stream.get("side_data_list", []) or []
    projection = str(tags.get("Spherical-Video", "")).lower()
    for entry in side_data:
        if str(entry.get("projection", "")).lower() in ("equirectangular", "equi360"):
            projection = "equirectangular"
    is_equirect = "equirectangular" in projection or "equi360" in projection
    if not is_equirect and width >= 2048 and height > 0 and abs(width / height - 2.0) < 0.05:
        # 2:1 at VR resolutions is overwhelmingly equirect; ffprobe does
        # not always carry the tag (MKV without the spherical flag).
        is_equirect = True
    if not is_equirect:
        return None
    crop_w = max(BLOCK_SIZE * 4, width // 3)
    return ((width - crop_w) // 2, 0, crop_w, height)


def _center_weight(h: int, w: int) -> np.ndarray:
    """Raised-cosine weight map: the middle of the frame counts ~4x the
    edges, so camera shake at the frame border doesn't drive the script."""
    xs = 0.25 + 0.75 * (1.0 - np.cos(2.0 * np.pi * (np.arange(w) + 0.5) / w)) / 2.0
    ys = 0.25 + 0.75 * (1.0 - np.cos(2.0 * np.pi * (np.arange(h) + 0.5) / h)) / 2.0
    weight = np.outer(ys, xs)
    return weight / weight.sum()


def _block_displacements(prev: np.ndarray, cur: np.ndarray,
                         block: int, search: int) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Per-block best displacement (dx, dy) and its SAD.

    Blocks are inset by `search` pixels on every side so every candidate
    window stays inside the frame. That also throws away the border, which
    is where rolling-shutter and crop artifacts live — a feature here.
    """
    h, w = prev.shape
    bh = (h - 2 * search) // block
    bw = (w - 2 * search) // block
    if bh < 3 or bw < 3:
        return None
    m = search
    cur_blocks = cur[m:m + bh * block, m:m + bw * block]
    cur_blocks = cur_blocks.reshape(bh, block, bw, block).transpose(0, 2, 1, 3)

    best_sad = np.full((bh, bw), np.inf, dtype=np.float32)
    best_dx = np.zeros((bh, bw), dtype=np.float32)
    best_dy = np.zeros((bh, bw), dtype=np.float32)

    for dy in range(-search, search + 1):
        row0 = m + dy
        for dx in range(-search, search + 1):
            col0 = m + dx
            cand = prev[row0:row0 + bh * block, col0:col0 + bw * block]
            cand = cand.reshape(bh, block, bw, block).transpose(0, 2, 1, 3)
            sad = np.abs(cand - cur_blocks).sum(axis=(2, 3), dtype=np.float32)
            better = sad < best_sad
            best_sad = np.where(better, sad, best_sad)
            best_dx = np.where(better, float(dx), best_dx)
            best_dy = np.where(better, float(dy), best_dy)
    return best_dx, best_dy, best_sad


def _expansion_signal(best_dx: np.ndarray, best_dy: np.ndarray, best_sad: np.ndarray) -> float:
    """Signed expansion(+)/contraction(-) of the frame around its center of
    motion — the Funscript-Flow idea, in numpy.

    The center of motion is the block with the strongest divergence (local
    expansion or contraction). Projecting every other block's displacement
    onto the center->block vector, summed with equal weight on all sides,
    measures how much the frame is breathing outward or inward around that
    point. Equal weighting of left/right and above/below is what keeps a
    translating camera (pure shake, no expansion) near zero: those blocks
    cancel.
    """
    bh, bw = best_dx.shape
    # Divergence of the displacement field (np.gradient handles the edges).
    ddx = np.gradient(best_dx, axis=1)
    ddy = np.gradient(best_dy, axis=0)
    div = ddx + ddy
    # Smooth so a single noisy block doesn't win the center vote.
    smoothed = np.convolve(div.reshape(-1), np.ones(3) / 3.0, mode="same").reshape(bh, bw)
    center_index = int(np.argmax(np.abs(smoothed)))
    cy, cx = divmod(center_index, bw)

    cols = np.arange(bw, dtype=np.float32) - float(cx)
    rows = np.arange(bh, dtype=np.float32) - float(cy)
    # Full-shape so boolean indexing with `valid` lines up below.
    vx = np.broadcast_to(cols[None, :], (bh, bw))
    vy = np.broadcast_to(rows[:, None], (bh, bw))
    norm = np.sqrt(vx * vx + vy * vy)
    valid = norm > 0
    # Blocks whose best match is terrible (occlusion, cut, new object) are
    # excluded rather than trusted with a bogus displacement.
    sad_ref = float(np.median(best_sad)) + 1.0
    valid &= best_sad < max(8.0 * sad_ref, 4.0)

    score = np.zeros_like(best_dx)
    score[valid] = ((best_dx[valid] * vx[valid] + best_dy[valid] * vy[valid]) / norm[valid])
    count = int(valid.sum())
    if count == 0:
        return 0.0
    return float(score.sum() / count)


def _moving_median(values: np.ndarray, window: int) -> np.ndarray:
    window = max(1, window)
    pad = window // 2
    padded = np.pad(values, pad, mode="edge")
    stacked = np.lib.stride_tricks.sliding_window_view(padded, window)
    return np.median(stacked, axis=1)[:len(values)]


def _idle_windows_from_flags(flags: np.ndarray, fps: float) -> list[tuple[float, float]]:
    """Group True runs of `flags` into (start_ms, end_ms) idle windows."""
    windows: list[tuple[int, int]] = []
    start: int | None = None
    for i, flag in enumerate(flags):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            if (i - start) / fps >= IDLE_WINDOW_S:
                windows.append((start, i))
            start = None
    if start is not None and (len(flags) - start) / fps >= IDLE_WINDOW_S:
        windows.append((start, len(flags)))
    merged: list[tuple[int, int]] = []
    for s, e in windows:
        if merged and s - merged[-1][1] < fps:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return [(s / fps * 1000.0, e / fps * 1000.0) for s, e in merged]


def _pick_peaks(env: np.ndarray, fps: float, sensitivity: float) -> list[int]:
    """Local maxima of the motion envelope that stand out from the clip.

    A mean + k*std threshold — the right tool for sparse audio onsets — fails
    here: video motion is often periodic (a repeating stroke in the source),
    and then the "spikes" make up most of the signal, so the local std swallows
    every peak. Instead compare candidates against the clip's own quiet floor:
    the envelope's 20th percentile is the baseline, the 95th is the loudest
    motion, and sensitivity scales the fraction of that dynamic range a peak
    has to clear (higher sensitivity -> lower threshold -> more events).
    """
    n = len(env)
    if n == 0:
        return []
    smoothed = np.convolve(env, np.ones(3, dtype=np.float32) / 3.0, mode="same")
    baseline = float(np.percentile(smoothed, 20))
    dynamic = float(np.percentile(smoothed, 95)) - baseline
    frac = 0.5 / max(0.25, float(sensitivity))
    # The floor keeps sensor/demux noise in a still frame out of the script.
    threshold = max(baseline + frac * dynamic, STATIC_DIFF)
    min_gap = max(1, int(round(MIN_EVENT_GAP_MS / 1000.0 * fps)))
    peaks: list[int] = []
    last = -10 ** 9
    for i in range(1, n - 1):
        if smoothed[i] >= threshold and smoothed[i] >= smoothed[i - 1] and smoothed[i] > smoothed[i + 1]:
            if i - last >= min_gap:
                peaks.append(i)
                last = i
    return peaks


def analyze_motion(video_path: str,
                   start_ms: float | None = None,
                   end_ms: float | None = None,
                   *,
                   quality: str = "standard",
                   engine: str | None = None,
                   fps: float | None = None,
                   width: int | None = None,
                   height: int | None = None,
                   crop_vr: bool = True,
                   progress_cb: Callable[[float], None] | None = None,
                   cancel_cb: Callable[[], bool] | None = None) -> dict[str, Any]:
    """Generate the raw material for a funscript from what the video *does*.

    Returns, with absolute ms on the video timeline:
        v1: {"engine": "v1", "events": [(at_ms, strength)], "idle_windows": [...], "cuts": [...]}
        v2: {"engine": "v2", "signal": [(at_ms, -1..1)], "idle_windows": [...], "cuts": [...]}
    Raises:
        GenerateError: noFfmpeg / noVideo / badRange / cancelled / failed
    """
    if start_ms is not None and end_ms is not None and end_ms <= start_ms:
        raise GenerateError("badRange", "Selection range is empty")
    preset = QUALITY_PRESETS.get(quality, QUALITY_PRESETS["standard"])
    engine = engine or preset["engine"]
    if engine not in ("v1", "v2"):
        raise GenerateError("badRange", f"Unknown motion engine: {engine}")
    fps = float(fps or preset["fps"])
    width = int(width or preset["width"])
    height = int(height or preset["height"])

    stream = _require_video_stream(video_path)
    src_w = int(stream.get("width") or 0)
    src_h = int(stream.get("height") or 0)

    crop = None
    if crop_vr and src_w and src_h:
        crop = detect_vr_crop(stream, src_w, src_h)

    filters = []
    if crop:
        x, y, w, h = crop
        filters.append(f"crop={w}:{h}:{x}:{y}")
    filters.append(f"fps={fps:g}")
    filters.append(f"scale={width}:{height}:flags=area")
    filters.append("format=gray")

    cmd = [FFMPEG, "-v", "error"]
    if start_ms:
        cmd += ["-ss", f"{start_ms / 1000.0:.3f}"]
    if end_ms is not None:
        cmd += ["-to", f"{end_ms / 1000.0:.3f}"]
    cmd += ["-i", video_path, "-vf", ",".join(filters), "-f", "rawvideo", "-pix_fmt", "gray", "-"]

    try:
        proc = run_silent_stream(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 bufsize=width * height * 8)
    except FileNotFoundError as exc:
        raise GenerateError("noFfmpeg", "ffmpeg not found") from exc

    frame_bytes = width * height
    offset_ms = start_ms or 0.0
    expected_frames = None
    if end_ms is not None:
        expected_frames = max(1, int((end_ms - (start_ms or 0)) / 1000.0 * fps))

    energies: list[float] = []
    signals: list[float] = []
    cut_flags: list[bool] = []
    static_flags: list[bool] = []
    prev: np.ndarray | None = None
    settle = 0
    recent_mads: list[float] = []
    index = 0
    buffer = b""
    # Constant for a given resolution: computed once, not per frame.
    weight = _center_weight(height, width)

    try:
        while True:
            if cancel_cb and cancel_cb():
                _terminate(proc)
                raise GenerateError("cancelled", "Generation cancelled")
            need = frame_bytes - len(buffer)
            block = proc.stdout.read(need)
            if not block:
                break
            buffer += block
            while len(buffer) >= frame_bytes:
                raw, buffer = buffer[:frame_bytes], buffer[frame_bytes:]
                frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width).astype(np.float32) / 255.0
                index += 1
                if prev is None:
                    prev = frame
                    continue

                diff = np.abs(frame - prev)
                mad = float(diff.mean())
                median = float(np.median(recent_mads)) if len(recent_mads) >= 8 else 0.0
                is_cut = mad > CUT_ABS or (median > 0.004 and mad > CUT_RATIO * median)
                cut_flags.append(is_cut)
                static_flags.append(mad < STATIC_DIFF)
                recent_mads.append(mad)
                if len(recent_mads) > CUT_MEDIAN_WINDOW:
                    recent_mads.pop(0)

                if is_cut:
                    settle = CUT_SETTLE_FRAMES
                    prev = frame
                    energies.append(0.0)
                    signals.append(0.0)
                    continue
                if settle > 0:
                    settle -= 1
                    prev = frame
                    energies.append(0.0)
                    signals.append(0.0)
                    continue

                if engine == "v1":
                    energies.append(float((diff * weight).sum()))
                    signals.append(0.0)
                else:
                    matched = _block_displacements(prev, frame, BLOCK_SIZE, SEARCH_RANGE)
                    if matched is None:
                        energies.append(float((diff * weight).sum()))
                        signals.append(0.0)
                    else:
                        dx, dy, sad = matched
                        signals.append(_expansion_signal(dx, dy, sad))
                        energies.append(float((diff * weight).sum()))
                prev = frame

                if expected_frames and progress_cb:
                    progress_cb(min(0.9, index / expected_frames))
                # Keep /health answering; see tests/test_backend_responsiveness.py.
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
        if code not in (0, None) and index == 0:
            raise GenerateError("failed", f"ffmpeg frame extraction failed: {stderr.decode('utf-8', 'replace')[:400]}")

    if index < 3:
        raise GenerateError("noVideo", "Video produced too few decodable frames")

    idle = _idle_windows_from_flags(np.array(static_flags, dtype=bool), fps)
    idle_abs = [(s + offset_ms, e + offset_ms) for s, e in idle]
    cuts = [offset_ms + i / fps * 1000.0 for i, flag in enumerate(cut_flags) if flag]

    def frame_ms(i: int) -> float:
        # energies/signals[i] describes the transition INTO frame i+1.
        return offset_ms + (i + 1) / fps * 1000.0

    result: dict[str, Any] = {
        "engine": engine,
        "fps": fps,
        "idle_windows": idle_abs,
        "cuts": cuts,
        "vr_crop": crop,
    }

    if engine == "v1":
        env = np.asarray(energies, dtype=np.float64)
        peaks = _pick_peaks(env, fps, EVENT_SENSITIVITY)
        ref = float(np.percentile(env, 95)) if env.size else 0.0
        events: list[tuple[float, float]] = []
        for i in peaks:
            t = frame_ms(i)
            if any(s <= t <= e for s, e in idle_abs):
                continue
            strength = 0.05 if ref <= 0 else max(0.05, min(1.0, env[i] / ref))
            events.append((t, float(strength)))
        result["events"] = events
    else:
        raw = np.asarray(signals, dtype=np.float64)
        # Integrate the expansion/contraction rate into a position, resetting
        # at every cut so a hard edit can't drag the stroke to an endstop.
        position = np.zeros_like(raw)
        acc = 0.0
        for i, value in enumerate(raw):
            if cut_flags[i]:
                acc = 0.0
            acc += value / fps
            position[i] = acc
        # The integral drifts (a slow zoom, a bias in the field); a moving
        # median removes that while keeping the stroke oscillation.
        detrended = position - _moving_median(position, int(DETREND_WINDOW_S * fps))
        scale = float(np.percentile(np.abs(detrended), 98)) if detrended.size else 0.0
        if scale <= 1e-6:
            scale = float(np.max(np.abs(detrended))) or 1.0
        normalized = np.clip(detrended / scale, -1.0, 1.0)
        result["signal"] = [(frame_ms(i), float(normalized[i])) for i in range(len(normalized))]

    if progress_cb:
        progress_cb(1.0)
    return result


def _terminate(proc: subprocess.Popen) -> None:
    try:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    except OSError:
        pass
