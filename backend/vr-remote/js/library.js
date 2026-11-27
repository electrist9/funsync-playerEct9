/**
 * Library browser model for the VR client.
 *
 * Reuses the exact same JSON API the 2D phone remote consumes
 * (`GET /api/remote/videos`) so both clients see identical data, including
 * `manualVRType` overrides. This module is UI-agnostic: it only maintains
 * query / sort / scroll / folder state and hands `main.js` a materialised
 * window of items to paint onto a UIPanel.
 */

import { filterVideos, sortVideos, canonicalPath, buildFolderIndex, descendantsOf } from './util.js';

export async function fetchVideos() {
  const res = await fetch('/api/remote/videos', { cache: 'no-store' });
  if (!res.ok) throw new Error(`videos ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.videos) ? data.videos : [];
}

/** Library source folders (already filtered to enabled ones server-side). */
export async function fetchSources() {
  const res = await fetch('/api/remote/sources', { cache: 'no-store' });
  if (!res.ok) throw new Error(`sources ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.sources) ? data.sources : [];
}

export class LibraryModel {
  constructor(videos = [], sources = []) {
    this.videos = videos;
    // Configured library sources — the roots of the folder tree, matching
    // the desktop 「フォルダを閲覧」 view (renderer/js/folder-index.js).
    this.sources = sources;
    this.query = '';
    this.sort = 'name';
    // Scrolling replaces paging (right thumbstick drives scrollBy in
    // main.js): `scroll` is the index of the first visible item.
    this.scroll = 0;
    this.pageSize = 12;
    // Folder browsing ('folderMode') and tile vs list presentation
    // ('viewMode') are pure view state; both reset the scroll window.
    this.folderMode = false;
    this.folder = null; // canonical folder path, null = root (source cards)
    this.viewMode = 'list'; // 'list' | 'grid'
    // Folder tree (buildFolderIndex over videos+sources); rebuilt whenever
    // the video/source sets change.
    this._folderIndex = buildFolderIndex(videos, sources);
    // view() memoization. With thousands of videos the filter+sort is not
    // free, and main.js asks for the view every XR frame (OSD refresh);
    // recompute only when the model actually changed. Callers must treat
    // the returned object as read-only.
    this._version = 0;
    this._cache = null;
    this._cacheVersion = -1;
    this._cacheQuery = null;
  }

  setVideos(videos) {
    this.videos = videos;
    this._folderIndex = buildFolderIndex(videos, this.sources);
    if (this.folder !== null && !this._folderIndex.has(this.folder)) {
      this.folder = null;
    }
    this.scrollTo(0);
    this._version += 1;
  }

  setSources(sources) {
    this.sources = sources;
    this._folderIndex = buildFolderIndex(this.videos, sources);
    // A refresh can remove the folder we are standing in; fall back to the
    // source-root list in that case (the desktop keeps the folder only if
    // it still exists in the index).
    if (this.folder !== null && !this._folderIndex.has(this.folder)) {
      this.folder = null;
    }
    this.scrollTo(0);
    this._version += 1;
  }

  setSort(sort) {
    if (sort !== this.sort) {
      this.sort = sort;
      this.scrollTo(0);
      this._version += 1;
    }
  }

  setFolderMode(on) {
    const next = Boolean(on);
    if (next !== this.folderMode) {
      this.folderMode = next;
      // Toggle preserves the drilled-into folder when it still exists,
      // same as the desktop _toggleFolderBrowse().
      if (!next || (this.folder !== null && !this._folderIndex.has(this.folder))) {
        this.folder = null;
      }
      this.scrollTo(0);
      this._version += 1;
    }
  }

  setFolder(path) {
    const next = path == null ? null : canonicalPath(String(path));
    if (next !== this.folder) {
      this.folder = next;
      this.scrollTo(0);
      this._version += 1;
    }
  }

  /** Label of the current folder (source name at a source root). '' at root. */
  folderLabel() {
    if (this.folder === null) return '';
    return this._folderIndex.get(this.folder)?.label || this.folder;
  }

  /** Parent folder to navigate 'up' to; null = source-root card list. */
  folderParent() {
    if (this.folder === null) return null;
    return this._folderIndex.get(this.folder)?.parent ?? null;
  }

  setViewMode(mode) {
    const next = mode === 'grid' ? 'grid' : 'list';
    if (next !== this.viewMode) {
      this.viewMode = next;
      this.scrollTo(0);
      this._version += 1;
    }
  }

  /** Move the window by `delta` items; clamped against the full item list. */
  scrollBy(delta) {
    this.scrollTo(this.scroll + Math.round(delta) || 0);
  }

  scrollTo(index) {
    const next = Math.max(0, Math.floor(index) || 0);
    if (next !== this.scroll) {
      this.scroll = next;
      this._version += 1;
    }
  }

  /**
   * Folder cards + direct videos for the current folder, desktop rules:
   * root = one card per source (label = source name), a drill = the node's
   * child folders (label = basename) followed by its direct videos; empty
   * (post-query) cards are hidden; counts are filtered descendant totals.
   */
  _folderItems() {
    const index = this._folderIndex;
    // Defensive: a refresh can drop the current folder; degrade to the root
    // view (bump the version so the memoization stays coherent).
    if (this.folder !== null && !index.has(this.folder)) {
      this.folder = null;
      this._version += 1;
    }
    const folders = [];
    let direct = [];
    if (this.folder === null) {
      for (const node of index.values()) {
        if (!node.isSourceRoot) continue;
        const count = filterVideos(descendantsOf(index, node.path), this.query).length;
        if (!count) continue; // desktop hides empty source cards
        folders.push({ path: node.path, name: node.label, count });
      }
    } else {
      const node = index.get(this.folder);
      for (const childPath of node.childFolders) {
        const child = index.get(childPath);
        if (!child) continue;
        const count = filterVideos(descendantsOf(index, childPath), this.query).length;
        if (!count) continue; // desktop hides empty folder cards
        folders.push({ path: childPath, name: child.label, count });
      }
      direct = node.videos;
    }
    // Folder labels sort Explorer-style (compareNames / naturalSortCollator
    // on the desktop); numeric-aware, case-insensitive.
    folders.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }));
    return { folders, direct };
  }

  /**
   * Filter + sort (+ folder grouping), clamp the scroll window; returns
   * `{ items, total, start, end }` where each item is either
   * `{ folder: {path, name, count} }` or `{ video }`. Callers must treat
   * the result as read-only.
   */
  view() {
    if (this._cache && this._cacheVersion === this._version && this._cacheQuery === this.query) return this._cache;
    const list = sortVideos(filterVideos(this.videos, this.query), this.sort);
    let items;
    if (this.folderMode) {
      const groups = this._folderItems();
      items = [
        ...groups.folders.map((folder) => ({ folder })),
        ...sortVideos(filterVideos(groups.direct, this.query), this.sort).map((video) => ({ video })),
      ];
    } else {
      items = list.map((video) => ({ video }));
    }
    // The raw scroll index may exceed the list after a refresh; clamp it
    // without bumping the version (the cached window below is already
    // corrected, and bumping here would invalidate the cache we just built).
    this.scroll = Math.min(this.scroll, Math.max(0, items.length - 1));
    const start = Math.min(this.scroll, Math.max(0, items.length - this.pageSize));
    const end = Math.min(items.length, start + this.pageSize);
    this._cache = { items: items.slice(start, end), total: items.length, start, end };
    this._cacheVersion = this._version;
    this._cacheQuery = this.query;
    return this._cache;
  }
}
