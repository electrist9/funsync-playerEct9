/**
 * LibraryModel tests — the XR frame loop asks for view() every frame, so
 * the filter+sort must run at most once per model mutation; scroll and
 * folder state must window items sanely.
 */
import { describe, it, expect } from 'vitest';
import { LibraryModel } from '../../backend/vr-remote/js/library.js';

function mkVideos(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `v${i}`,
    name: `Video ${String(i).padStart(4, '0')}`,
    path: `C:\\Videos\\Video ${String(i).padStart(4, '0')}.mp4`,
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
    expect(a.items.length).toBe(12);
  });

  it('recomputes after setSort', () => {
    const m = new LibraryModel(mkVideos(30));
    const byName = m.view();
    expect(byName.items[0].video.name).toBe('Video 0000');
    m.setSort('duration');
    const byDur = m.view();
    expect(byDur).not.toBe(byName);
    expect(byDur.items[0].video.name).toBe('Video 0029'); // duration sorter is descending
    expect(m.scroll).toBe(0); // sort resets scrolling
  });

  it('recomputes after setVideos and resets the scroll', () => {
    const m = new LibraryModel(mkVideos(30));
    m.scrollBy(25);
    const v1 = m.view();
    m.setVideos(mkVideos(3));
    const v2 = m.view();
    expect(v2).not.toBe(v1);
    expect(v2.total).toBe(3);
    expect(v2.start).toBe(0);
    expect(v2.end).toBe(3);
  });

  it('scrollBy windows items and clamps at both ends', () => {
    const m = new LibraryModel(mkVideos(30));
    const v0 = m.view();
    expect(v0.start).toBe(0);
    expect(v0.items[0].video.name).toBe('Video 0000');
    m.scrollBy(10);
    const v1 = m.view();
    expect(v1.start).toBe(10);
    expect(v1.items.length).toBe(12);
    expect(v1.items[0].video.name).toBe('Video 0010');
    // Past the end: the window slides back to show a full page of items.
    m.scrollBy(999);
    const clamped = m.view();
    expect(clamped.start).toBe(30 - 12);
    expect(clamped.end).toBe(30);
    m.scrollTo(-5);
    expect(m.view().start).toBe(0);
  });

  it('view changes (folder mode, view mode) invalidate the cache', () => {
    const m = new LibraryModel(mkVideos(10));
    const v0 = m.view();
    m.setFolderMode(true);
    const v1 = m.view();
    expect(v1).not.toBe(v0);
    m.setViewMode('grid');
    expect(m.view()).not.toBe(v1);
    m.setViewMode('list'); // already-known mode pair only
    m.setViewMode('bogus'); // coerces to list → no change → cached
    expect(m.view()).toBe(m.view());
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

describe('LibraryModel folder browsing', () => {
  const videos = [
    { id: 'a', name: 'A', path: 'C:\\Videos\\Set A\\a.mp4' },
    { id: 'b', name: 'B', path: 'C:\\Videos\\Set A\\deep\\b.mp4' },
    { id: 'c', name: 'C', path: 'C:\\Videos\\Set B\\c.mp4' },
    { id: 'd', name: 'D', path: 'C:\\Videos\\rootish.mp4' },
    { id: 'e', name: 'E', path: '' },
  ];

  it('auto root lists minimal source folders plus path-less videos', () => {
    const m = new LibraryModel(videos);
    m.setFolderMode(true);
    const v = m.view();
    expect(v.items.filter((it) => it.folder).map((it) => it.folder.name)).toEqual(['Videos']);
    expect(v.items.filter((it) => it.video).map((it) => it.video.id)).toEqual(['e']);
  });

  it('drilling down shows direct subfolders with recursive counts', () => {
    const m = new LibraryModel(videos);
    m.setFolderMode(true);
    m.setFolder('C:/Videos');
    const v = m.view();
    const folders = v.items.filter((it) => it.folder);
    expect(folders.map((it) => [it.folder.name, it.folder.count])).toEqual([
      ['Set A', 2],
      ['Set B', 1],
    ]);
    expect(v.items.filter((it) => it.video).map((it) => it.video.id)).toEqual(['d']);
    m.setFolder('C:/Videos/Set A');
    const deep = m.view();
    expect(deep.items.filter((it) => it.folder).map((it) => it.folder.name)).toEqual(['deep']);
    expect(deep.items.filter((it) => it.video).map((it) => it.video.id)).toEqual(['a']);
  });

  it('folder counts respect the active query filter', () => {
    const m = new LibraryModel(videos);
    m.query = 'b'; // only video B survives the name filter
    m.setFolderMode(true);
    m.setFolder('C:/Videos');
    const v = m.view();
    const folders = v.items.filter((it) => it.folder);
    expect(folders.map((it) => [it.folder.name, it.folder.count])).toEqual([['Set A', 1]]);
    expect(folders.some((it) => it.folder.name === 'Set B')).toBe(false);
  });

  it('setFolderMode resets the drilled folder and scrolling', () => {
    const m = new LibraryModel(videos);
    m.setFolderMode(true);
    m.setFolder('C:/Videos');
    m.scrollBy(1);
    expect(m.folder).toBe('C:/Videos');
    m.setFolderMode(false);
    expect(m.folder).toBeNull();
    expect(m.scroll).toBe(0);
  });
});
