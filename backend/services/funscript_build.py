"""Funscript post-processing shared by both generation engines.

The engines (services/audio_analysis.py, services/motion_analysis.py)
only produce *raw material*:

  * stroke events  — (time_ms, strength 0..1)   from the audio engine
  * a signed signal — (time_ms, value -1..1)    from the motion engine

Everything that decides what the device actually does lives here, so an
audio script and a motion script obey the same rules and the same device
limits. The pipeline is:

  raw material -> stroke actions (style) -> keyframe reduction
               -> idle/pause segments -> min-interval / dedupe
               -> speed limiter -> action cap -> funscript dict

The speed limiter is the piece that keeps generated scripts usable on
real hardware. A Handy moves a fixed maximum number of units per second
(1 unit = one step of the 0..100 stroke), so a script that asks for more
than that is not "faster", it is a device that lags behind the video.
The limiter walks the points in time order and pulls each point's
position toward the previous one until the move fits the limit — the
same approach ScriptCompiler's speed limiter takes.

numpy is deliberately NOT imported here: this module runs on every
generation but the engines are the only heavy users, and keeping the
import cost out of the shared path keeps backend startup untouched.
"""

from __future__ import annotations

import json
import math
from typing import Any, Iterable, Sequence

from services.funscript import parse_funscript

# Handy stroke speeds in funscript units/second (1 unit = one step of the
# 0..100 range, so 0->100 in 250 ms is exactly 400 units/s on a Handy 1).
# Values from ScriptCompiler's device table (scriptcompiler.com/help/
# devices/the-handy/).
DEVICE_SPEED_LIMITS: dict[str, int] = {
    "handy": 400,
    "handy2": 320,
    "handy2pro": 360,
    "handy2pro_oc": 640,
}
DEFAULT_DEVICE = "handy"

# Two consecutive actions closer together than this are physically
# pointless (the device cannot reverse direction that fast) and they
# inflate the CSV the Handy has to fetch.
DEFAULT_MIN_INTERVAL_MS = 120

# Douglas-Peucker tolerance, in funscript units. 2 units is below the
# resolution of a 0..100 stroke on any current device, so it removes
# wobble without flattening the shape.
DEFAULT_REDUCE_TOLERANCE = 2.0

# Ceiling on action density. Handy fetches the script as a CSV capped at
# 512 KiB (routes/scripts.py), and 10 actions/second is already faster
# than any device can follow.
MAX_ACTIONS_PER_SECOND = 10

STYLES = ("alternating", "sine", "energy")


class BuildError(ValueError):
    """Raised for impossible generation parameters (bad range, bad style)."""


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------

def clamp_pos(value: float, min_pos: int, max_pos: int) -> int:
    """Round to an int action position, clamped to the script range and to
    the 0..100 range the Handy CSV export assumes."""
    lo = min(min_pos, max_pos)
    hi = max(min_pos, max_pos)
    lo = max(0, lo)
    hi = min(100, hi)
    return int(round(max(lo, min(hi, value))))


def _validate_range(min_pos: int, max_pos: int) -> None:
    try:
        lo = int(min_pos)
        hi = int(max_pos)
    except (TypeError, ValueError) as exc:
        raise BuildError(f"Invalid position range: {min_pos!r}..{max_pos!r}") from exc
    if not (0 <= lo <= hi <= 100):
        raise BuildError(f"Invalid position range: {lo}..{hi} (need 0 <= min <= max <= 100)")


def speed_limit_for(device: str | None, override: int | None = None) -> int | None:
    """Units/second for a device name, or an explicit override. None/'' means
    'no limit' (useful for tests and for users who want raw output)."""
    if override is not None:
        try:
            limit = int(override)
        except (TypeError, ValueError) as exc:
            raise BuildError(f"Invalid speed limit: {override!r}") from exc
        return limit if limit > 0 else None
    if not device:
        return None
    key = str(device).strip().lower().replace(" ", "").replace("-", "").replace("_", "")
    if key in ("", "none", "off", "unlimited"):
        return None
    aliases = {
        "handy": "handy",
        "handy1": "handy",
        "handy2": "handy2",
        "handy2pro": "handy2pro",
        "handy2prooverclock": "handy2pro_oc",
        "handy2prooc": "handy2pro_oc",
    }
    if key not in aliases:
        raise BuildError(f"Unknown device: {device!r}")
    return DEVICE_SPEED_LIMITS[aliases[key]]


# ---------------------------------------------------------------------------
# raw material -> stroke actions
# ---------------------------------------------------------------------------

def events_to_actions(
    events: Sequence[tuple[float, float]],
    *,
    style: str = "alternating",
    min_pos: int = 0,
    max_pos: int = 100,
) -> list[dict[str, Any]]:
    """Turn (time_ms, strength 0..1) stroke events into actions.

    alternating — one action per event, swinging between the low and high
        end. This is the classic "one beat, one half stroke" script and
        what the renderer's own beat generator produces.
    sine        — one full stroke per event: leave the low end, reach the
        strength-scaled peak a quarter of the way to the next event, come
        back. Smoother, half the stroke rate.
    energy      — position follows strength directly. Used for the motion
        engine's signed signal, where the value itself is the position.
    """
    _validate_range(min_pos, max_pos)
    if style not in STYLES:
        raise BuildError(f"Unknown style: {style!r} (need one of {', '.join(STYLES)})")

    ordered = sorted(((float(t), float(s)) for t, s in events), key=lambda e: e[0])
    span = max_pos - min_pos
    actions: list[dict[str, Any]] = []

    if style == "energy":
        for t, strength in ordered:
            value = min(1.0, max(0.0, strength))
            actions.append({"at": int(round(t)), "pos": clamp_pos(min_pos + span * value, min_pos, max_pos)})
        return actions

    if style == "alternating":
        high = max_pos
        low = min_pos
        for i, (t, strength) in enumerate(ordered):
            amp = min(1.0, max(0.0, strength))
            if i % 2 == 0:
                actions.append({"at": int(round(t)), "pos": clamp_pos(high, min_pos, max_pos)})
            else:
                # A weak beat should not swing the device all the way to the
                # far end: scale the return toward the middle by its strength.
                target = low + (high - low) * (1.0 - amp)
                actions.append({"at": int(round(t)), "pos": clamp_pos(target, min_pos, max_pos)})
        return actions

    # sine: full stroke per event.
    for i, (t, strength) in enumerate(ordered):
        amp = min(1.0, max(0.0, strength))
        nxt = ordered[i + 1][0] if i + 1 < len(ordered) else t + (t - ordered[i - 1][0] if i else 500.0)
        quarter = t + max(40.0, (nxt - t) / 4.0)
        peak = min_pos + span * amp
        actions.append({"at": int(round(quarter)), "pos": clamp_pos(peak, min_pos, max_pos)})
        actions.append({"at": int(round(nxt)), "pos": clamp_pos(min_pos, min_pos, max_pos)})
    return actions


def signal_to_actions(
    samples: Sequence[tuple[float, float]],
    *,
    min_pos: int = 0,
    max_pos: int = 100,
) -> list[dict[str, Any]]:
    """Turn a signed signal (time_ms, value -1..1) into actions that follow
    it directly — the motion engine's integrated expansion/contraction
    curve. Every sample becomes a point; reduction trims it afterwards."""
    _validate_range(min_pos, max_pos)
    actions = []
    for t, value in samples:
        v = min(1.0, max(-1.0, float(value)))
        pos = min_pos + (max_pos - min_pos) * (v + 1.0) / 2.0
        actions.append({"at": int(round(t)), "pos": clamp_pos(pos, min_pos, max_pos)})
    actions.sort(key=lambda a: a["at"])
    return actions


# ---------------------------------------------------------------------------
# keyframe reduction
# ---------------------------------------------------------------------------

def _douglas_peucker(points: list[tuple[float, int]], tolerance: float) -> list[tuple[float, int]]:
    """Polyline simplification. Distance is measured in position units
    against the straight line between the segment ends, so `tolerance` is
    literally "how many units of stroke may be lost"."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        t0, p0 = points[start]
        t1, p1 = points[end]
        span = t1 - t0
        if span <= 0:
            stack.append((start, start + 1))
            stack.append((end - 1, end))
            continue
        worst = -1.0
        worst_idx = -1
        for i in range(start + 1, end):
            t, p = points[i]
            expected = p0 + (p1 - p0) * ((t - t0) / span)
            d = abs(p - expected)
            if d > worst:
                worst = d
                worst_idx = i
        if worst > tolerance and worst_idx > 0:
            keep[worst_idx] = True
            stack.append((start, worst_idx))
            stack.append((worst_idx, end))
    return [p for p, k in zip(points, keep) if k]


def reduce_keyframes(actions: list[dict[str, Any]], tolerance: float = DEFAULT_REDUCE_TOLERANCE) -> list[dict[str, Any]]:
    """Drop points the device does not need: collinear wobble via
    Douglas-Peucker, then re-add any local extremum the simplification
    clipped (an extremum is where the stroke actually turns around, so it
    is never expendable)."""
    if len(actions) < 3 or tolerance <= 0:
        return actions
    points = [(float(a["at"]), int(a["pos"])) for a in actions]
    kept = _douglas_peucker(points, tolerance)
    extrema = set()
    for i in range(1, len(points) - 1):
        prev, cur, nxt = points[i - 1][1], points[i][1], points[i + 1][1]
        if (cur > prev and cur > nxt) or (cur < prev and cur < nxt):
            extrema.add(i)
    kept_set = {p for p in kept}
    merged = sorted(kept_set | {points[i] for i in extrema})
    return [{"at": int(t), "pos": int(p)} for t, p in merged]


# ---------------------------------------------------------------------------
# idle / pause segments
# ---------------------------------------------------------------------------

def apply_idle_segments(
    actions: list[dict[str, Any]],
    idle_windows: Sequence[tuple[float, float]],
    *,
    min_pos: int = 0,
    max_pos: int = 100,
    hold_pos: int | None = None,
) -> list[dict[str, Any]]:
    """Park the device during silent / motionless stretches.

    A script that keeps stroking through a silent gap feels wrong on the
    device and is the single most common complaint about auto-generated
    scripts (the Funscript Flow generator has exactly this flaw — every
    frame is motion, so there is no rest). Here each idle window drops the
    actions inside it and gets a flat hold instead.
    """
    if not idle_windows:
        return actions
    park = clamp_pos(min_pos if hold_pos is None else hold_pos, min_pos, max_pos)
    result: list[dict[str, Any]] = []
    windows = sorted((float(s), float(e)) for s, e in idle_windows if e > s)
    idx = 0
    for start, end in windows:
        while idx < len(actions) and actions[idx]["at"] < start:
            result.append(actions[idx])
            idx += 1
        # Drop everything that falls inside the window.
        while idx < len(actions) and actions[idx]["at"] <= end:
            idx += 1
        result.append({"at": int(round(start)), "pos": park})
        result.append({"at": int(round(end)), "pos": park})
    while idx < len(actions):
        result.append(actions[idx])
        idx += 1
    result.sort(key=lambda a: a["at"])
    return result


# ---------------------------------------------------------------------------
# min interval, speed limiter, cap
# ---------------------------------------------------------------------------

def enforce_min_interval(actions: list[dict[str, Any]], min_interval_ms: int = DEFAULT_MIN_INTERVAL_MS) -> list[dict[str, Any]]:
    """Sort, drop same-millisecond duplicates, and thin out points closer
    together than min_interval_ms (keeping the more extreme one)."""
    if not actions:
        return []
    ordered = sorted(actions, key=lambda a: (int(a["at"]), int(a["pos"])))
    deduped: list[dict[str, Any]] = []
    for action in ordered:
        if deduped and deduped[-1]["at"] == action["at"]:
            if abs(action["pos"] - 50) > abs(deduped[-1]["pos"] - 50):
                deduped[-1] = action
            continue
        deduped.append(action)
    if min_interval_ms <= 0:
        return deduped
    out: list[dict[str, Any]] = []
    for action in deduped:
        if out and action["at"] - out[-1]["at"] < min_interval_ms:
            prev = out[-1]
            if abs(action["pos"] - prev["pos"]) > abs(prev["pos"] - 50):
                out[-1] = action
            continue
        out.append(action)
    return out


def limit_speed(actions: list[dict[str, Any]], limit_units_per_s: int | None) -> list[dict[str, Any]]:
    """Pull each point's position toward the previous one until the move
    fits the device's units/second budget.

    Walk in time order: max travel between two points is
    limit * dt. Anything beyond that is clamped onto the reachable
    position. Because the walk is sequential, a long impossible stretch
    (e.g. 0 -> 100 in 100 ms) is spread over the following points instead
    of producing one unachievable jump.
    """
    if not limit_units_per_s or limit_units_per_s <= 0 or len(actions) < 2:
        return actions
    limited = [dict(actions[0])]
    for action in actions[1:]:
        prev = limited[-1]
        dt_s = (action["at"] - prev["at"]) / 1000.0
        if dt_s <= 0:
            limited.append({"at": prev["at"], "pos": prev["pos"]})
            continue
        max_travel = limit_units_per_s * dt_s
        delta = action["pos"] - prev["pos"]
        pos = action["pos"]
        if abs(delta) > max_travel:
            pos = prev["pos"] + math.copysign(max_travel, delta)
        limited.append({"at": action["at"], "pos": int(round(pos))})
    return limited


def cap_actions(actions: list[dict[str, Any]], start_ms: float, end_ms: float) -> list[dict[str, Any]]:
    """Hard ceiling on density, so the Handy CSV stays inside its 512 KiB
    budget even for a long generation."""
    cap = int(MAX_ACTIONS_PER_SECOND * max(1.0, (end_ms - start_ms) / 1000.0))
    if cap <= 0 or len(actions) <= cap:
        return actions
    # Keep the most "interesting" points: the ones furthest from rest.
    ranked = sorted(actions, key=lambda a: abs(int(a["pos"]) - 50), reverse=True)[:cap]
    ranked.sort(key=lambda a: a["at"])
    return ranked


# ---------------------------------------------------------------------------
# top level
# ---------------------------------------------------------------------------

def finalize_actions(
    actions: list[dict[str, Any]],
    *,
    start_ms: float = 0.0,
    end_ms: float | None = None,
    min_pos: int = 0,
    max_pos: int = 100,
    min_interval_ms: int = DEFAULT_MIN_INTERVAL_MS,
    speed_limit: int | None = DEVICE_SPEED_LIMITS[DEFAULT_DEVICE],
    reduce_tolerance: float = DEFAULT_REDUCE_TOLERANCE,
    idle_windows: Sequence[tuple[float, float]] | None = None,
) -> list[dict[str, Any]]:
    """Run the shared post-processing chain over raw actions."""
    _validate_range(min_pos, max_pos)
    result = [
        {"at": int(a["at"]), "pos": clamp_pos(a["pos"], min_pos, max_pos)}
        for a in actions
    ]
    result = apply_idle_segments(result, idle_windows or [], min_pos=min_pos, max_pos=max_pos)
    result = enforce_min_interval(result, min_interval_ms)
    result = limit_speed(result, speed_limit)
    result = reduce_keyframes(result, reduce_tolerance)
    result = enforce_min_interval(result, min_interval_ms)
    if end_ms is not None:
        result = cap_actions(result, start_ms, end_ms)
    return result


def to_funscript(actions: list[dict[str, Any]], *, inverted: bool = False, range_: int = 100) -> dict[str, Any]:
    """Wrap actions in a funscript document and validate it by round-tripping
    through the same parser the Handy CSV converter uses — a script that
    would 400 at convert time must never reach the user's library."""
    script = {
        # String "1.0", the form the renderer writes and the wider funscript
        # ecosystem uses — keep the two ends of the app in agreement.
        "version": "1.0",
        "inverted": bool(inverted),
        "range": int(range_),
        "actions": [{"at": int(a["at"]), "pos": int(a["pos"])} for a in actions],
    }
    parse_funscript(json.dumps(script))
    return script


def build_funscript(
    raw: Sequence[dict[str, Any]],
    *,
    start_ms: float = 0.0,
    end_ms: float | None = None,
    min_pos: int = 0,
    max_pos: int = 100,
    min_interval_ms: int = DEFAULT_MIN_INTERVAL_MS,
    speed_limit: int | None = DEVICE_SPEED_LIMITS[DEFAULT_DEVICE],
    reduce_tolerance: float = DEFAULT_REDUCE_TOLERANCE,
    idle_windows: Sequence[tuple[float, float]] | None = None,
    inverted: bool = False,
) -> dict[str, Any]:
    """Convenience wrapper: finalized actions -> validated funscript."""
    actions = finalize_actions(
        raw,
        start_ms=start_ms,
        end_ms=end_ms,
        min_pos=min_pos,
        max_pos=max_pos,
        min_interval_ms=min_interval_ms,
        speed_limit=speed_limit,
        reduce_tolerance=reduce_tolerance,
        idle_windows=idle_windows,
    )
    return to_funscript(actions, inverted=inverted, range_=max_pos)
