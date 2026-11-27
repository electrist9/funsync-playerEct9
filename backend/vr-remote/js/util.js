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
// Folder browsing — a verbatim port of the desktop app's folder model
// (renderer/js/folder-index.js + the canonicalPath rule from
// renderer/js/path-utils.js). The VR "フォルダ" view must behave exactly like
// the desktop library's 「フォルダを閲覧」 toggle:
//   * the configured library SOURCES (GET /api/remote/sources, already
//     enabled-only) are the roots — the tree never walks above a source;
//   * source cards carry the source NAME as their label;
//   * videos that belong to no source are hidden in folder view;
//   * folder cards hide when their (filtered) descendant count is zero;
//   * counts are descendant totals; folders sort by label, folders come
//     before the folder's direct videos.
// Paths are opaque strings — the VR client never touches the filesystem.
// ---------------------------------------------------------------------------

/**
 * Canonicalise a path for tree keys and prefix matching (same rule as the
 * desktop): backslashes to '/', trailing slashes stripped (a lone unix '/'
 * survives), and ONLY a leading Windows drive letter lower-cased. The rest
 * of the path stays case-sensitive, exactly like the desktop folder index.
 */
export function canonicalPath(p) {
  if (!p) return '';
  let out = String(p).replace(/\\/g, '/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out;
}

/**
 * @typedef FolderNode
 * @property {string} path         canonicalised path (the key)
 * @property {string} label        display label (source name at the root, basename otherwise)
 * @property {string|null} parent  canonical parent path, or null for source roots
 * @property {Set<string>} childFolders  canonical child paths
 * @property {Array<object>} videos     videos located directly in this folder
 * @property {boolean} isSourceRoot true when this folder is the top-level of a source
 * @property {string|null} sourceId one of `sources[].id` when `isSourceRoot`
 */

/**
 * Build a folder index from a flat video list and the list of source folders.
 * Ported verbatim from renderer/js/folder-index.js#buildFolderIndex.
 *
 * @param {Array<{path: string, name?: string}>} videos
 * @param {Array<{id: string, name: string, path: string, enabled?: boolean}>} sources
 * @returns {Map<string, FolderNode>}
 */
export function buildFolderIndex(videos, sources) {
  const index = new Map();
  const sourceByCanonical = new Map();

  const ensure = (canonical, seed = {}) => {
    let node = index.get(canonical);
    if (!node) {
      node = {
        path: canonical,
        label: canonical.split('/').pop() || canonical,
        parent: null,
        childFolders: new Set(),
        videos: [],
        isSourceRoot: false,
        sourceId: null,
        ...seed,
      };
      index.set(canonical, node);
    } else if (seed) {
      Object.assign(node, seed);
    }
    return node;
  };

  // Seed an entry for every enabled source so empty sources still appear.
  for (const src of sources || []) {
    if (src.enabled === false) continue;
    const canonical = canonicalPath(src.path);
    sourceByCanonical.set(canonical, src);
    ensure(canonical, {
      label: src.name || canonical.split('/').pop() || canonical,
      isSourceRoot: true,
      sourceId: src.id,
      parent: null,
    });
  }

  // Place each video, walking parents up to (and including) its source root.
  for (const video of videos || []) {
    if (!video?.path) continue;

    const videoPath = canonicalPath(video.path);
    const lastSlash = videoPath.lastIndexOf('/');
    if (lastSlash < 0) continue;
    const dir = videoPath.slice(0, lastSlash) || '/';

    // Find which source this video belongs to — longest matching source prefix.
    let owningSource = null;
    let owningCanonical = null;
    for (const [canonical, src] of sourceByCanonical) {
      if (videoPath.startsWith(canonical + '/') &&
          (!owningCanonical || canonical.length > owningCanonical.length)) {
        owningSource = src;
        owningCanonical = canonical;
      }
    }
    // If no source owns this video (possible for manually-added paths), skip;
    // it simply won't appear in folder view.
    if (!owningCanonical) continue;

    // Ensure the direct parent folder exists and stash the video on it.
    const leaf = ensure(dir);
    leaf.videos.push(video);

    // Walk up to the owning source root, wiring child->parent and adding
    // intermediate folders as needed.
    let current = dir;
    while (current !== owningCanonical) {
      const parentSlash = current.lastIndexOf('/');
      if (parentSlash <= 0) break;
      const parent = current.slice(0, parentSlash);
      const parentNode = ensure(parent);
      parentNode.childFolders.add(current);
      index.get(current).parent = parent;
      if (parent === owningCanonical) {
        // Reached source root — stop here so we don't walk into the filesystem.
        break;
      }
      current = parent;
    }
  }

  return index;
}

/**
 * Return every video located in `folderPath` or any of its descendants.
 * Assumes `folderPath` is already canonical.
 */
export function descendantsOf(index, folderPath) {
  const node = index.get(folderPath);
  if (!node) return [];
  const out = [...node.videos];
  const stack = [...node.childFolders];
  while (stack.length) {
    const childPath = stack.pop();
    const child = index.get(childPath);
    if (!child) continue;
    for (const v of child.videos) out.push(v);
    for (const sub of child.childFolders) stack.push(sub);
  }
  return out;
}
