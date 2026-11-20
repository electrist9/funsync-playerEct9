/**
 * Dominant-color extraction for slideshow backgrounds — pure functions, no DOM.
 *
 * Port of rhythmslide's `rhythmslide/ui/renderer.py` `_dominant_color()`
 * (© electrist9, GPL-3.0): downscale the image (the caller draws it into a
 * ~48px canvas keeping aspect ratio), quantize each channel to 16 buckets
 * (`value >> 4`), histogram the buckets, and return the AVERAGE color of the
 * most frequent bucket as `#rrggbb`. Returns null when there are no usable
 * pixels, mirroring the reference's None so callers can fall back to a solid
 * background.
 */

/**
 * Compute the dominant color from raw RGBA pixels.
 *
 * @param {Uint8ClampedArray|Uint8Array|ArrayLike<number>} data RGBA, stride 4.
 * @param {number} width Pixel rows' width (used with height to bound the scan).
 * @param {number} height Number of rows.
 * @returns {string|null} `#rrggbb` of the most frequent 16-level bucket's
 *   average color, or null when the input is empty/invalid.
 */
export function dominantColorFromImageData(data, width, height) {
  if (!data || typeof data.length !== 'number') return null;
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const pixels = Math.min(w * h, Math.floor(data.length / 4));
  if (pixels <= 0) return null;

  // Bucket key = (r>>4, g>>4, b>>4) packed into one integer for Map speed.
  const counts = new Map();
  const sums = new Map();
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const c = counts.get(key);
    if (c === undefined) {
      counts.set(key, 1);
      sums.set(key, [r, g, b]);
    } else {
      counts.set(key, c + 1);
      const s = sums.get(key);
      s[0] += r;
      s[1] += g;
      s[2] += b;
    }
  }
  if (counts.size === 0) return null;

  // Deterministic max: first-inserted bucket wins ties (Map iterates in
  // insertion order, matching the reference's max() over dict keys).
  let bestKey = -1;
  let bestCount = 0;
  for (const [key, c] of counts) {
    if (c > bestCount) {
      bestKey = key;
      bestCount = c;
    }
  }
  const s = sums.get(bestKey);
  const n = bestCount || 1;
  const r = Math.min(255, Math.floor(s[0] / n));
  const g = Math.min(255, Math.floor(s[1] / n));
  const b = Math.min(255, Math.floor(s[2] / n));
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
