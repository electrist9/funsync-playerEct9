/**
 * Library browser model for the VR client.
 *
 * Reuses the exact same JSON API the 2D phone remote consumes
 * (`GET /api/remote/videos`) so both clients see identical data, including
 * `manualVRType` overrides. This module is UI-agnostic: it only maintains
 * query / sort / scroll / folder state and hands `main.js` a materialised
 * window of items to paint onto a UIPanel.
 */

import { filterVideos, sortVideos, folderGroups } from './util.js';

export async function fetchVideos() {
  const res = await fetch('/api/remote/videos', { cache: 'no-store' });
  if (!res.ok) throw new Error(`videos ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.videos) ? data.videos : [];
}

export class LibraryModel {
  constructor(videos = []) {
    this.videos = videos;
    this.query = '';
    this.sort = 'name';
    // Scrolling replaces paging (right thumbstick drives scrollBy in
    // main.js): `scroll` is the index of the first visible item.
    this.scroll = 0;
    this.pageSize = 12;
    // Folder browsing ('folderMode') and tile vs list presentation
    // ('viewMode') are pure view state; both reset the scroll window.
    this.folderMode = false;
    this.folder = null; // normalized directory path, null = auto root
    this.viewMode = 'list'; // 'list' | 'grid'
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
      this.folder = null;
      this.scrollTo(0);
      this._version += 1;
    }
  }

  setFolder(path) {
    if (path !== this.folder) {
      this.folder = path == null ? null : String(path);
      this.scrollTo(0);
      this._version += 1;
    }
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
      const groups = folderGroups(list, this.folder);
      items = [
        ...groups.folders.map((folder) => ({ folder })),
        ...groups.direct.map((video) => ({ video })),
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
