/**
 * frame-interpolator.test.js — unit coverage for the WebGPU frame-generation
 * overlay and its VideoPlayer integration.
 *
 * Two layers, mirroring vr-flat-playback.test.js:
 *   1. FrameInterpolator pure logic — capability probe, gate decision,
 *      factor mapping, AIMD auto-factor controller. No real WebGPU: the
 *      GPU init/model-build steps are stubbed on the instance, and the
 *      vendored rt.js / toast / i18n modules are mocked at the module
 *      level so nothing touches the GPU or the DOM chrome.
 *   2. VideoPlayer integration — setFrameInterpolation option merging,
 *      the VR / pop-out suspension plumbing (_syncFrameInterpSuspension),
 *      and the status passthrough. The interpolator itself is a fake
 *      recording `update()` calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../renderer/js/i18n.js', () => ({ t: (key) => key }));
vi.mock('../../renderer/js/interpolation/rt.js', () => ({
  createRT: vi.fn(),
  tuneConvRB: vi.fn(),
}));
vi.mock('../../renderer/js/interpolation/sr.js', () => ({
  createSR: vi.fn(),
}));

import { showToast } from '../../renderer/js/toast.js';
import { FrameInterpolator, webglGpuName } from '../../renderer/js/frame-interpolator.js';
import { VideoPlayer } from '../../renderer/js/video-player.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bare instance with the fields _applyGate / _effectiveFactor / AIMD read. */
function bareInterpolator(overrides = {}) {
  const fi = Object.create(FrameInterpolator.prototype);
  Object.assign(fi, {
    _mounted: true,
    _active: false,
    _enabled: false,
    _upscale: false,
    _factor: 'auto',
    _quality: 'auto',
    _hud: false,
    _hudEl: null,
    _suspended: false,
    _gpuLost: false,
    _unsupported: false,
    _autoFactor: 2,
    _srcFps: 0,
    _refreshFps: 0,
    _video: { playbackRate: 1 },
    _container: { classList: { add: vi.fn(), remove: vi.fn() } },
    _ensureGpu: vi.fn().mockResolvedValue(undefined),
    _ensureModel: vi.fn().mockResolvedValue(undefined),
    _activate: vi.fn(function () { this._active = true; }),
    _deactivate: vi.fn(function () { this._active = false; }),
  }, overrides);
  return fi;
}

function classListStub() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      if (on) set.add(c);
      else set.delete(c);
    },
    _values: set,
  };
}

// ---------------------------------------------------------------------------
// 1. Capability probe
// ---------------------------------------------------------------------------

describe('FrameInterpolator.probe', () => {
  afterEach(() => {
    FrameInterpolator._probePromise = null;
    delete navigator.gpu;
  });

  it('reports no-webgpu when navigator.gpu is absent', async () => {
    const p = await FrameInterpolator.probe();
    expect(p).toMatchObject({ supported: false, reason: 'no-webgpu', f16: false });
  });

  it('reports no-adapter when requestAdapter resolves null', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => null },
    });
    const p = await FrameInterpolator.probe();
    expect(p).toMatchObject({ supported: false, reason: 'no-adapter', f16: false });
  });

  it('reports supported + f16 when the adapter has shader-f16', async () => {
    const adapter = { features: new Set(['shader-f16']) };
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => adapter },
    });
    const p = await FrameInterpolator.probe();
    expect(p).toMatchObject({ supported: true, f16: true });
    expect(p.adapter).toBe(adapter);
  });

  it('reports supported without f16 for older GPUs', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({ features: new Set() }) },
    });
    const p = await FrameInterpolator.probe();
    expect(p).toMatchObject({ supported: true, f16: false });
  });

  it('requestAdapter throwing degrades to no-webgpu', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: () => { throw new Error('boom'); } },
    });
    const p = await FrameInterpolator.probe();
    expect(p).toMatchObject({ supported: false, reason: 'no-webgpu' });
  });

  it('caches the probe promise', async () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({ features: new Set() }) },
    });
    const a = await FrameInterpolator.probe();
    const b = await FrameInterpolator.probe();
    expect(b).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// webglGpuName — HUD GPU-name fallback via the ANGLE renderer string
// (Chromium 131+ blanks adapter.info without DevTools attached)
// ---------------------------------------------------------------------------

describe('webglGpuName', () => {
  const origCreate = document.createElement;
  afterEach(() => { document.createElement = origCreate; });

  function stubGl(gl) {
    document.createElement = () => ({
      width: 0,
      height: 0,
      getContext: (kind) => (kind === 'webgl2' || kind === 'webgl' ? gl : null),
    });
  }

  it('extracts the device from an unmasked ANGLE string', () => {
    stubGl({
      RENDERER: 7937,
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37445 }),
      getParameter: (p) => (p === 37445
        ? 'ANGLE (NVIDIA GeForce RTX 4070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)'
        : 'OpenGL ES 3.0 (ANGLE 2.1)'),
    });
    expect(webglGpuName()).toBe('NVIDIA GeForce RTX 4070 SUPER');
  });

  it('drops the ANGLE vendor prefix from newer Chromium strings', () => {
    stubGl({
      RENDERER: 7937,
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37445 }),
      getParameter: (p) => (p === 37445
        ? 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11-9-1)'
        : 'OpenGL ES 3.0 (ANGLE 2.1)'),
    });
    expect(webglGpuName()).toBe('NVIDIA GeForce RTX 4070');
  });

  it('drops a trailing PCI device id suffix', () => {
    stubGl({
      RENDERER: 7937,
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37445 }),
      getParameter: (p) => (p === 37445
        ? 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER (0x2621-10DE) Direct3D11 vs_5_0 ps_5_0, D3D11-9-1)'
        : 'OpenGL ES 3.0 (ANGLE 2.1)'),
    });
    expect(webglGpuName()).toBe('NVIDIA GeForce RTX 4070 SUPER');
  });

  it('falls back to the masked RENDERER and strips (R)/(TM)', () => {
    stubGl({
      RENDERER: 7937,
      getExtension: () => null,
      getParameter: () => 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    });
    expect(webglGpuName()).toBe('Intel UHD Graphics 630');
  });

  it('returns empty string when no WebGL context is available', () => {
    stubGl(null);
    expect(webglGpuName()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. Factor mapping
// ---------------------------------------------------------------------------

describe('FrameInterpolator._effectiveFactor', () => {
  it('auto follows the AIMD state', () => {
    const fi = bareInterpolator({ _factor: 'auto', _autoFactor: 4 });
    expect(fi._effectiveFactor()).toBe(4);
  });

  it('numeric factors pass through (select values arrive as strings)', () => {
    expect(bareInterpolator({ _factor: 2 })._effectiveFactor()).toBe(2);
    expect(bareInterpolator({ _factor: '4' })._effectiveFactor()).toBe(4);
  });

  it('clamps to the 2..6 kernel range', () => {
    expect(bareInterpolator({ _factor: 9 })._effectiveFactor()).toBe(6);
    expect(bareInterpolator({ _factor: 1 })._effectiveFactor()).toBe(1);
  });

  it('off / garbage maps to 1 (no interpolation)', () => {
    expect(bareInterpolator({ _factor: 'off' })._effectiveFactor()).toBe(1);
    expect(bareInterpolator({ _factor: undefined })._effectiveFactor()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. AIMD auto-factor controller
// ---------------------------------------------------------------------------

describe('FrameInterpolator AIMD controller', () => {
  it('30fps source on a 120Hz panel wants 4×', () => {
    const fi = bareInterpolator({ _srcFps: 30, _refreshFps: 120 });
    expect(fi._desiredAutoFactor()).toBe(4);
  });

  it('60fps source on a 120Hz panel wants 2×', () => {
    const fi = bareInterpolator({ _srcFps: 60, _refreshFps: 120 });
    expect(fi._desiredAutoFactor()).toBe(2);
  });

  it('unknown rates fall back to the safe 2×', () => {
    expect(bareInterpolator({})._desiredAutoFactor()).toBe(2);
    expect(bareInterpolator({ _srcFps: 30, _refreshFps: 0 })._desiredAutoFactor()).toBe(2);
  });

  it('increases 2× → 4× only when the present queue runs dry', () => {
    const fi = bareInterpolator({ _srcFps: 30, _refreshFps: 120, _autoFactor: 2 });
    fi._aimdAdjust(1.0); // mid-band: hold
    expect(fi._autoFactor).toBe(2);
    fi._aimdAdjust(0.2); // starving: additive increase
    expect(fi._autoFactor).toBe(4);
    fi._aimdAdjust(0); // already at desired (4): no 6× from auto
    expect(fi._autoFactor).toBe(4);
  });

  it('backs off to 2× on queue backlog', () => {
    const fi = bareInterpolator({ _srcFps: 30, _refreshFps: 120, _autoFactor: 4 });
    fi._aimdAdjust(2.5);
    expect(fi._autoFactor).toBe(2);
  });

  it('does not raise past what the display can show', () => {
    // 60fps source, 120Hz panel: desired is 2×, so a dry queue must not push 4×.
    const fi = bareInterpolator({ _srcFps: 60, _refreshFps: 120, _autoFactor: 2 });
    fi._aimdAdjust(0);
    expect(fi._autoFactor).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Gate decision (_applyGate)
// ---------------------------------------------------------------------------

describe('FrameInterpolator gate', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('activates when enabled, rate 1.0, not suspended', async () => {
    const fi = bareInterpolator({ _enabled: true });
    await fi._applyGate();
    expect(fi._activate).toHaveBeenCalledTimes(1);
    expect(fi._deactivate).not.toHaveBeenCalled();
  });

  it('activates on upscale alone (TinySR without frame interpolation)', async () => {
    const fi = bareInterpolator({ _upscale: true });
    await fi._applyGate();
    expect(fi._activate).toHaveBeenCalledTimes(1);
    expect(fi._deactivate).not.toHaveBeenCalled();
  });

  it('deactivates when both interpolation and upscale are off', async () => {
    const fi = bareInterpolator({ _enabled: false, _upscale: false });
    await fi._applyGate();
    expect(fi._activate).not.toHaveBeenCalled();
    expect(fi._deactivate).toHaveBeenCalledTimes(1);
  });

  it('stays off while playback rate is not exactly 1.0', async () => {
    const fi = bareInterpolator({ _enabled: true, _video: { playbackRate: 1.5 } });
    await fi._applyGate();
    expect(fi._activate).not.toHaveBeenCalled();
    expect(fi._deactivate).toHaveBeenCalledTimes(1);
  });

  it('suspends for pop-out / VR ownership', async () => {
    const fi = bareInterpolator({ _enabled: true, _suspended: true });
    await fi._applyGate();
    expect(fi._activate).not.toHaveBeenCalled();
    expect(fi._deactivate).toHaveBeenCalledTimes(1);
  });

  it('stays off after a GPU device loss', async () => {
    const fi = bareInterpolator({ _enabled: true, _gpuLost: true });
    await fi._applyGate();
    expect(fi._activate).not.toHaveBeenCalled();
  });

  it('stays off when the device is not mounted', async () => {
    const fi = bareInterpolator({ _enabled: true, _mounted: false, _video: null });
    await fi._applyGate();
    expect(fi._activate).not.toHaveBeenCalled();
    expect(fi._deactivate).toHaveBeenCalledTimes(1);
  });

  it('init failure marks unsupported, deactivates and toasts once', async () => {
    const fi = bareInterpolator({
      _enabled: true,
      _ensureGpu: vi.fn().mockRejectedValue(new Error('no-adapter')),
    });
    await fi._applyGate();
    expect(fi._unsupported).toBe(true);
    expect(fi._deactivate).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('frameInterp.unsupported', 'warn', 4000);
  });

  it('update() merges settings and re-runs the gate', async () => {
    const fi = bareInterpolator();
    await fi.update({ enabled: true, factor: 4, quality: '720p', hud: true, upscale: true, suspended: false });
    expect(fi._enabled).toBe(true);
    expect(fi._factor).toBe(4);
    expect(fi._quality).toBe('720p');
    expect(fi._hud).toBe(true);
    expect(fi._upscale).toBe(true);
    expect(fi._activate).toHaveBeenCalledTimes(1);

    await fi.update({ suspended: true });
    expect(fi._enabled).toBe(true); // user setting preserved across suspension
    expect(fi._upscale).toBe(true);
    expect(fi._deactivate).toHaveBeenCalledTimes(1);
  });

  it('status exposes the gate + stats surface', () => {
    const fi = bareInterpolator({
      _enabled: true,
      _upscale: true,
      _factor: 'auto',
      _autoFactor: 4,
      _srcFps: 29.9,
      _refreshFps: 119.8,
      _gpuName: 'NVIDIA GeForce RTX 4070 SUPER',
    });
    expect(fi.status).toMatchObject({
      enabled: true,
      upscale: true,
      active: false,
      factor: 'auto',
      effectiveFactor: 4,
      suspended: false,
      gpuLost: false,
      unsupported: false,
      gpuName: 'NVIDIA GeForce RTX 4070 SUPER',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Present pass — regression guard for the black-canvas bug
// ---------------------------------------------------------------------------

describe('FrameInterpolator._present', () => {
  function presentFixture() {
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
    const encoder = { beginRenderPass: vi.fn(() => pass), finish: vi.fn(() => ({})) };
    const device = {
      // Real WebGPU: `lost` is a Promise — ALWAYS truthy. A guard like
      // `if (device.lost) return;` silently kills every present (black
      // canvas, audio keeps playing). `destroyed` is the boolean.
      lost: Promise.resolve({ reason: 'unknown' }),
      destroyed: false,
      createCommandEncoder: vi.fn(() => encoder),
      createBindGroup: vi.fn(() => ({})),
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    };
    const ctx = { getCurrentTexture: vi.fn(() => ({ createView: () => ({}) })) };
    const fi = bareInterpolator({
      _device: device,
      _ctx: ctx,
      _rect: null,
      _rectAt: 0,
      _rectData: new Float32Array(6),
      _presentBgCache: new Map(),
      _sampler: {},
      _uniformBuf: {},
      _presentBgl: {},
      _presentPipeline: {},
      canvas: { width: 1280, height: 720 },
      _video: { videoWidth: 1920, videoHeight: 1080, playbackRate: 1 },
    });
    return { fi, device, ctx, pass, encoder };
  }

  it('draws a frame when the device is healthy (device.lost must not gate it)', () => {
    const { fi, device, pass } = presentFixture();
    fi._present({ createView: () => ({}) });
    expect(device.createCommandEncoder).toHaveBeenCalledTimes(1);
    expect(pass.draw).toHaveBeenCalledWith(3);
    expect(device.queue.submit).toHaveBeenCalledTimes(1);
  });

  it('bind group is cached per source texture', () => {
    const { fi, device } = presentFixture();
    const tex = { createView: () => ({}) };
    fi._present(tex);
    fi._present(tex);
    expect(device.createBindGroup).toHaveBeenCalledTimes(1);
  });

  it('skips the present once the device is destroyed', () => {
    const { fi, device } = presentFixture();
    device.destroyed = true;
    fi._present({ createView: () => ({}) });
    expect(device.createCommandEncoder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Activate/deactivate canvas visibility — regression guard for the
//    "OFF leaves a black canvas over the video" bug
// ---------------------------------------------------------------------------

describe('FrameInterpolator activate/deactivate canvas visibility', () => {
  function visFixture(hud = false) {
    const canvas = { hidden: true };
    const hudEl = { hidden: true };
    const fi = bareInterpolator({
      canvas,
      _hudEl: hudEl,
      _hud: hud,
      _startLoops: vi.fn(),
      _stopLoops: vi.fn(),
      // Exercise the REAL activate/deactivate (bareInterpolator stubs them).
      _activate: FrameInterpolator.prototype._activate,
      _deactivate: FrameInterpolator.prototype._deactivate,
    });
    return { fi, canvas, hudEl };
  }

  it('reveals the canvas on activate and hides it again on deactivate', () => {
    const { fi, canvas, hudEl } = visFixture();
    fi._activate();
    expect(canvas.hidden).toBe(false);
    expect(fi._container.classList.add).toHaveBeenCalledWith('player__video-wrapper--frame-interp');
    fi._deactivate();
    expect(canvas.hidden).toBe(true);
    expect(fi._container.classList.remove).toHaveBeenCalledWith('player__video-wrapper--frame-interp');
    expect(hudEl.hidden).toBe(true);
  });

  it('shows the HUD only when hud is on AND the interpolator is active', () => {
    const { fi, hudEl } = visFixture(false);
    fi._activate();
    expect(hudEl.hidden).toBe(true); // hud off → hidden even while active
    fi._deactivate();
    fi._hud = true;
    fi._activate();
    expect(hudEl.hidden).toBe(false);
    fi._deactivate();
    expect(hudEl.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6b. Upscale-only mode — FI off must stop interpolation even with _rt loaded
// ---------------------------------------------------------------------------

describe('FrameInterpolator upscale-only mode', () => {
  function afterCopyFixture(enabled) {
    const rt = { prepPair: vi.fn(), runT: vi.fn(), w: 64, h: 64 };
    const fi = bareInterpolator({
      _active: true,
      _enabled: enabled,
      _upscale: true,
      _factor: '4',
      _rt: rt,
      _curTex: { t: 'cur' },
      _ring: [[{ t: 'b0' }, { t: 'b1' }, { t: 'b2' }], [{ t: 'c0' }, { t: 'c1' }, { t: 'c2' }]],
      _parity: 0,
      _presentQ: [],
      _pushPresent: vi.fn(),
      _prevTex: null,
    });
    return { fi, rt };
  }

  it('skips mid generation when FI is off but the loaded _rt is still present', () => {
    const { fi, rt } = afterCopyFixture(false);
    const next = { t: 'next' };
    fi._afterCopy(next);
    expect(rt.prepPair).not.toHaveBeenCalled();
    expect(rt.runT).not.toHaveBeenCalled();
    expect(fi._pushPresent).toHaveBeenCalledTimes(1);
    expect(fi._pushPresent).toHaveBeenCalledWith(next, false);
    expect(fi._curTex).toBe(next);
  });

  it('still generates mids when FI is on (control)', () => {
    const { fi, rt } = afterCopyFixture(true);
    fi._afterCopy({ t: 'next' });
    expect(rt.prepPair).toHaveBeenCalledTimes(1);
    expect(rt.runT).toHaveBeenCalledTimes(3); // factor 4 → 3 mids
    expect(fi._pushPresent).toHaveBeenCalledTimes(4); // 3 mids + the real frame
  });

  it('HUD omits the factor in upscale-only mode', () => {
    const fi = bareInterpolator({
      _hud: true,
      _hudEl: { textContent: '', hidden: false },
      _enabled: false,
      _upscale: true,
      _factor: '4',
      _srcFps: 25,
      _outFps: 25,
      _gpuName: 'NVIDIA GeForce RTX 4070 SUPER',
    });
    fi._updateHud();
    expect(fi._hudEl.textContent).toBe('SR2× 25→25fps · NVIDIA GeForce RTX 4070 SUPER');
    fi._enabled = true;
    fi._outFps = 100;
    fi._updateHud();
    expect(fi._hudEl.textContent).toBe('4× SR2× 25→100fps · NVIDIA GeForce RTX 4070 SUPER');
  });

  it('presents each unique frame once and skips redundant re-presents', () => {
    const fi = bareInterpolator({
      _active: true,
      _presentQ: [{ tex: { t: 'a' }, mid: false }],
      _lastTex: null,
      _present: vi.fn(),
      _boundRaf: () => {},
      _outCount: 0,
      _lastRafAt: 0,
      _aimdAt: 0,
      _lastOutAt: 0,
      _lastHudAt: 0,
      _queueSum: 0,
      _queueN: 0,
    });
    fi._rafLoop(1000);
    expect(fi._present).toHaveBeenCalledTimes(1);
    expect(fi._outFps).toBe(1); // out-fps counts unique frames, not refresh ticks
    fi._rafLoop(1008); // empty queue → no duplicate blit at the refresh rate
    expect(fi._present).toHaveBeenCalledTimes(1);
    fi._presentDirty = true; // canvas cleared (resize) → force one redraw
    fi._rafLoop(1016);
    expect(fi._present).toHaveBeenCalledTimes(2);
    expect(fi._presentDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. VideoPlayer integration
// ---------------------------------------------------------------------------

describe('VideoPlayer frame-interpolation integration', () => {
  let player;
  let videoEl;
  let containerEl;
  let fi;

  beforeEach(() => {
    const videoClasses = classListStub();
    containerEl = { classList: classListStub() };
    videoEl = {
      classList: videoClasses,
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      parentElement: containerEl,
    };
    fi = {
      mounted: true,
      update: vi.fn().mockResolvedValue(undefined),
      status: { enabled: true, active: true, effectiveFactor: 4 },
    };
    player = Object.create(VideoPlayer.prototype);
    player.video = videoEl;
    player._vrFlattenFormat = null;
    player._vrFlattenEye = 1;
    player._vrRenderer = null;
    player._frameInterpolator = fi;
    player._frameInterpOpts = undefined;
  });

  it('setFrameInterpolation merges options and pushes them to the interpolator', () => {
    player.setFrameInterpolation({ enabled: true, factor: '4', quality: '720p', hud: true });
    expect(fi.update).toHaveBeenCalledWith({
      enabled: true,
      factor: '4',
      quality: '720p',
      hud: true,
      upscale: false,
      suspended: false,
    });
  });

  it('defaults factor/quality to auto and hud off when unset', () => {
    player.setFrameInterpolation({ enabled: true });
    expect(fi.update).toHaveBeenCalledWith({
      enabled: true,
      factor: 'auto',
      quality: 'auto',
      hud: false,
      upscale: false,
      suspended: false,
    });
  });

  it('upscale passes through to update() and persists across calls', () => {
    player.setFrameInterpolation({ upscale: true });
    expect(fi.update.mock.calls.at(-1)[0]).toMatchObject({ enabled: false, upscale: true });
    player.setFrameInterpolation({ suspended: true });
    expect(fi.update.mock.calls.at(-1)[0]).toMatchObject({ upscale: true, suspended: true });
  });

  it('upscale-only mounts the interpolator even with interpolation off', () => {
    player._frameInterpolator = null;
    const mount = vi.fn();
    player._mountFrameInterpolatorIfNeeded = mount;
    player.setFrameInterpolation({ enabled: false, upscale: true });
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('does not mount when both interpolation and upscale are off', () => {
    player._frameInterpolator = null;
    const mount = vi.fn();
    player._mountFrameInterpolatorIfNeeded = mount;
    player.setFrameInterpolation({ enabled: false, upscale: false });
    expect(mount).not.toHaveBeenCalled();
  });

  it('external suspension (pop-out) ORs into the update payload', () => {
    player.setFrameInterpolation({ enabled: true, factor: 2 });
    player.setFrameInterpolation({ suspended: true });
    const last = fi.update.mock.calls.at(-1)[0];
    expect(last).toMatchObject({ enabled: true, factor: 2, suspended: true });
    player.setFrameInterpolation({ suspended: false });
    expect(fi.update.mock.calls.at(-1)[0]).toMatchObject({ suspended: false });
  });

  it('photo slideshow active suspends interpolation, inactive releases it', () => {
    player.setFrameInterpolation({ enabled: true, upscale: true });
    fi.update.mockClear();

    player.setFrameInterpSlideshowActive(true);
    expect(fi.update).toHaveBeenCalledWith({ suspended: true });

    player.setFrameInterpSlideshowActive(false);
    expect(fi.update).toHaveBeenCalledWith({ suspended: false });
  });

  it('slideshow suspension ORs into later setFrameInterpolation payloads', () => {
    player.setFrameInterpSlideshowActive(true);
    player.setFrameInterpolation({ enabled: true });
    expect(fi.update.mock.calls.at(-1)[0]).toMatchObject({ enabled: true, suspended: true });
    player.setFrameInterpSlideshowActive(false);
    expect(fi.update.mock.calls.at(-1)[0]).toMatchObject({ suspended: false });
  });

  it('planar VR flatten suspends interpolation, off releases it', () => {
    player.setFrameInterpolation({ enabled: true });
    fi.update.mockClear();

    player.setVRFlatten('sbs-half', 1);
    expect(fi.update).toHaveBeenCalledWith({ suspended: true });

    player.setVRFlatten('off');
    expect(fi.update).toHaveBeenCalledWith({ suspended: false });
  });

  it('non-planar VR (renderer mounted) suspends interpolation', () => {
    const renderer = {
      mounted: true,
      unmount: vi.fn(() => { renderer.mounted = false; }),
      setProjection: vi.fn(),
      setEye: vi.fn(),
      setStereoMode: vi.fn(),
      setFov: vi.fn(),
      setYawPitch: vi.fn(),
    };
    player._vrRenderer = renderer;
    player.setFrameInterpolation({ enabled: true });
    fi.update.mockClear();

    player.setVRFlatten('equirect-180', 1);
    expect(fi.update).toHaveBeenCalledWith({ suspended: true });

    player.setVRFlatten('off');
    expect(renderer.unmount).toHaveBeenCalled();
    expect(fi.update).toHaveBeenCalledWith({ suspended: false });
  });

  it('_syncFrameInterpSuspension is a no-op without an interpolator', () => {
    player._frameInterpolator = null;
    expect(() => player._syncFrameInterpSuspension()).not.toThrow();
  });

  it('frameInterpolationStatus passes through the interpolator status', () => {
    expect(player.frameInterpolationStatus).toEqual({ enabled: true, active: true, effectiveFactor: 4 });
    player._frameInterpolator = null;
    expect(player.frameInterpolationStatus).toBeNull();
  });
});
