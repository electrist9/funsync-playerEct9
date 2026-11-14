// Variant selection at video load (zaikechi, EroScripts #209/#221).
//
// One pure decision: which script variant should a freshly loaded video
// start on? Index 0 is the auto-default that has already loaded; a
// return value > 0 means "switch to that variant".
//
// Precedence: the random toggle BEATS a pinned default while it's on —
// the toggle exists to inject variety, and honoring pins would silently
// exempt exactly the videos the user curated most. Turning the toggle
// off restores pinned behavior untouched.

/**
 * @param {Array<{label?: string}>} variants — resolved variant list,
 *   index 0 = the auto-default already loaded
 * @param {object} opts
 * @param {boolean} [opts.randomOn] — `player.randomVariantOnPlay`
 * @param {string|null} [opts.preferredLabel] — pinned default label, if any
 * @param {() => number} [opts.rng] — injectable RNG for tests
 * @returns {number} index to play (0 = keep the loaded default)
 */
export function pickVariantIndexOnLoad(variants, { randomOn = false, preferredLabel = null, rng = Math.random } = {}) {
  const n = Array.isArray(variants) ? variants.length : 0;
  if (n < 2) return 0;
  if (randomOn) {
    const idx = Math.floor(rng() * n);
    return Math.min(Math.max(idx, 0), n - 1); // clamp a hostile rng
  }
  if (preferredLabel) {
    const idx = variants.findIndex(v => (v?.label || '').trim() === preferredLabel.trim());
    return idx > 0 ? idx : 0; // not found / already default → keep default
  }
  return 0;
}

/**
 * Where a variant row came from, so the UI can say so out loud.
 *
 * The provenance is already in the data — auto-detected rows carry
 * `_autoDetected: true` from the scan (electron/main.js), and manual rows are
 * the entries under `settings.library.manualVariants`, which the renderer tags
 * with `_isManual` at merge time (never persisted). Nothing here is stored.
 *
 * Precedence: an explicit `_isManual` wins, because that flag is set by the
 * code that knows the row is hand-registered. In practice the two never
 * coexist — the merge dedupes by path and keeps the auto-detected row — but
 * making the tie-break explicit keeps a future caller from guessing.
 *
 * @param {object|null} v — one variant row
 * @returns {'auto'|'manual'|''} — '' when the origin is unknown, so the UI
 *   shows no chip rather than a wrong one (the synthetic "current script" row,
 *   or rows from a path that never went through the scan)
 */
export function variantOrigin(v) {
  if (!v) return '';
  if (v._isManual) return 'manual';
  if (v._autoDetected) return 'auto';
  return '';
}
