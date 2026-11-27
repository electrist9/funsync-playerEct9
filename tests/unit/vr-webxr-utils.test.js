/**
 * Unit tests for the pure helpers backing the WebXR VR client
 * (backend/vr-remote/js/util.js). These functions deliberately avoid DOM
 * and THREE so they run here in jsdom/Node with zero stubbing.
 */

import { describe, expect, it } from 'vitest';
import {
  formatTime,
  paginate,
  filterVideos,
  sortVideos,
  hitRegion,
  canonicalPath,
  buildFolderIndex,
  descendantsOf,
} from '../../backend/vr-remote/js/util.js';

describe('formatTime', () => {
  it('formats sub-hour times as m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9.9)).toBe('0:09');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(599)).toBe('9:59');
  });

  it('switches to h:mm:ss past an hour', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(7325)).toBe('2:02:05');
  });

  it('renders invalid or negative input as 0:00 so the OSD never shows NaN', () => {
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(undefined)).toBe('0:00');
    expect(formatTime('10')).toBe('0:00');
  });
});

describe('paginate', () => {
  it('windows items and clamps the page index', () => {
    expect(paginate(25, 0, 10)).toEqual({ page: 0, pages: 3, start: 0, end: 10, total: 25 });
    expect(paginate(25, 2, 10)).toEqual({ page: 2, pages: 3, start: 20, end: 25, total: 25 });
    expect(paginate(25, 99, 10)).toEqual({ page: 2, pages: 3, start: 20, end: 25, total: 25 });
    expect(paginate(25, -3, 10)).toEqual({ page: 0, pages: 3, start: 0, end: 10, total: 25 });
  });

  it('reports exactly one page for an empty list', () => {
    expect(paginate(0, 0, 10)).toEqual({ page: 0, pages: 1, start: 0, end: 0, total: 0 });
    expect(paginate(0, 5, 10).page).toBe(0);
  });

  it('coerces junk sizes to at least 1', () => {
    expect(paginate(3, 0, 0).pages).toBe(3);
    expect(paginate(3, 0, undefined).pages).toBe(3);
  });
});

describe('filterVideos', () => {
  const videos = [
    { name: 'Alpha' },
    { name: 'beta one' },
    { name: 'Gamma Beta' },
  ];

  it('returns the array untouched for an empty/whitespace query', () => {
    expect(filterVideos(videos, '')).toBe(videos);
    expect(filterVideos(videos, '   ')).toBe(videos);
    expect(filterVideos(videos, undefined)).toBe(videos);
  });

  it('matches case-insensitively as a substring', () => {
    expect(filterVideos(videos, 'BETA').map((v) => v.name)).toEqual(['beta one', 'Gamma Beta']);
    expect(filterVideos(videos, 'a').map((v) => v.name)).toEqual(['Alpha', 'beta one', 'Gamma Beta']);
    expect(filterVideos(videos, 'zzz')).toEqual([]);
  });
});

describe('sortVideos', () => {
  const videos = [
    { name: 'banana', duration: 100, dateAdded: 5 },
    { name: 'Apple', duration: 300, dateAdded: 9 },
    { name: 'cherry', duration: 200, dateAdded: 1 },
  ];

  it('sorts by name case-insensitively without mutating the input', () => {
    const sorted = sortVideos(videos, 'name');
    expect(sorted.map((v) => v.name)).toEqual(['Apple', 'banana', 'cherry']);
    expect(videos[0].name).toBe('banana'); // input untouched
  });

  it('sorts recent and duration descending', () => {
    expect(sortVideos(videos, 'recent').map((v) => v.name)).toEqual(['Apple', 'banana', 'cherry']);
    expect(sortVideos(videos, 'duration').map((v) => v.name)).toEqual(['Apple', 'cherry', 'banana']);
  });

  it('falls back to name order for unknown modes', () => {
    expect(sortVideos(videos, 'nope').map((v) => v.name)).toEqual(['Apple', 'banana', 'cherry']);
  });
});

describe('hitRegion', () => {
  // Canvas is 1000x500 px. UV origin is BOTTOM-left; regions use top-left
  // pixel space, so the y flip is the behaviour under test.
  const regions = [
    { id: 'row', x: 0, y: 100, w: 1000, h: 50 },   // band y=100..150 from top
    { id: 'footer', x: 800, y: 400, w: 150, h: 80 }, // registered LATER → on top
    { id: 'covers-footer-part', x: 850, y: 410, w: 100, h: 60 },
  ];

  it('hits a region from UV with the vertical flip', () => {
    // v = 1 - 120/500 = 0.76 → y=120 inside the row band (y=100..150).
    expect(hitRegion(regions, 0.5, 0.76, 1000, 500)?.id).toBe('row');
    // v = 1 - 90/500 = 0.82 → y=90 sits just ABOVE the band.
    expect(hitRegion(regions, 0.5, 0.82, 1000, 500)).toBeNull();
    // v = 1 - 160/500 = 0.68 → y=160 sits just BELOW the band.
    expect(hitRegion(regions, 0.5, 0.68, 1000, 500)).toBeNull();
  });

  it('misses outside every region', () => {
    expect(hitRegion(regions, 0.5, 0.1, 1000, 500)).toBeNull(); // y=450 but x=500: left of footer
    expect(hitRegion(regions, 0.0, 0.0, 1000, 500)).toBeNull(); // bottom-left corner
    expect(hitRegion(null, 0.5, 0.5, 1000, 500)).toBeNull();
  });

  it('gives later-registered regions priority on overlap', () => {
    // Overlap point inside both 'footer' and 'covers-footer-part'.
    const hit = hitRegion(regions, 0.9, 1 - 420 / 500, 1000, 500);
    expect(hit?.id).toBe('covers-footer-part');
  });
});

describe('canonicalPath', () => {
  it('flips separators, trims trailing slashes, keeps the unix root', () => {
    expect(canonicalPath('C:\\Videos\\Set A\\a.mp4')).toBe('c:/Videos/Set A/a.mp4');
    expect(canonicalPath('C:/Videos///')).toBe('c:/Videos');
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('')).toBe('');
    expect(canonicalPath(undefined)).toBe('');
  });

  it('lowercases ONLY the leading drive letter (desktop rule, case-sensitive rest)', () => {
    expect(canonicalPath('D:\\VR')).toBe('d:/VR');
    expect(canonicalPath('c:\\Users\\me\\Downloads')).toBe('c:/Users/me/Downloads');
    expect(canonicalPath('C:\\videos\\SET B')).toBe('c:/videos/SET B');
  });
});

describe('buildFolderIndex / descendantsOf', () => {
  const sources = [
    { id: 's1', name: 'VR Drive', path: 'D:\\VR' },
    { id: 's2', name: 'Downloads', path: 'C:\\Users\\me\\Downloads' },
  ];

  it('seeds enabled source roots with their name labels even when empty', () => {
    const index = buildFolderIndex([], sources);
    expect([...index.keys()].sort()).toEqual(['c:/Users/me/Downloads', 'd:/VR']);
    const root = index.get('d:/VR');
    expect(root.isSourceRoot).toBe(true);
    expect(root.sourceId).toBe('s1');
    expect(root.label).toBe('VR Drive');
    expect(root.parent).toBeNull();
  });

  it('drops sources explicitly disabled', () => {
    const index = buildFolderIndex([], [
      { id: 's1', name: 'Off', path: 'D:\\VR', enabled: false },
    ]);
    expect(index.size).toBe(0);
  });

  it('wires videos to their folder, ancestors up to the source root', () => {
    const videos = [
      { id: 'a', path: 'D:\\VR\\japanese\\studio-x\\a.mp4' },
      { id: 'b', path: 'C:\\Users\\me\\Downloads\\b.mp4' },
    ];
    const index = buildFolderIndex(videos, sources);
    const leaf = index.get('d:/VR/japanese/studio-x');
    expect(leaf.videos.map((v) => v.id)).toEqual(['a']);
    expect(leaf.label).toBe('studio-x');
    const mid = index.get('d:/VR/japanese');
    expect([...mid.childFolders]).toEqual(['d:/VR/japanese/studio-x']);
    expect(mid.parent).toBe('d:/VR');
    expect(index.get('d:/VR').childFolders.has('d:/VR/japanese')).toBe(true);
    expect(index.get('d:/VR/japanese').parent).toBe('d:/VR');
    expect(index.get('c:/Users/me/Downloads').videos.map((v) => v.id)).toEqual(['b']);
  });

  it('never walks above a source root and skips videos no source owns', () => {
    const index = buildFolderIndex([{ id: 'x', path: 'Z:\\Lost\\x.mp4' }], sources);
    expect(index.has('z:/Lost')).toBe(false);
    expect(index.has('z:')).toBe(false);
    expect(index.get('d:/VR').videos).toEqual([]);
    expect(index.get('c:/Users/me/Downloads').videos).toEqual([]);
  });

  it('treats mixed separators as the same folder', () => {
    const index = buildFolderIndex([
      { id: 'a', path: 'D:/VR/studio/a.mp4' },
      { id: 'b', path: 'D:\\VR\\studio\\b.mp4' },
    ], sources);
    expect(index.get('d:/VR/studio').videos.map((v) => v.id)).toEqual(['a', 'b']);
  });

  it('descendantsOf collects the folder plus every nested subfolder', () => {
    const videos = [
      { id: 'a', path: 'D:\\VR\\japanese\\studio-x\\a.mp4' },
      { id: 'b', path: 'D:\\VR\\japanese\\b.mp4' },
      { id: 'c', path: 'D:\\VR\\c.mp4' },
    ];
    const index = buildFolderIndex(videos, sources);
    expect(descendantsOf(index, 'd:/VR').map((v) => v.id).sort()).toEqual(['a', 'b', 'c']);
    expect(descendantsOf(index, 'd:/VR/japanese').map((v) => v.id).sort()).toEqual(['a', 'b']);
    expect(descendantsOf(index, 'd:/VR/japanese/studio-x').map((v) => v.id)).toEqual(['a']);
    expect(descendantsOf(index, 'z:/nowhere')).toEqual([]);
  });
});
