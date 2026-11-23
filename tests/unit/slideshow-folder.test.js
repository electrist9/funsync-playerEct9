// @vitest-environment node
/**
 * Shared slideshow photo folder (player.slideshowFolder).
 *
 * The old per-video map (library.slideshowFolders) is gone: one folder is
 * shared app-wide and persisted. library.slideshowLastFolder is only ever
 * READ once as a migration seed for pre-2026-11-21 stores.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlideshowController } from '../../renderer/js/slideshow.js';
import { openPhotoFolderBrowser } from '../../renderer/components/photo-folder-browser.js';

// slideshow.js lazy-imports the browser only when the picker mode is
// 'inapp'; the factory keeps that dynamic import off the jsdom component.
vi.mock('../../renderer/components/photo-folder-browser.js', () => ({
  openPhotoFolderBrowser: vi.fn(),
}));

const el = () => ({ addEventListener() {} });

function makeController(initial = {}) {
  const store = { ...initial };
  const settings = {
    get: (key) => store[key],
    set: (key, value) => { store[key] = value; },
  };
  const controller = new SlideshowController({
    video: el(),
    wrapper: el(),
    layer: el(),
    imgA: el(),
    imgB: el(),
    wipeBtn: el(),
    settings,
    getActions: () => null,
    isScriptLoaded: () => false,
  });
  return { controller, store };
}

describe('SlideshowController shared photo folder', () => {
  it('resolveFolder reads the shared player.slideshowFolder', () => {
    const { controller } = makeController({ 'player.slideshowFolder': 'C:\\Pictures\\trip' });
    expect(controller.resolveFolder()).toBe('C:\\Pictures\\trip');
  });

  it('seeds from the legacy library.slideshowLastFolder (migration)', () => {
    const { controller } = makeController({
      'player.slideshowFolder': '',
      'library.slideshowLastFolder': 'D:\\Photos\\old',
    });
    expect(controller.resolveFolder()).toBe('D:\\Photos\\old');
  });

  it('returns null when no folder was ever chosen', () => {
    const { controller } = makeController({});
    expect(controller.resolveFolder()).toBeNull();
  });

  it('_persistFolder writes ONLY player.slideshowFolder', () => {
    const { controller, store } = makeController({
      'library.slideshowLastFolder': 'D:\\Photos\\old',
      'library.slideshowFolders': { 'C:\\v.mp4': 'E:\\stale' },
    });
    controller._persistFolder('C:\\Pictures\\new');
    expect(store['player.slideshowFolder']).toBe('C:\\Pictures\\new');
    // Legacy keys are never written anymore.
    expect(store['library.slideshowLastFolder']).toBe('D:\\Photos\\old');
    expect(store['library.slideshowFolders']).toEqual({ 'C:\\v.mp4': 'E:\\stale' });
    // The new shared value wins over the legacy seed.
    expect(controller.resolveFolder()).toBe('C:\\Pictures\\new');
  });
});

/**
 * Mid-playback folder changes must replace the displayed photo immediately.
 * _showPhoto used to early-return on `idx === _shownIdx`, so a re-listed
 * (or rearranged) image list with the same index kept showing the old
 * folder's photo until the next segment boundary.
 */
const fakeImg = () => {
  const classes = new Set();
  return {
    src: '',
    offsetWidth: 0,
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    addEventListener() {},
    removeAttribute() { this.src = ''; },
  };
};

function makeActiveController(readSlideshowImage) {
  const prev = globalThis.window;
  globalThis.window = { funsync: { readSlideshowImage } };
  const imgA = fakeImg();
  const imgB = fakeImg();
  const settings = { get: () => undefined, set() {} };
  const controller = new SlideshowController({
    video: { currentTime: 0, style: {}, addEventListener() {} },
    wrapper: { classList: { add() {}, remove() {} }, addEventListener() {} },
    layer: { hidden: true, style: {}, appendChild() {} },
    imgA,
    imgB,
    wipeBtn: fakeImg(),
    settings,
    getActions: () => null,
    isScriptLoaded: () => true,
  });
  controller._active = true;
  controller._folder = 'A';
  const visibleSrc = () => (controller._front === imgA ? imgA.src : imgB.src);
  return { controller, visibleSrc, restore: () => { globalThis.window = prev; } };
}

describe('SlideshowController folder switch while running', () => {
  it('re-shows the photo when the folder changed the path at the same index', () => {
    const h = makeActiveController(async () => null);
    try {
      h.controller._images = ['A\\1.jpg'];
      h.controller._cache.set('A\\1.jpg', 'urlA');
      h.controller._showPhoto(0);
      expect(h.visibleSrc()).toBe('urlA');

      // setFolder replaced the list: same index, different photo.
      h.controller._images = ['B\\1.jpg'];
      h.controller._cache.set('B\\1.jpg', 'urlB');
      h.controller._showPhoto(0);
      expect(h.visibleSrc()).toBe('urlB');
      expect(h.controller._shownPath).toBe('B\\1.jpg');
    } finally { h.restore(); }
  });

  it('a pending load from the old folder never overwrites the new photo', async () => {
    let resolveA;
    const h = makeActiveController(() => new Promise((r) => { resolveA = r; }));
    try {
      h.controller._images = ['A\\1.jpg'];
      h.controller._showPhoto(0); // starts an in-flight load of A
      h.controller._images = ['B\\1.jpg'];
      h.controller._cache.set('B\\1.jpg', 'urlB');
      h.controller._showPhoto(0); // instant swap to B from cache
      expect(h.visibleSrc()).toBe('urlB');

      resolveA('urlA'); // stale A load lands late
      await new Promise((r) => setTimeout(r, 0));
      expect(h.visibleSrc()).toBe('urlB');
    } finally { h.restore(); }
  });
});

/**
 * Picker mode (player.slideshowFolderPicker): 'inapp' (default) opens the
 * thumbnail-browser modal, 'os' keeps the native folder dialog.
 */
describe('SlideshowController._pickFolder picker mode', () => {
  beforeEach(() => {
    openPhotoFolderBrowser.mockReset();
  });

  it('defaults to the in-app browser and seeds it with the current folder', async () => {
    openPhotoFolderBrowser.mockResolvedValue('C:\\Picked');
    const { controller } = makeController({ 'player.slideshowFolder': 'C:\\Pictures\\trip' });
    const picked = await controller._pickFolder();
    expect(picked).toBe('C:\\Picked');
    expect(openPhotoFolderBrowser).toHaveBeenCalledWith('C:\\Pictures\\trip');
  });

  it('opens the browser with a null start path when no folder is set', async () => {
    openPhotoFolderBrowser.mockResolvedValue(null);
    const { controller } = makeController({});
    expect(await controller._pickFolder()).toBeNull();
    expect(openPhotoFolderBrowser).toHaveBeenCalledWith(null);
  });

  it('uses window.funsync.selectDirectory when the mode is "os"', async () => {
    const prev = globalThis.window;
    globalThis.window = { funsync: { selectDirectory: async () => 'D:\\OS\\Pics' } };
    try {
      const { controller } = makeController({ 'player.slideshowFolderPicker': 'os' });
      expect(await controller._pickFolder()).toBe('D:\\OS\\Pics');
      expect(openPhotoFolderBrowser).not.toHaveBeenCalled();
    } finally {
      globalThis.window = prev;
    }
  });

  it('"os" mode cancels to null', async () => {
    const prev = globalThis.window;
    globalThis.window = { funsync: { selectDirectory: async () => null } };
    try {
      const { controller } = makeController({ 'player.slideshowFolderPicker': 'os' });
      expect(await controller._pickFolder()).toBeNull();
    } finally {
      globalThis.window = prev;
    }
  });

  it('unknown mode values fall back to the in-app browser', async () => {
    openPhotoFolderBrowser.mockResolvedValue('C:\\Picked');
    const { controller } = makeController({ 'player.slideshowFolderPicker': 'bogus' });
    expect(await controller._pickFolder()).toBe('C:\\Picked');
    expect(openPhotoFolderBrowser).toHaveBeenCalledTimes(1);
  });

  it('a browser failure is swallowed to null', async () => {
    openPhotoFolderBrowser.mockRejectedValue(new Error('modal blew up'));
    const { controller } = makeController({});
    expect(await controller._pickFolder()).toBeNull();
  });
});
