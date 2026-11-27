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
    // pageSize + 1 buffer item for the row sliding in during smooth scroll.
    expect(a.items.length).toBe(13);
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
    while (m.tickScroll()) { /* ease to target */ }
    const v1 = m.view();
    m.setVideos(mkVideos(3));
    const v2 = m.view();
    expect(v2).not.toBe(v1);
    expect(v2.total).toBe(3);
    expect(v2.start).toBe(0);
    expect(v2.end).toBe(3);
  });

  it('scrollBy eases the window toward its target and clamps at both ends', () => {
    const m = new LibraryModel(mkVideos(30));
    const v0 = m.view();
    expect(v0.start).toBe(0);
    expect(v0.items[0].video.name).toBe('Video 0000');
    m.scrollBy(10);
    // Smooth scrolling: the stick moves the target, the view eases there.
    expect(m.view().start).toBe(0);
    expect(m.tickScroll()).toBe(true);
    expect(m.view().start).toBeLessThan(10);
    while (m.tickScroll()) { /* settle */ }
    expect(m.scroll).toBe(10);
    const v1 = m.view();
    expect(v1.start).toBe(10);
    expect(v1.items.length).toBe(13); // +1 buffer item for the sliding row
    expect(v1.items[0].video.name).toBe('Video 0010');
    // Past the end: the window slides back to show a full page of items.
    m.scrollBy(999);
    while (m.tickScroll()) { /* settle */ }
    const clamped = m.view();
    expect(clamped.start).toBe(30 - 12);
    expect(clamped.end).toBe(30);
    m.scrollTo(-5);
    expect(m.view().start).toBe(0);
  });

  it('grid mode steps whole rows and rests on row edges', () => {
    const m = new LibraryModel(mkVideos(20)); // pageSize 12 = four grid rows
    m.setViewMode('grid');
    expect(m.scrollStep()).toBe(3);
    // Row-aligned, yet the final partial row (items 18-19) stays reachable.
    expect(m.maxScroll(20)).toBe(9);
    m.scrollBy(m.scrollStep()); // one notch = one row of three tiles
    while (m.tickScroll()) { /* settle */ }
    expect(m.view().start).toBe(3);
    m.scrollBy(1); // sub-row deltas quantize away in grid mode
    expect(m.view().start).toBe(3);
    m.scrollBy(99);
    while (m.tickScroll()) { /* settle */ }
    const v = m.view();
    expect(v.start).toBe(9);
    expect(v.end).toBe(20);
    expect(v.items[v.items.length - 1].video.name).toBe('Video 0019');
  });

  it('grid mode still reveals an overflow smaller than one row', () => {
    // Field case: 11 folder tiles, a page shows 9 — the last 2 must scroll in.
    const m = new LibraryModel(mkVideos(11));
    m.pageSize = 9;
    m.setViewMode('grid');
    expect(m.maxScroll(11)).toBe(3);
    m.scrollBy(m.scrollStep());
    while (m.tickScroll()) { /* settle */ }
    const v = m.view();
    expect(v.start).toBe(3);
    expect(v.items.length).toBe(8);
    expect(v.items[v.items.length - 1].video.name).toBe('Video 0010');
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
  // Desktop 「フォルダを閲覧」 semantics: the configured SOURCES are the
  // roots (label = source name), unowned videos are hidden, and cards with
  // zero filtered descendants disappear.
  const sources = [
    { id: 's1', name: 'Library A', path: 'C:\\Videos' },
    { id: 's2', name: 'Empty Bin', path: 'D:\\Empty' },
  ];
  const videos = [
    { id: 'a', name: 'A', path: 'C:\\Videos\\Set A\\a.mp4' },
    { id: 'b', name: 'B', path: 'C:\\Videos\\Set A\\deep\\b.mp4' },
    { id: 'c', name: 'C', path: 'C:\\Videos\\Set B\\c.mp4' },
    { id: 'd', name: 'D', path: 'C:\\Videos\\d.mp4' },
    { id: 'e', name: 'E', path: 'E:\\Lost\\e.mp4' }, // belongs to no source
  ];

  it('root lists one card per non-empty source, labelled with its name', () => {
    const m = new LibraryModel(videos, sources);
    m.setFolderMode(true);
    const v = m.view();
    expect(v.items.filter((it) => it.folder).map((it) => [it.folder.name, it.folder.count]))
      .toEqual([['Library A', 4]]); // Empty Bin (0) and orphan video E hidden
    expect(v.items.filter((it) => it.video)).toEqual([]);
  });

  it('flat view still shows unowned videos; folder view does not', () => {
    const m = new LibraryModel(videos, sources);
    expect(m.view().total).toBe(5);
    m.setFolderMode(true);
    expect(m.view().total).toBe(1);
  });

  it('drilling down shows direct subfolders with recursive counts, then direct videos', () => {
    const m = new LibraryModel(videos, sources);
    m.setFolderMode(true);
    m.setFolder('C:\\Videos'); // non-canonical input is canonicalised
    expect(m.folder).toBe('c:/Videos');
    const v = m.view();
    expect(v.items.filter((it) => it.folder).map((it) => [it.folder.name, it.folder.count]))
      .toEqual([['Set A', 2], ['Set B', 1]]);
    expect(v.items.filter((it) => it.video).map((it) => it.video.id)).toEqual(['d']);
    m.setFolder('C:/Videos/Set A');
    const deep = m.view();
    expect(deep.items.filter((it) => it.folder).map((it) => [it.folder.name, it.folder.count]))
      .toEqual([['deep', 1]]);
    expect(deep.items.filter((it) => it.video).map((it) => it.video.id)).toEqual(['a']);
    m.setFolder('C:/Videos/Set A/deep');
    expect(m.view().items.map((it) => it.video?.id)).toEqual(['b']);
  });

  it('folder counts respect the active query filter', () => {
    const m = new LibraryModel(videos, sources);
    m.query = 'B'; // only video B survives the name filter
    m.setFolderMode(true);
    expect(m.view().items.filter((it) => it.folder).map((it) => [it.folder.name, it.folder.count]))
      .toEqual([['Library A', 1]]);
    m.setFolder('C:/Videos');
    const folders = m.view().items.filter((it) => it.folder);
    expect(folders.map((it) => [it.folder.name, it.folder.count])).toEqual([['Set A', 1]]);
    expect(folders.some((it) => it.folder.name === 'Set B')).toBe(false);
  });

  it('source roots label with the source name and go up to the root list', () => {
    const m = new LibraryModel(videos, sources);
    m.setFolderMode(true);
    m.setFolder('C:/Videos/Set A');
    expect(m.folderLabel()).toBe('Set A');
    expect(m.folderParent()).toBe('c:/Videos');
    m.setFolder(m.folderParent());
    expect(m.folderLabel()).toBe('Library A');
    expect(m.folderParent()).toBeNull();
    m.setFolder(null);
    expect(m.folderLabel()).toBe('');
    expect(m.folder).toBeNull();
  });

  it('setFolderMode off clears the folder; toggling on keeps a known folder', () => {
    const m = new LibraryModel(videos, sources);
    m.setFolderMode(true);
    m.setFolder('C:/Videos');
    m.scrollBy(1);
    m.setFolderMode(false);
    expect(m.folder).toBeNull();
    expect(m.scroll).toBe(0);
    m.setFolder('C:/Videos/Set A');
    m.setFolderMode(false);
    m.setFolderMode(true); // re-enabling keeps a folder that exists in the index
    expect(m.folder).toBe('c:/Videos/Set A');
  });

  it('setSources rebuilds the tree and drops a vanished folder', () => {
    const m = new LibraryModel(videos, sources);
    m.setFolderMode(true);
    m.setFolder('C:/Videos/Set A');
    m.setSources([{ id: 's2', name: 'Empty Bin', path: 'D:\\Empty' }]);
    expect(m.folder).toBeNull();
    expect(m.view().items).toEqual([]);
    m.setVideos([]);
    m.setSources(sources);
    expect(m.view().items.filter((it) => it.folder)).toEqual([]); // no videos → no cards
  });
});
