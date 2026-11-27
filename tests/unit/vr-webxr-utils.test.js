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
  normalizePath,
  parentDir,
  baseName,
  folderGroups,
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

describe('path helpers', () => {
  it('normalizePath flips separators and trims trailing ones', () => {
    expect(normalizePath('C:\\Videos\\Set A\\a.mp4')).toBe('C:/Videos/Set A/a.mp4');
    expect(normalizePath('C:/Videos/')).toBe('C:/Videos');
    expect(normalizePath('')).toBe('');
    expect(normalizePath(undefined)).toBe('');
  });

  it('parentDir / baseName split at the last separator', () => {
    expect(parentDir('C:/Videos/a.mp4')).toBe('C:/Videos');
    expect(parentDir('a.mp4')).toBe('');
    expect(parentDir('')).toBe('');
    expect(baseName('C:/Videos/Set A')).toBe('Set A');
    expect(baseName('a.mp4')).toBe('a.mp4');
  });
});

describe('folderGroups', () => {
  const videos = [
    { id: 'a', path: 'C:\\Videos\\Set A\\a.mp4' },
    { id: 'b', path: 'C:\\Videos\\Set A\\deep\\inner\\b.mp4' },
    { id: 'c', path: 'C:\\videos\\SET B\\c.mp4' }, // case-differing root
    { id: 'd', path: 'C:\\Videos\\d.mp4' },
    { id: 'e', path: '' },
  ];

  it('auto root collapses to the minimal containing folders', () => {
    const g = folderGroups(videos, null);
    expect(g.folders.map((f) => [f.path, f.name, f.count])).toEqual([
      ['C:/Videos', 'Videos', 4], // A + B + C (case-differing root collapses) + D
    ]);
    expect(g.direct.map((v) => v.id)).toEqual(['e']); // path-less stay at root
  });

  it('drills one level: Set A and Set B under C:/Videos', () => {
    const g = folderGroups(videos, 'C:/Videos');
    expect(g.folders.map((f) => [f.name, f.count])).toEqual([
      ['Set A', 2], // a + b (b sits two levels deeper)
      ['SET B', 1], // kept with its original casing
    ]);
    expect(g.direct.map((v) => v.id)).toEqual(['d']);
  });

  it('empty folder yields no groups', () => {
    const g = folderGroups([], 'C:/Videos');
    expect(g.folders).toEqual([]);
    expect(g.direct).toEqual([]);
  });
});
