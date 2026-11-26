/**
 * Library browser model for the VR client.
 *
 * Reuses the exact same JSON API the 2D phone remote consumes
 * (`GET /api/remote/videos`) so both clients see identical data, including
 * `manualVRType` overrides. This module is UI-agnostic: it only maintains
 * query / sort / paging state and hands `main.js` a materialised window of
 * rows to paint onto a UIPanel.
 */

import { filterVideos, sortVideos, paginate } from './util.js';

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
    this.page = 0;
    this.pageSize = 12;
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
    this.page = 0;
    this._version += 1;
  }

  setSort(sort) {
    if (sort !== this.sort) {
      this.sort = sort;
      this.page = 0;
      this._version += 1;
    }
  }

  nextPage() {
    this.page += 1;
    this._version += 1;
  }

  prevPage() {
    this.page -= 1;
    this._version += 1;
  }

  /** Filter + sort + clamp paging; returns rows for the current page. */
  view() {
    if (this._cache && this._cacheVersion === this._version && this._cacheQuery === this.query) return this._cache;
    const list = sortVideos(filterVideos(this.videos, this.query), this.sort);
    const p = paginate(list.length, this.page, this.pageSize);
    this.page = p.page; // keep clamped index so next/prev stay sane
    this._cache = { rows: list.slice(p.start, p.end), ...p };
    this._cacheVersion = this._version;
    this._cacheQuery = this.query;
    return this._cache;
  }
}
