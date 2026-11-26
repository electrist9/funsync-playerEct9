/**
 * LibraryModel caching tests — the XR frame loop asks for view() every
 * frame, so the filter+sort must run at most once per model mutation.
 */
import { describe, it, expect } from 'vitest';
import { LibraryModel } from '../../backend/vr-remote/js/library.js';

function mkVideos(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `v${i}`,
    name: `Video ${String(i).padStart(4, '0')}`,
    duration: 60 + i,
    hasFunscript: i % 3 === 0,
    hasSubtitle: false,
    manualVRType: null,
  }));
}

describe('LibraryModel view caching', () => {
  it('returns the identical object on repeated calls without mutation', () => {
    const m = new LibraryModel(mkVideos(2496));
    const a = m.view();
    const b = m.view();
    expect(b).toBe(a);
    expect(a.total).toBe(2496);
    expect(a.rows.length).toBe(12);
  });

  it('recomputes after setSort', () => {
    const m = new LibraryModel(mkVideos(30));
    const byName = m.view();
    expect(byName.rows[0].name).toBe('Video 0000');
    m.setSort('duration');
    const byDur = m.view();
    expect(byDur).not.toBe(byName);
    expect(byDur.rows[0].name).toBe('Video 0029'); // duration sorter is descending
    expect(m.page).toBe(0); // sort resets paging
  });

  it('recomputes after setVideos and clamps the page', () => {
    const m = new LibraryModel(mkVideos(30));
    m.setSort('name');
    const v1 = m.view();
    m.setVideos(mkVideos(3));
    const v2 = m.view();
    expect(v2).not.toBe(v1);
    expect(v2.total).toBe(3);
    expect(v2.pages).toBe(1);
    expect(m.page).toBe(0);
  });

  it('nextPage/prevPage return fresh views and keep paging sane', () => {
    const m = new LibraryModel(mkVideos(30));
    const p0 = m.view();
    m.nextPage();
    const p1 = m.view();
    expect(p1).not.toBe(p0);
    expect(p1.page).toBe(1);
    expect(p1.rows[0].name).toBe('Video 0012');
    // Page past the end: view() clamps, and the clamped page is remembered.
    m.nextPage();
    m.nextPage();
    const clamped = m.view();
    expect(clamped.page).toBe(2); // 30 items / 12 per page → pages 0..2
    m.prevPage();
    expect(m.view().page).toBe(1);
  });

  it('query filtering invalidates through setVideos path (total reflects filter)', () => {
    const m = new LibraryModel(mkVideos(20));
    m.query = 'Video 000'; // matches 0000..0009
    const v = m.view();
    expect(v.total).toBe(10);
    const v2 = m.view();
    expect(v2).toBe(v); // still cached across pure reads
  });
});
