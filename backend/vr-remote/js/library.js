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
  }

  setVideos(videos) {
    this.videos = videos;
    this.page = 0;
  }

  setSort(sort) {
    if (sort !== this.sort) {
      this.sort = sort;
      this.page = 0;
    }
  }

  nextPage() {
    this.page += 1;
  }

  prevPage() {
    this.page -= 1;
  }

  /** Filter + sort + clamp paging; returns rows for the current page. */
  view() {
    const list = sortVideos(filterVideos(this.videos, this.query), this.sort);
    const p = paginate(list.length, this.page, this.pageSize);
    this.page = p.page; // keep clamped index so next/prev stay sane
    return { rows: list.slice(p.start, p.end), ...p };
  }
}
