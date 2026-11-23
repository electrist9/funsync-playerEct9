// @vitest-environment node
/**
 * Shared slideshow photo folder (player.slideshowFolder).
 *
 * The old per-video map (library.slideshowFolders) is gone: one folder is
 * shared app-wide and persisted. library.slideshowLastFolder is only ever
 * READ once as a migration seed for pre-2026-11-21 stores.
 */
import { describe, it, expect } from 'vitest';
import { SlideshowController } from '../../renderer/js/slideshow.js';

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
