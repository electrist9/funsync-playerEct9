/**
 * Pure helpers for the WebXR VR client.
 *
 * No DOM, no THREE — deliberately free of browser dependencies so the logic
 * (time formatting, list filtering/paging, UI hit-testing) is unit-testable
 * under vitest in plain Node. See tests/unit/vr-webxr-utils.test.js.
 */

/**
 * Format seconds as `m:ss` (or `h:mm:ss` past an hour). Invalid/negative
 * input renders as `0:00` so the OSD never shows NaN while ffprobe data
 * is still landing.
 */
export function formatTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Clamp a 0-based page index into range and return the window bounds for
 * `total` items at `pageSize` per page. `pages` is always >= 1 so an empty
 * library still renders a single (empty) page.
 */
export function paginate(total, page, pageSize) {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const count = Math.max(0, Math.floor(total) || 0);
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  const start = current * size;
  const end = Math.min(count, start + size);
  return { page: current, pages, start, end, total: count };
}

/**
 * Case-insensitive substring filter on the video display name. An empty /
 * whitespace query returns the array unchanged (same reference is fine —
 * callers never mutate the result).
 */
export function filterVideos(videos, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return videos;
  return videos.filter((v) => String(v.name || '').toLowerCase().includes(q));
}

const SORTERS = {
  name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }),
  recent: (a, b) => (b.dateAdded || 0) - (a.dateAdded || 0),
  duration: (a, b) => (b.duration || 0) - (a.duration || 0),
};

/**
 * Return a sorted SHALLOW COPY under the named mode ('name' | 'recent' |
 * 'duration'). Unknown modes fall back to name order. Never mutates the
 * input — the library model keeps the raw array as the source of truth.
 */
export function sortVideos(videos, mode) {
  const sorter = SORTERS[mode] || SORTERS.name;
  return videos.slice().sort(sorter);
}

/**
 * Hit-test a UI panel's hit regions against texture UV coordinates.
 *
 * Regions are rectangles in CANVAS pixel space ({x, y, w, h, ...}); canvas
 * origin is top-left while Three.js UV origin is bottom-left, hence the
 * (1 - v) flip and the pixel scaling. Iterates in reverse so regions
 * registered LATER sit on top (a footer button overlapping a list row wins
 * the hit). Returns the first region containing the point, or null.
 */
export function hitRegion(regions, u, v, pixelWidth, pixelHeight) {
  if (!Array.isArray(regions)) return null;
  const x = u * (pixelWidth || 1);
  const y = (1 - v) * (pixelHeight || 1);
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i];
    if (!r) continue;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  }
  return null;
}
