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
