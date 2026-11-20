'use strict';

/**
 * Slideshow image listing/serving helpers for the `list-slideshow-images`
 * and `read-slideshow-image` IPC handlers in electron/main.js.
 *
 * Photo-switch timing lives in renderer/js/slideshow-timing.js (a port of
 * rhythmslide's funscript.py, © electrist9, GPL-3.0). This module only
 * handles the file side: which files count as slideshow images, in what
 * order, and the folder guard for serving them.
 *
 * Like electron/funscript-variants.js this must stay plain CommonJS with no
 * `require('electron')` at module scope — vitest loads it outside Electron.
 */

const path = require('path');

/** Extensions accepted as slideshow images (lowercase, dot included). */
const SLIDESHOW_IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif',
]);

/** Hard cap on one slideshow folder listing (renderer also caps its cache). */
const SLIDESHOW_MAX_IMAGES = 5000;

/**
 * True when a file name has a slideshow-image extension. Extension match is
 * case-insensitive (camera files like IMG.JPG are common; Linux file systems
 * are case-sensitive, so compare on the lowercased extension).
 */
function isSlideshowImageName(name) {
  const s = String(name);
  if (s.startsWith('.')) return false; // dot-file (hidden) — skip
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return false; // no extension
  return SLIDESHOW_IMAGE_EXTS.has(s.slice(dot).toLowerCase());
}

/**
 * Natural (numeric-aware, case-insensitive) compare of two strings:
 * "img2" < "img10". Mirrors renderer/js/slideshow-timing.js::naturalCompare
 * so the folder listing arrives pre-sorted and the 'name' order is stable.
 */
function naturalCompare(a, b) {
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

/**
 * Filter recursive-readdir dirents down to slideshow image paths.
 * `entries` are fs.Dirent-like objects ({ name, isFile(), parentPath? }) as
 * produced by `fs.promises.readdir(dir, { withFileTypes: true, recursive: true })`
 * (older Node used `path` instead of `parentPath`). Dot-directories and
 * dot-files are skipped; the result is naturally sorted by basename and
 * capped at SLIDESHOW_MAX_IMAGES.
 */
function collectSlideshowImages(entries, dirPath) {
  const images = [];
  if (!Array.isArray(entries)) return images;
  for (const entry of entries) {
    if (!entry || typeof entry.isFile !== 'function' || !entry.isFile()) continue;
    if (!isSlideshowImageName(entry.name)) continue;
    const parent = entry.parentPath || entry.path || dirPath;
    const full = path.join(parent, entry.name);
    // Skip anything under a dot-directory (e.g. <folder>/.thumbnails/x.jpg).
    // path.relative also yields ".." segments for out-of-tree paths, which
    // start with "." and are skipped too.
    const rel = path.relative(dirPath, full);
    if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) continue;
    images.push(full);
    if (images.length >= SLIDESHOW_MAX_IMAGES) break;
  }
  images.sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
  return images;
}

/**
 * Folder guard for read-slideshow-image: the renderer supplies both the
 * configured slideshow folder and the image path, so treat the image path as
 * untrusted — only serve files inside the folder (resolved, no traversal).
 */
function isWithinFolder(folder, filePath) {
  // Check the RAW strings first: path.resolve('') silently yields the CWD,
  // which would let an empty folder argument accept CWD-relative files.
  const rawDir = String(folder || '');
  const rawFile = String(filePath || '');
  if (!rawDir || !rawFile) return false;
  const dir = path.resolve(rawDir);
  const file = path.resolve(rawFile);
  return file.startsWith(dir + path.sep);
}

/** MIME type for a raw (nativeImage-undecodable) image fallback. */
function imageMimeForExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  if (e === 'bmp') return 'image/bmp';
  if (e === 'avif') return 'image/avif';
  return 'image/jpeg';
}

module.exports = {
  SLIDESHOW_IMAGE_EXTS,
  SLIDESHOW_MAX_IMAGES,
  isSlideshowImageName,
  naturalCompare,
  collectSlideshowImages,
  isWithinFolder,
  imageMimeForExt,
};
