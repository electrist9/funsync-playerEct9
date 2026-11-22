// Unit tests for the borderless-window fullscreen state module.
//
// The module keeps module-level state (a singleton per renderer), so each
// test re-imports a fresh instance with vi.resetModules() and installs a
// fake `window.funsync` bridge where needed.

import { describe, it, expect, afterEach, vi } from 'vitest';

async function freshModule() {
  vi.resetModules();
  return import('../../renderer/js/window-fullscreen.js');
}

function installFakeBridge(initial = false) {
  let pushCb = null;
  const bridge = {
    setWindowFullscreen: vi.fn(async (on) => !!on),
    getWindowFullscreen: vi.fn(async () => initial),
    onWindowFullscreenChanged: vi.fn((cb) => {
      pushCb = cb;
      return () => { pushCb = null; };
    }),
  };
  window.funsync = bridge;
  return {
    bridge,
    // Simulate main pushing `window:fullscreen-changed` (e.g. the F11 menu
    // role toggled the window without the renderer asking).
    push: (on) => { if (pushCb) pushCb(!!on); },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('window-fullscreen', () => {
  afterEach(() => {
    delete window.funsync;
  });

  it('starts inactive and reports no bridge outside Electron', async () => {
    const m = await freshModule();
    expect(m.isWindowFullscreen()).toBe(false);
    expect(m.hasWindowFullscreenBridge()).toBe(false);
  });

  it('setWindowFullscreen is a no-op without the bridge', async () => {
    const m = await freshModule();
    const result = await m.setWindowFullscreen(true);
    expect(result).toBe(false);
    expect(m.isWindowFullscreen()).toBe(false);
  });

  it('setWindowFullscreen(true) activates state and dispatches the event', async () => {
    const m = await freshModule();
    const { bridge } = installFakeBridge();
    const seen = [];
    window.addEventListener('window-fullscreen-changed', (e) => seen.push(e.detail.on));

    const result = await m.setWindowFullscreen(true);
    expect(bridge.setWindowFullscreen).toHaveBeenCalledWith(true);
    expect(result).toBe(true);
    expect(m.isWindowFullscreen()).toBe(true);
    expect(seen).toEqual([true]);

    await m.setWindowFullscreen(false);
    expect(m.isWindowFullscreen()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('exitWindowFullscreen leaves fullscreen and never throws on bridge failure', async () => {
    const m = await freshModule();
    const { bridge } = installFakeBridge();
    await m.setWindowFullscreen(true);
    expect(await m.exitWindowFullscreen()).toBe(false);

    // A bridge that rejects mid-teardown must not throw out of the helper.
    await m.setWindowFullscreen(true);
    bridge.setWindowFullscreen.mockRejectedValueOnce(new Error('window gone'));
    await expect(m.exitWindowFullscreen()).resolves.toBeDefined();
  });

  it('installWindowFullscreenWatch adopts the current state on load', async () => {
    const m = await freshModule();
    installFakeBridge(true); // window was ALREADY fullscreen when this renderer loaded
    m.installWindowFullscreenWatch();
    await flush();
    expect(m.isWindowFullscreen()).toBe(true);
  });

  it('installWindowFullscreenWatch tracks pushes from main (F11 menu role)', async () => {
    const m = await freshModule();
    const { push } = installFakeBridge(false);
    m.installWindowFullscreenWatch();
    await flush();
    expect(m.isWindowFullscreen()).toBe(false);

    const seen = [];
    window.addEventListener('window-fullscreen-changed', (e) => seen.push(e.detail.on));
    push(true);
    expect(m.isWindowFullscreen()).toBe(true);
    expect(seen).toEqual([true]);

    push(false);
    expect(m.isWindowFullscreen()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('installWindowFullscreenWatch is idempotent and a no-op without the bridge', async () => {
    const m = await freshModule();
    m.installWindowFullscreenWatch(); // no bridge: must not throw
    const { bridge } = installFakeBridge(false);
    m.installWindowFullscreenWatch();
    m.installWindowFullscreenWatch();
    expect(bridge.onWindowFullscreenChanged).toHaveBeenCalledTimes(1);
  });
});
