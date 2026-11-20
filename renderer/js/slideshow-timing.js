/**
 * Slideshow timing — pure functions, no DOM.
 *
 * Photo-switch timing is a direct port of rhythmslide's
 * `rhythmslide/core/funscript.py` (© electrist9, GPL-3.0) so both apps derive
 * identical switch points from the same funscript. Switch times are returned
 * in SECONDS (ascending, strictly increasing), matching the reference — the
 * player compares them against `video.currentTime` directly.
 *
 * The wipe rectangle math is a port of `rhythmslide/ui/videowipe.py`'s
 * `wipe_geometry()` (same license/attribution).
 */

/** Switch-timing derivation modes (must match the settings-panel options). */
export const FUNSCRIPT_MODES = ['up', 'peak', 'cumulative'];

/** Photo cycling orders inside a preset (orthogonal to image-list order). */
export const PHOTO_ORDERS = ['forward', 'pingpong'];

/** Image-list ordering modes, chosen in the player (global setting). */
export const IMAGE_ORDERS = ['name', 'random'];

/** Built-in fallback preset (rhythmslide defaults: up / 0 / 100 / forward). */
export const BUILTIN_PRESET = Object.freeze({
  name: '',
  mode: 'up',
  threshold: 0,
  step: 100,
  order: 'forward',
});

/**
 * Build one named switch-rule preset. Port of funscript.py `make_preset`.
 */
export function makePreset(name, mode, threshold, step, order) {
  return {
    name: String(name ?? '').trim(),
    mode,
    threshold: Number(threshold),
    step: Number(step),
    order,
  };
}

/**
 * Validate/normalize a stored preset array (config back-compat).
 * Port of funscript.py `sanitize_presets`: non-dict entries dropped, names
 * trimmed/non-empty/first-wins on duplicates, unknown mode/order → defaults,
 * threshold clamped ≥ 0, step clamped > 0 (invalid → default).
 */
export function sanitizePresets(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = String(item.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    let mode = String(item.mode ?? 'up');
    if (!FUNSCRIPT_MODES.includes(mode)) mode = 'up';
    let thr = Number(item.threshold ?? 0);
    if (!Number.isFinite(thr)) thr = 0;
    if (thr < 0) thr = 0;
    let stp = Number(item.step ?? 100);
    if (!Number.isFinite(stp)) stp = 100;
    if (stp <= 0) stp = 100;
    let order = String(item.order ?? 'forward');
    if (!PHOTO_ORDERS.includes(order)) order = 'forward';
    seen.add(name);
    out.push({ name, mode, threshold: thr, step: stp, order });
  }
  return out;
}

/**
 * Resolve the preset to use at slideshow start: exact name match → first
 * preset → built-in default. Never returns null.
 */
export function resolvePreset(presets, defaultName) {
  const list = sanitizePresets(presets);
  const name = String(defaultName ?? '').trim();
  if (name) {
    const hit = list.find((p) => p.name === name);
    if (hit) return hit;
  }
  return list[0] || { ...BUILTIN_PRESET };
}

/**
 * Normalize an action array to `[at, pos]` points sorted by `at`.
 * Port of funscript.py `_parse_points` — unreadable entries (non-object,
 * non-numeric at/pos) are skipped. FunscriptEngine already normalizes to
 * `{at, pos}`, but we stay defensive like the reference.
 */
export function parsePoints(actions) {
  const pts = [];
  if (!Array.isArray(actions)) return pts;
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const at = Number(a.at);
    const pos = Number(a.pos);
    if (!Number.isFinite(at) || !Number.isFinite(pos)) continue;
    pts.push([at, pos]);
  }
  pts.sort((x, y) => x[0] - y[0]);
  return pts;
}

/** Merge duplicate `at` values while appending (port of `_append_switch`). */
function appendSwitch(out, t) {
  if (out.length === 0 || t > out[out.length - 1] + 1e-9) out.push(t);
}

/** Switch on upward moves (diff > thr). Port of `_switches_up`. */
function switchesUp(pts, thr) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][1] - pts[i - 1][1] > thr) appendSwitch(out, pts[i][0] / 1000);
  }
  return out;
}

/** Switch on local extrema (both rise and fall peaks). Port of `_switches_peak`. */
function switchesPeak(pts, thr) {
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1][1];
    const cur = pts[i][1];
    const nxt = pts[i + 1][1];
    const rise = cur - prev;
    const fall = cur - nxt;
    // Local maximum: prominence = min(rise, fall)
    if (cur >= prev && cur >= nxt && Math.min(rise, fall) > thr) {
      appendSwitch(out, pts[i][0] / 1000);
    // Local minimum: prominence = min(-rise, -fall)
    } else if (cur <= prev && cur <= nxt && Math.min(-rise, -fall) > thr) {
      appendSwitch(out, pts[i][0] / 1000);
    }
  }
  return out;
}

/** Switch every time accumulated |Δpos| reaches `step`. Port of `_switches_cumulative`. */
function switchesCumulative(pts, thr, step) {
  const out = [];
  if (step <= 0) return out;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.abs(pts[i][1] - pts[i - 1][1]);
    if (d <= thr) continue; // jitter/noise is not accumulated
    acc += d;
    while (acc >= step) {
      acc -= step;
      appendSwitch(out, pts[i][0] / 1000);
    }
  }
  return out;
}

/**
 * Derive photo-switch times (seconds, ascending) from an action array.
 * Port of funscript.py `switch_times`. The first action is never a switch
 * point (the first photo shows from t=0). `preset` supplies
 * `{ mode, threshold, step }` (missing fields fall back to defaults).
 */
export function computeSwitchTimes(actions, preset = {}) {
  const pts = parsePoints(actions);
  if (pts.length < 2) return [];
  const rawThr = Number(preset.threshold ?? 0);
  const thr = Number.isFinite(rawThr) && rawThr > 0 ? rawThr : 0;
  const mode = FUNSCRIPT_MODES.includes(preset.mode) ? preset.mode : 'up';
  if (mode === 'peak') return switchesPeak(pts, thr);
  if (mode === 'cumulative') {
    let step = Number(preset.step ?? 100);
    if (!Number.isFinite(step)) step = 100;
    return switchesCumulative(pts, thr, step);
  }
  return switchesUp(pts, thr);
}

/**
 * Photo index for the Nth switch (0-based ordinal) over `count` photos.
 * forward = wrap-around; pingpong = triangle wave. Returns -1 when count ≤ 0.
 */
export function photoIndexAt(count, order, switchOrdinal) {
  if (count <= 0) return -1;
  if (order === 'pingpong' && count > 1) {
    const period = 2 * (count - 1);
    let m = switchOrdinal % period;
    if (m < 0) m += period;
    return m < count ? m : period - m;
  }
  let m = switchOrdinal % count;
  if (m < 0) m += count;
  return m;
}

/** Natural (numeric-aware, case-insensitive) compare of two strings. */
export function naturalCompare(a, b) {
  const ax = String(a);
  const bx = String(b);
  const re = /(\d+)|(\D+)/g;
  const at = ax.match(re) || [];
  const bt = bx.match(re) || [];
  for (let i = 0; i < at.length || i < bt.length; i++) {
    const x = at[i];
    const y = bt[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = Number(x);
    const yn = Number(y);
    if (Number.isFinite(xn) && Number.isFinite(yn)) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else {
      const xl = x.toLowerCase();
      const yl = y.toLowerCase();
      if (xl !== yl) return xl < yl ? -1 : 1;
    }
  }
  return 0;
}

/** Basename of a path (handles both / and \ separators). */
function baseName(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Arrange the image list before playback:
 *  - 'name'   → natural sort by file name (basename), stable
 *  - 'random' → Fisher-Yates shuffle (injectable rng for deterministic tests)
 * Returns a permutation of the input; the input array is not mutated.
 */
export function arrangeImages(paths, mode, rng = Math.random) {
  const list = Array.isArray(paths) ? paths.slice() : [];
  if (mode === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor((Number(rng()) || 0) * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }
  return list.sort((a, b) => naturalCompare(baseName(a), baseName(b)));
}

/** Wipe margin against the display edge (px). Port of videowipe.py WIPE_MARGIN_PX. */
export const WIPE_MARGIN_PX = 16;

/** Fallback area denominator when size is invalid (= 1/8). */
export const DEFAULT_WIPE_SIZE_DENOM = 8;

/**
 * Wipe rectangle {x, y, w, h} inside a parent area, preserving the video's
 * aspect ratio. Port of videowipe.py `wipe_geometry`: the bounding box is
 * 1/sizeDenom of the (margin-inset) display area with each side scaled by
 * 1/√denom; unknown video size uses the box as-is; invalid corner behaves as
 * bottom_right.
 */
export function wipeGeometry(parentW, parentH, videoW, videoH, corner, margin = WIPE_MARGIN_PX, sizeDenom = DEFAULT_WIPE_SIZE_DENOM) {
  if (parentW <= 0 || parentH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const availW = Math.max(1, parentW - 2 * margin);
  const availH = Math.max(1, parentH - 2 * margin);
  const denom = sizeDenom > 0 ? sizeDenom : DEFAULT_WIPE_SIZE_DENOM;
  const side = Math.sqrt(denom); // area 1/denom = side 1/√denom
  const boxW = availW / side;
  const boxH = availH / side;
  let w;
  let h;
  if (videoW > 0 && videoH > 0) {
    const scale = Math.min(boxW / videoW, boxH / videoH);
    w = Math.max(1, Math.floor(videoW * scale));
    h = Math.max(1, Math.floor(videoH * scale));
  } else {
    w = Math.floor(boxW);
    h = Math.floor(boxH);
  }
  let x;
  let y;
  if (corner === 'top_left') {
    x = margin;
    y = margin;
  } else if (corner === 'top_right') {
    x = parentW - margin - w;
    y = margin;
  } else if (corner === 'bottom_left') {
    x = margin;
    y = parentH - margin - h;
  } else {
    // bottom_right (default)
    x = parentW - margin - w;
    y = parentH - margin - h;
  }
  return { x, y, w, h };
}
