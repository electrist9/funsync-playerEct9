'use strict';
// In-app photo folder browser helpers (shopping-style picker modal).
//
// Backs the 'browse-photo-directory' IPC: one SHALLOW readdir per hop,
// folder tiles pre-annotated with a bounded recursive photo count and a
// cover image, so the renderer can drill down folder-by-folder without
// the full recursive walk 'list-slideshow-images' does (that one stays
// for the slideshow itself, capped at SLIDESHOW_MAX_IMAGES).
//
// Pure CommonJS, NO 'electron' require at module scope (electron-module-
// exports guardrail; the unit tests import this directly). fs promises /
// exists checks are INJECTED so tests can run against a fake filesystem.

const path = require('path');
const { isSlideshowImageName, naturalCompare } = require('./slideshow-images');

const BROWSE_MAX_DIRS = 500;      // directory tiles listed per hop
const BROWSE_MAX_IMAGES = 1000;   // photo tiles listed per hop
const BROWSE_COUNT_CAP = 500;     // per-tile recursive photo count ceiling
const BROWSE_TOTAL_STAT_CAP = 2000; // total readdir ops for one browse()

// Drive roots on Windows (C:\ .. Z:\, only ones that exist), '/' elsewhere.
// existsDir(dirPath) -> boolean (sync; usually fs.statSync in main).
function enumerateRoots(existsDir, platform) {
  if (platform !== 'win32') return ['/'];
  const roots = [];
  for (let c = 65; c <= 90; c += 1) { // 'A'..'Z'
    const p = String.fromCharCode(c) + ':\\';
    try {
      if (existsDir(p)) roots.push(p);
    } catch { /* unreadable drive — skip */ }
  }
  return roots;
}

// path.dirname() returns its input at a root, which would make "up" a
// no-op; null tells the UI to show the drive list instead.
function parentOf(dirPath) {
  const resolved = path.resolve(String(dirPath));
  const parent = path.dirname(resolved);
  return parent === resolved ? null : parent;
}

// Bounded recursive photo scan for one directory tile: capped count +
// first image name found (BFS level order, so the cover is a SHALLOW one).
// Stops early at countCap and at the shared total-ops budget.
async function summarizeDir(fsPromises, dirPath, countCap, budget) {
  let count = 0;
  let coverName = null;
  let coverPath = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (budget.left <= 0) break;
    budget.left -= 1;
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch { /* denied / unreadable subfolder — treat as empty */ continue; }
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string') continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        queue.push(path.join(dir, entry.name));
      } else if (entry.isFile() && isSlideshowImageName(entry.name)) {
        count += 1;
        if (coverPath == null) {
          coverName = entry.name;
          coverPath = path.join(dir, entry.name);
        }
        if (count >= countCap) return { count, coverName, coverPath };
      }
    }
  }
  return { count, coverName, coverPath };
}

// Shallow listing of one directory for the browser UI.
// Returns { path, parent, dirs: [{ name, path, photoCount, capped, coverPath }],
//          images: [{ name, path }], truncated: { dirs, images } }.
// readdir failures surface as a rejected promise — main.js maps them to
// { error: 'read-failed' } like the slideshow IPCs do.
async function browseDirectory(fsPromises, dirPath, opts = {}) {
  const maxDirs = opts.maxDirs || BROWSE_MAX_DIRS;
  const maxImages = opts.maxImages || BROWSE_MAX_IMAGES;
  const countCap = opts.countCap || BROWSE_COUNT_CAP;
  const dir = path.resolve(String(dirPath));

  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  const dirEntries = [];
  const images = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      dirEntries.push({ name: entry.name, path: path.join(dir, entry.name) });
    } else if (entry.isFile() && isSlideshowImageName(entry.name)) {
      images.push({ name: entry.name, path: path.join(dir, entry.name) });
    }
  }
  dirEntries.sort((a, b) => naturalCompare(a.name, b.name));
  images.sort((a, b) => naturalCompare(a.name, b.name));

  const budget = { left: opts.totalStatCap || BROWSE_TOTAL_STAT_CAP };
  const dirs = [];
  for (let i = 0; i < dirEntries.length && i < maxDirs; i += 1) {
    const d = dirEntries[i];
    const summary = await summarizeDir(fsPromises, d.path, countCap, budget);
    dirs.push({
      name: d.name,
      path: d.path,
      photoCount: summary.count,
      capped: summary.count >= countCap,
      coverPath: summary.coverPath,
    });
  }

  return {
    path: dir,
    parent: parentOf(dir),
    dirs,
    images: images.slice(0, maxImages),
    truncated: {
      dirs: dirEntries.length > maxDirs,
      images: images.length > maxImages,
    },
  };
}

module.exports = {
  enumerateRoots,
  parentOf,
  summarizeDir,
  browseDirectory,
  BROWSE_MAX_DIRS,
  BROWSE_MAX_IMAGES,
  BROWSE_COUNT_CAP,
};
