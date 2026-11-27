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

// ---------------------------------------------------------------------------
// Folder browsing helpers (pure path logic, unit-testable in plain Node).
// Video records carry absolute Windows paths from the scanner; we only ever
// treat them as opaque strings — the VR client never touches the filesystem.
// ---------------------------------------------------------------------------

/** Normalize separators to '/' and drop trailing ones ('' for invalid input). */
export function normalizePath(path) {
  const s = String(path || '').replace(/\\/g, '/');
  const trimmed = s.replace(/\/+$/, '');
  return trimmed;
}

/** Parent directory of a normalized path ('' when there is none). */
export function parentDir(path) {
  const s = normalizePath(path);
  const i = s.lastIndexOf('/');
  if (i < 0) return '';
  return s.slice(0, i);
}

/** Last path segment (the whole string when there is no separator). */
export function baseName(path) {
  const s = normalizePath(path);
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

/** Case-insensitive "child sits strictly inside parent" for normalized paths. */
function isUnder(child, parent) {
  if (!child || !parent) return false;
  return child.toLowerCase().startsWith(parent.toLowerCase() + '/');
}

/**
 * Split `videos` (already filtered/sorted) into the subfolders directly
 * under `folder` plus the videos stored directly in it.
 *
 * `folder` is a normalized directory path, or null for the auto root — at
 * the root the "subfolders" are the minimal set of directories that contain
 * videos (one entry per source tree instead of every intermediate folder).
 * Inside a folder, children are derived from the FIRST path segment below
 * it, so intermediate levels always appear even when videos live deeper.
 * Videos with no usable path show up as `direct` entries at the root only.
 * Folder entries are {path, name, count} sorted by name; count includes
 * videos in nested subfolders. Comparison is case-insensitive throughout
 * (Windows paths), display keeps the first-seen casing.
 */
export function folderGroups(videos, folder) {
  const uniqueParents = [];
  const seen = new Set();
  for (const v of videos) {
    const p = parentDir(normalizePath(v.path));
    if (!p) continue;
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniqueParents.push(p);
    }
  }
  const normFolder = folder == null ? '' : normalizePath(folder);

  let paths;
  if (!normFolder) {
    // Auto root: keep only the outermost containing directories.
    const deduped = [];
    const keys = new Set();
    for (const p of uniqueParents) {
      const k = p.toLowerCase();
      if (keys.has(k)) continue;
      keys.add(k);
      deduped.push(p);
    }
    paths = deduped.filter((p) => !deduped.some((q) => q !== p && isUnder(p, q)));
  } else {
    // Drill exactly one level: first segment below the current folder.
    const childMap = new Map();
    for (const p of uniqueParents) {
      if (!isUnder(p, normFolder)) continue;
      const seg = p.slice(normFolder.length + 1).split('/')[0];
      if (!seg) continue;
      const full = normFolder + '/' + seg;
      const k = full.toLowerCase();
      if (!childMap.has(k)) childMap.set(k, full);
    }
    paths = [...childMap.values()];
  }

  const folders = paths
    .map((path) => ({ path, name: baseName(path) || path }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const f of folders) {
    const key = f.path.toLowerCase();
    f.count = videos.reduce((n, v) => {
      const p = parentDir(normalizePath(v.path));
      const pk = p.toLowerCase();
      return n + (pk === key || isUnder(p, f.path) ? 1 : 0);
    }, 0);
  }
  const folderKey = normFolder.toLowerCase();
  const direct = videos.filter((v) => {
    const p = parentDir(normalizePath(v.path));
    if (!p) return !normFolder; // path-less videos live at the root view
    return p.toLowerCase() === folderKey;
  });
  return { folders, direct };
}
