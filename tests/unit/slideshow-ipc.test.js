/**
 * @vitest-environment node
 * No DOM required — the slideshow IPC helpers are pure file-path logic.
 */
// Unit tests for electron/slideshow-images.js — the listing/filter/guard
// logic behind the `list-slideshow-images` and `read-slideshow-image` IPC
// handlers in electron/main.js (photo slideshow during playback).
// Same pattern as electron/funscript-variants.js: the module is plain CJS
// with no Electron imports, so tests import it directly.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  SLIDESHOW_MAX_IMAGES,
  isSlideshowImageName,
  naturalCompare,
  collectSlideshowImages,
  isWithinFolder,
  fitSlideshowSize,
  imageMimeForExt,
} from '../../electron/slideshow-images.js';

// Helpers: fake fs.Dirent-like objects as produced by
// fs.promises.readdir(dir, { withFileTypes: true, recursive: true }).
const file = (name, parentPath) => ({ name, isFile: () => true, parentPath });
const dir = (name, parentPath) => ({ name, isFile: () => false, parentPath });

describe('isSlideshowImageName', () => {
  it('accepts every supported extension, case-insensitively', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif']) {
      expect(isSlideshowImageName(`photo.${ext}`)).toBe(true);
      expect(isSlideshowImageName(`IMG.${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it('rejects non-image extensions, missing extensions, and dot-files', () => {
    expect(isSlideshowImageName('video.mp4')).toBe(false);
    expect(isSlideshowImageName('script.funscript')).toBe(false);
    expect(isSlideshowImageName('README')).toBe(false);
    expect(isSlideshowImageName('.hidden.jpg')).toBe(false);
    expect(isSlideshowImageName('')).toBe(false);
  });
});

describe('naturalCompare', () => {
  it('orders embedded numbers numerically', () => {
    expect(naturalCompare('img2.png', 'img10.png')).toBe(-1);
    expect(naturalCompare('img10.png', 'img2.png')).toBe(1);
  });

  it('is case-insensitive and returns 0 for equal strings', () => {
    expect(naturalCompare('IMG1.JPG', 'img1.jpg')).toBe(0);
    expect(naturalCompare('a', 'a')).toBe(0);
  });

  it('shorter prefix sorts first', () => {
    expect(naturalCompare('img', 'img1')).toBe(-1);
  });
});

describe('collectSlideshowImages', () => {
  const root = path.resolve('X:\\pics');

  it('keeps only image files, recursively, with case-insensitive extensions', () => {
    const entries = [
      file('a.jpg', root),
      file('B.PNG', root),
      file('movie.mp4', root),
      file('notes.txt', root),
      file('deep.webp', path.join(root, 'sub')),
      file('DEEP2.AVI', path.join(root, 'sub')),
      dir('sub', root),
    ];
    const out = collectSlideshowImages(entries, root);
    expect(out).toEqual([
      path.join(root, 'a.jpg'),
      path.join(root, 'B.PNG'),
      path.join(root, 'sub', 'deep.webp'),
    ]);
  });

  it('skips dot-directories and dot-files', () => {
    const entries = [
      file('.hidden.jpg', root),
      file('visible.jpg', root),
      file('cached.jpg', path.join(root, '.thumbnails')),
      dir('.thumbnails', root),
    ];
    const out = collectSlideshowImages(entries, root);
    expect(out).toEqual([path.join(root, 'visible.jpg')]);
  });

  it('sorts by basename naturally across subdirectories', () => {
    const entries = [
      file('img10.png', path.join(root, 'b')),
      file('img2.png', path.join(root, 'a')),
      file('img1.png', root),
    ];
    const out = collectSlideshowImages(entries, root);
    expect(out.map((p) => path.basename(p))).toEqual(['img1.png', 'img2.png', 'img10.png']);
  });

  it('caps the listing at SLIDESHOW_MAX_IMAGES', () => {
    const entries = [];
    for (let i = 0; i < SLIDESHOW_MAX_IMAGES + 10; i++) {
      entries.push(file(`img${i}.jpg`, root));
    }
    const out = collectSlideshowImages(entries, root);
    expect(out).toHaveLength(SLIDESHOW_MAX_IMAGES);
  });

  it('supports the legacy dirent `path` property (older Node)', () => {
    const entries = [{ name: 'old.jpg', isFile: () => true, path: path.join(root, 'sub') }];
    const out = collectSlideshowImages(entries, root);
    expect(out).toEqual([path.join(root, 'sub', 'old.jpg')]);
  });

  it('ignores non-array input and non-dirent entries', () => {
    expect(collectSlideshowImages(undefined, root)).toEqual([]);
    expect(collectSlideshowImages([null, { name: 'x.jpg' }], root)).toEqual([]);
  });
});

describe('isWithinFolder', () => {
  const folder = path.resolve('X:\\pics');

  it('accepts files inside the folder (nested included)', () => {
    expect(isWithinFolder(folder, path.join(folder, 'a.jpg'))).toBe(true);
    expect(isWithinFolder(folder, path.join(folder, 'sub', 'deep', 'b.png'))).toBe(true);
  });

  it('rejects traversal, siblings with a shared prefix, and the folder itself', () => {
    expect(isWithinFolder(folder, path.join(folder, '..', '..', 'evil.jpg'))).toBe(false);
    expect(isWithinFolder(folder, path.resolve('X:\\pics2\\a.jpg'))).toBe(false);
    expect(isWithinFolder(folder, folder)).toBe(false);
    expect(isWithinFolder(folder, path.resolve('X:\\other\\a.jpg'))).toBe(false);
  });

  it('rejects empty folder or file arguments', () => {
    expect(isWithinFolder('', path.join(folder, 'a.jpg'))).toBe(false);
    expect(isWithinFolder(folder, '')).toBe(false);
    expect(isWithinFolder(null, null)).toBe(false);
  });
});

describe('imageMimeForExt', () => {
  it('maps supported extensions and falls back to jpeg', () => {
    expect(imageMimeForExt('.png')).toBe('image/png');
    expect(imageMimeForExt('.WEBP')).toBe('image/webp');
    expect(imageMimeForExt('gif')).toBe('image/gif');
    expect(imageMimeForExt('.bmp')).toBe('image/bmp');
    expect(imageMimeForExt('.avif')).toBe('image/avif');
    expect(imageMimeForExt('.jpg')).toBe('image/jpeg');
    expect(imageMimeForExt('')).toBe('image/jpeg');
  });
});

describe('fitSlideshowSize', () => {
  it('scales portrait photos proportionally (no squash)', () => {
    // The 2026-11-23 bug: { width: 1920, height: 1920 } stretched a tall
    // photo to a square box — the renderer showed it squashed vertically.
    expect(fitSlideshowSize({ width: 1800, height: 2700 }, 1920))
      .toEqual({ width: 1280, height: 1920 });
  });

  it('scales landscape photos proportionally', () => {
    expect(fitSlideshowSize({ width: 4000, height: 2250 }, 1920))
      .toEqual({ width: 1920, height: 1080 });
  });

  it('returns null when the image already fits', () => {
    expect(fitSlideshowSize({ width: 1920, height: 1920 }, 1920)).toBeNull();
    expect(fitSlideshowSize({ width: 640, height: 480 }, 1920)).toBeNull();
  });

  it('caps the longest side at maxDim for any aspect ratio', () => {
    for (const [w, h] of [[3000, 1000], [1000, 3000], [5000, 5000], [2560, 1440]]) {
      const fit = fitSlideshowSize({ width: w, height: h }, 1920);
      expect(Math.max(fit.width, fit.height)).toBe(1920);
      const srcRatio = w / h;
      const fitRatio = fit.width / fit.height;
      expect(Math.abs(fitRatio - srcRatio) / srcRatio).toBeLessThan(0.01);
      expect(fit.width).toBeGreaterThanOrEqual(1);
      expect(fit.height).toBeGreaterThanOrEqual(1);
    }
  });

  it('never returns a zero dimension (degenerate aspect clamps to 1px)', () => {
    const fit = fitSlideshowSize({ width: 9999, height: 1 }, 1920);
    expect(fit).toEqual({ width: 1920, height: 1 });
  });

  it('falls back to the 1920 default for a missing/invalid maxDim', () => {
    expect(fitSlideshowSize({ width: 3840, height: 2160 }, 0))
      .toEqual({ width: 1920, height: 1080 });
    expect(fitSlideshowSize({ width: 3840, height: 2160 }, undefined))
      .toEqual({ width: 1920, height: 1080 });
  });

  it('returns null for an undecodable size', () => {
    expect(fitSlideshowSize({ width: 0, height: 0 }, 1920)).toBeNull();
    expect(fitSlideshowSize(null, 1920)).toBeNull();
  });
});
