/**
 * frame-interpolator.js — real-time frame interpolation for the main-window
 * <video> (60fps → 120fps, 30fps → 120fps, …).
 *
 * Engine: the vendored web/rt RIFE kernels (js/interpolation/rt.js, MIT;
 * weights rt_v7s — see js/interpolation/VENDORED.md for the weights-license
 * situation). Runs fully GPU-resident on WebGPU: per source frame pair the
 * trunk runs once (prepPair) and each inserted mid is a small FiLM(t) head
 * (runT with t = k/factor), so 2×–6× all cost roughly "trunk + n small heads".
 *
 * Presentation model (mirrors VRProjectionRenderer's canvas-overlay pattern):
 * a WebGPU canvas is appended after the <video> inside the wrapper and the
 * <video> is hidden via a wrapper class (visibility:hidden — NOT display:none,
 * which would throttle decoding). Every source frame AND every generated mid
 * is pushed to a present queue; a rAF loop drains one texture per display
 * tick, so a 120Hz panel fed by 4× interpolation of 30fps fills every tick.
 *
 * Gates (MVP): playback rate must be exactly 1.0 (Chromium's own frame
 * pacing breaks down otherwise and the funscript/device sync is rate-aware),
 * the pop-out player window owns its own <video> and is not interpolated
 * here, and VR modes (flatten transforms / non-planar projection) take over
 * the presentation path, so interpolation suspends while any VR mode is on.
 *
 * Factor control: 'auto' measures the source fps (rvfc mediaTime deltas) and
 * the display refresh (rAF deltas) and AIMD-adjusts between 2× and 4× so the
 * presented rate tracks the panel without the queue backing up.
 */

import { showToast } from './toast.js';
import { t } from './i18n.js';
import { createRT, tuneConvRB } from './interpolation/rt.js';

const MAX_MIDS = 5; // factor 6 → 5 inserted mids per pair
const INPUT_SLOTS = 3; // ping-pong + one spare so an async bitmap copy can't race the next rvfc
const RING_BANKS = 2; // double-buffered mid textures: a bank is only reused 2 pairs later
const MAX_PRESENT_QUEUE = 8; // backlog beyond this → drop oldest mids to resync
const AIMD_WINDOW_MS = 2000;
const TUNE_CACHE_PREFIX = 'fsInterpTune:';

/** Floor to a multiple of 16 — the rt kernels' hard requirement (w % 16 || h % 16 throws). */
function r16(n) {
  return Math.max(16, Math.floor(n / 16) * 16);
}

/** Quality preset → model rung cap (mids computed at ≤ this size, upscaled on present). */
const QUALITY_CAPS = Object.freeze({
  auto: [1920, 1080],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '480p': [848, 480],
  native: [4096, 4096],
});

const PRESENT_SHADER = /* wgsl */ `
struct PresentU {
  rect: vec4f,       // destination content rect in framebuffer px (may overflow for cover)
  canvasSize: vec2f,
  _pad: vec2f,
};

@group(0) @binding(0) var srcT: texture_2d<f32>;
@group(0) @binding(1) var sampT: sampler;
@group(0) @binding(2) var<uniform> u: PresentU;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) px: vec4f) -> @location(0) vec4f {
  let x = px.x;
  let y = px.y;
  if (x < u.rect.x || x >= u.rect.x + u.rect.z || y < u.rect.y || y >= u.rect.y + u.rect.w) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  let uv = vec2f((x - u.rect.x) / u.rect.z, (y - u.rect.y) / u.rect.w);
  return textureSampleLevel(srcT, sampT, uv, 0.0);
}
`;

export class FrameInterpolator {
  constructor() {
    this.canvas = null;
    this._video = null;
    this._container = null;
    this._mounted = false;
    this._active = false;

    // Settings (merged via update()).
    this._enabled = false;
    this._factor = 'auto'; // 'auto' | 2 | 4 | 6
    this._quality = 'auto'; // 'auto' | '1080p' | '720p' | '480p' | 'native'
    this._hud = false;
    this._hudEl = null;
    this._suspended = false;

    // GPU state.
    this._adapter = null;
    this._device = null;
    this._ctx = null;
    this._sampler = null;
    this._rt = null;
    this._initPromise = null;
    this._modelPromise = null;
    this._weightsBin = null;
    this._weightsManifest = null;
    this._gpuLost = false;
    this._unsupported = false;

    // Textures.
    this._inPool = [];
    this._inIdx = 0;
    this._ring = []; // [bank][mid]
    this._parity = 0;
    this._prevTex = null;
    this._curTex = null;

    // Present path.
    this._presentQ = [];
    this._lastTex = null;
    this._presentPipeline = null;
    this._presentBgl = null;
    this._presentBgCache = new Map();
    this._uniformBuf = null;
    this._rectData = new Float32Array(8);
    this._rect = null;
    this._rectAt = 0;

    // Loops.
    this._rvfcHandle = null;
    this._rafHandle = null;
    this._resizeObserver = null;
    this._videoListeners = [];

    // Stats / AIMD.
    this._srcFps = 0;
    this._refreshFps = 0;
    this._outFps = 0;
    this._autoFactor = 2;
    this._lastMediaTime = 0;
    this._lastRafAt = 0;
    this._lastOutAt = 0;
    this._outCount = 0;
    this._queueSum = 0;
    this._queueN = 0;
    this._aimdAt = 0;
    this._lastHudAt = 0;
    this._gpuName = '';
  }

  // ------------------------------------------------------------------
  // Capability probe (cached). Resolves { supported, reason, f16 }.
  // ------------------------------------------------------------------

  static _probePromise = null;

  static probe() {
    if (!FrameInterpolator._probePromise) {
      FrameInterpolator._probePromise = (async () => {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
          return { supported: false, reason: 'no-webgpu', f16: false };
        }
        try {
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          if (!adapter) return { supported: false, reason: 'no-adapter', f16: false };
          return { supported: true, reason: '', f16: adapter.features.has('shader-f16'), adapter };
        } catch {
          return { supported: false, reason: 'no-webgpu', f16: false };
        }
      })();
    }
    return FrameInterpolator._probePromise;
  }

  // ------------------------------------------------------------------
  // Mount / unmount (mirrors VRProjectionRenderer's lifecycle)
  // ------------------------------------------------------------------

  /** Create the overlay canvas + HUD and attach video listeners. Idempotent. */
  mount(videoEl, container) {
    if (this._mounted) return;
    if (!videoEl || !container) throw new Error('FrameInterpolator.mount: video and container required');

    const canvas = document.createElement('canvas');
    canvas.id = 'frame-interp-canvas';
    canvas.className = 'frame-interp-canvas';
    // Parked hidden: the canvas is opaque (#000) and paints above the
    // <video> sibling, so while inactive it must stay hidden or it covers
    // the video (black screen, audio only). Revealed in _activate().
    canvas.hidden = true;

    const hud = document.createElement('div');
    hud.className = 'frame-interp-hud';
    hud.hidden = !this._hud;

    container.appendChild(canvas);
    container.appendChild(hud);

    this.canvas = canvas;
    this._hudEl = hud;
    this._video = videoEl;
    this._container = container;
    this._mounted = true;

    this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
    this._resizeObserver.observe(container);
    this._resizeCanvas();

    const on = (ev, fn) => {
      videoEl.addEventListener(ev, fn);
      this._videoListeners.push([ev, fn]);
    };
    on('seeked', () => this._resetPairState());
    on('ratechange', () => this._applyGate());
    on('loadedmetadata', () => {
      this._resetPairState();
      this._rect = null;
      if (this._active) this._ensureModel().catch(() => {});
    });
  }

  unmount() {
    if (!this._mounted) return;
    this._stopLoops();
    this._active = false;

    for (const [ev, fn] of this._videoListeners) {
      this._video?.removeEventListener(ev, fn);
    }
    this._videoListeners = [];
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;

    this._destroyGpu();

    this.canvas?.remove();
    this._hudEl?.remove();
    this.canvas = null;
    this._hudEl = null;
    this._video = null;
    this._container = null;
    this._mounted = false;
  }

  dispose() {
    this.unmount();
  }

  get mounted() {
    return this._mounted;
  }

  get active() {
    return this._active;
  }

  // ------------------------------------------------------------------
  // Settings API
  // ------------------------------------------------------------------

  /**
   * @param {{enabled?: boolean, factor?: 'auto'|2|4|6, quality?: string, hud?: boolean,
   *          suspended?: boolean, suspendReason?: string}} opts
   * `suspended` is set by the caller (VideoPlayer) while a VR mode owns the
   * presentation path; the user's own enabled flag is preserved.
   */
  async update(opts = {}) {
    if (opts.enabled !== undefined) this._enabled = !!opts.enabled;
    if (opts.factor !== undefined) this._factor = opts.factor;
    if (opts.quality !== undefined) this._quality = opts.quality;
    if (opts.hud !== undefined) {
      this._hud = !!opts.hud;
    }
    if (opts.suspended !== undefined) this._suspended = !!opts.suspended;
    // HUD only makes sense while frames are actually being presented.
    if (this._hudEl) this._hudEl.hidden = !(this._hud && this._active);
    await this._applyGate();
  }

  get status() {
    return {
      enabled: this._enabled,
      active: this._active,
      factor: this._factor,
      effectiveFactor: this._effectiveFactor(),
      quality: this._quality,
      suspended: !!this._suspended,
      gpuLost: this._gpuLost,
      unsupported: this._unsupported,
      srcFps: this._srcFps,
      refreshFps: this._refreshFps,
      outFps: this._outFps,
      gpuName: this._gpuName,
    };
  }

  _effectiveFactor() {
    if (this._factor === 'auto') return this._autoFactor;
    const n = Number(this._factor);
    return Number.isFinite(n) && n >= 2 ? Math.min(6, Math.round(n)) : 1;
  }

  /** Target factor from measured source fps vs display refresh (30→120 ⇒ 4×). */
  _desiredAutoFactor() {
    if (!(this._srcFps > 0) || !(this._refreshFps > 0)) return 2;
    const ratio = this._refreshFps / this._srcFps;
    return ratio >= 3 ? 4 : 2;
  }

  /**
   * One AIMD step of the auto-factor controller: multiplicative-ish
   * decrease when the present queue backs up, additive increase when it
   * runs dry (the panel is starving for frames). avgQ = mean queue length
   * over the AIMD window.
   */
  _aimdAdjust(avgQ) {
    const desired = this._desiredAutoFactor();
    if (avgQ >= 2) {
      this._autoFactor = 2;
    } else if (avgQ <= 0.25 && this._autoFactor < desired) {
      this._autoFactor = Math.min(4, this._autoFactor + 2);
    }
  }

  async _applyGate() {
    const video = this._video;
    if (!this._mounted || !video) {
      this._deactivate();
      return;
    }
    const rateOk = Math.abs((video.playbackRate ?? 1) - 1) < 1e-6;
    const gateOk = this._enabled && !this._suspended && !this._gpuLost && !this._unsupported && rateOk;
    if (!gateOk) {
      this._deactivate();
      return;
    }
    try {
      await this._ensureGpu();
      await this._ensureModel();
    } catch (err) {
      console.warn('[frame-interp] init failed:', err?.message || err);
      this._unsupported = true;
      this._deactivate();
      showToast(t('frameInterp.unsupported'), 'warn', 4000);
      return;
    }
    this._activate();
  }

  _activate() {
    if (this._active || !this._mounted) return;
    this._active = true;
    if (this.canvas) this.canvas.hidden = false;
    if (this._hudEl) this._hudEl.hidden = !this._hud;
    this._container.classList.add('player__video-wrapper--frame-interp');
    this._resetPairState();
    this._aimdAt = performance.now();
    this._startLoops();
  }

  _deactivate() {
    if (!this._active) return;
    this._active = false;
    this._stopLoops();
    if (this.canvas) this.canvas.hidden = true;
    if (this._hudEl) this._hudEl.hidden = true;
    this._container?.classList.remove('player__video-wrapper--frame-interp');
    this._presentQ = [];
    this._lastTex = null;
    this._prevTex = null;
    this._curTex = null;
  }

  // ------------------------------------------------------------------
  // GPU init + model build
  // ------------------------------------------------------------------

  async _ensureGpu() {
    if (this._device && !this._gpuLost) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const probe = await FrameInterpolator.probe();
      if (!probe.supported) throw new Error(probe.reason || 'WebGPU unavailable');
      this._adapter = probe.adapter;

      const features = [];
      if (probe.adapter.features.has('shader-f16')) features.push('shader-f16');
      if (probe.adapter.features.has('timestamp-query')) features.push('timestamp-query');
      this._device = await probe.adapter.requestDevice({ requiredFeatures: features });
      this._device.lost.then((info) => {
        if (info.reason === 'destroyed') return;
        console.warn('[frame-interp] GPU device lost:', info.reason);
        this._gpuLost = true;
        this._deactivate();
        showToast(t('frameInterp.gpuLost'), 'warn', 5000);
      });

      try {
        const info = await this._adapter.requestAdapterInfo?.();
        this._gpuName = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || '';
      } catch {
        this._gpuName = '';
      }

      this._ctx = this.canvas.getContext('webgpu');
      this._ctx.configure({
        device: this._device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'opaque',
      });

      this._sampler = this._device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

      // Present pass: fullscreen triangle, rect-mapped sample (letterbox / crop in-shader).
      const mod = this._device.createShaderModule({ code: PRESENT_SHADER });
      this._presentPipeline = this._device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
        primitive: { topology: 'triangle-list' },
      });
      this._presentBgl = this._presentPipeline.getBindGroupLayout(0);
      this._uniformBuf = this._device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this._presentBgCache.clear();

      // Weights (fetched once per session).
      if (!this._weightsBin) {
        const base = new URL('./interpolation/weights/rt_v7s', import.meta.url);
        const [bin, manifest] = await Promise.all([
          fetch(base.href + '.bin').then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('weights bin ' + r.status)))),
          fetch(base.href + '.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error('weights json ' + r.status)))),
        ]);
        this._weightsBin = bin;
        this._weightsManifest = manifest;
      }
    })();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  /** (Re)build the rt model for the current video dimensions + quality rung. */
  async _ensureModel() {
    const video = this._video;
    if (!video || !this._device) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const cap = QUALITY_CAPS[this._quality] || QUALITY_CAPS.auto;
    const W = r16(Math.min(vw, cap[0]));
    const H = r16(Math.min(vh, cap[1]));
    if (this._rt && this._rt.w === W && this._rt.h === H) return;
    if (this._modelPromise) return this._modelPromise;

    this._modelPromise = (async () => {
      const device = this._device;
      const manifest = this._weightsManifest;
      const C1 = manifest['block0.conv0.0.0.weight'].shape[0];
      const C2 = manifest['block0.conv0.1.0.weight'].shape[0];

      // Autotuned conv tile — cached per GPU + channel count + dims (upstream
      // pattern; tuneConvRB costs ~1-2s on first build).
      let convTune = null;
      try {
        const info = await this._adapter.requestAdapterInfo?.();
        const gpuKey = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join('|') || 'unknown';
        const key = `${TUNE_CACHE_PREFIX}${gpuKey}:${C2}:${W}x${H}`;
        const cached = localStorage.getItem(key);
        if (cached) {
          convTune = JSON.parse(cached);
        } else {
          convTune = await tuneConvRB(device, { ci: C2, co: C2, w16: W / 16, h16: H / 16, s2ci: C1 });
          localStorage.setItem(key, JSON.stringify(convTune));
        }
      } catch (err) {
        console.warn('[frame-interp] conv tune cache failed, tuning fresh:', err?.message || err);
        convTune = await tuneConvRB(device, { ci: C2, co: C2, w16: W / 16, h16: H / 16, s2ci: C1 });
      }

      this._rt?.destroy?.();
      this._destroyTextures();

      this._rt = await createRT(device, {
        w: W,
        h: H,
        weightsBin: this._weightsBin,
        weightsManifest: this._weightsManifest,
        convTune,
        textureInput: true,
        textureOutput: true,
      });

      // rt_v7s is tfact+refine → texture in/out mode is mandatory.
      // Input textures need COPY_DST + RENDER_ATTACHMENT (Dawn requires both
      // on copyExternalImageToTexture destinations — learned in the spike).
      for (let i = 0; i < INPUT_SLOTS; i++) {
        this._inPool.push(this._makeTex(W, H, false));
      }
      for (let b = 0; b < RING_BANKS; b++) {
        const bank = [];
        for (let m = 0; m < MAX_MIDS; m++) bank.push(this._makeTex(W, H, true));
        this._ring.push(bank);
      }
      this._resetPairState();
    })();
    try {
      await this._modelPromise;
    } finally {
      this._modelPromise = null;
    }
  }

  _makeTex(w, h, storage) {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
    return this._device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: storage ? usage | GPUTextureUsage.STORAGE_BINDING : usage,
    });
  }

  _isMidTex(tex) {
    return this._ring.some((bank) => bank.includes(tex));
  }

  _destroyTextures() {
    for (const t of this._inPool) t?.destroy?.();
    for (const bank of this._ring) for (const t of bank) t?.destroy?.();
    this._inPool = [];
    this._ring = [];
    this._presentBgCache.clear();
    this._prevTex = null;
    this._curTex = null;
    this._lastTex = null;
    this._presentQ = [];
  }

  _destroyGpu() {
    this._rt?.destroy?.();
    this._rt = null;
    this._destroyTextures();
    this._device?.destroy?.();
    this._device = null;
    this._ctx = null;
    this._presentPipeline = null;
    this._uniformBuf = null;
  }

  // ------------------------------------------------------------------
  // Render loops
  // ------------------------------------------------------------------

  _startLoops() {
    this._stopLoops();
    this._boundOnFrame = this._boundOnFrame || ((now, meta) => this._onFrame(now, meta));
    this._boundRaf = this._boundRaf || ((now) => this._rafLoop(now));
    this._rvfcHandle = this._video.requestVideoFrameCallback(this._boundOnFrame);
    this._rafHandle = requestAnimationFrame(this._boundRaf);
  }

  _stopLoops() {
    if (this._rvfcHandle != null && this._video?.cancelVideoFrameCallback) {
      this._video.cancelVideoFrameCallback(this._rvfcHandle);
    }
    this._rvfcHandle = null;
    if (this._rafHandle != null) cancelAnimationFrame(this._rafHandle);
    this._rafHandle = null;
  }

  _resetPairState() {
    this._prevTex = null;
    this._curTex = null;
    this._presentQ = [];
    this._lastMediaTime = 0;
  }

  _onFrame(now, meta) {
    if (!this._active) return;
    this._rvfcHandle = this._video.requestVideoFrameCallback(this._boundOnFrame);

    const video = this._video;
    if (video.readyState < 2 || !video.videoWidth) return;

    // Source fps estimate from mediaTime deltas.
    const mt = meta?.mediaTime ?? 0;
    if (this._lastMediaTime > 0) {
      const dt = mt - this._lastMediaTime;
      if (dt > 0.001 && dt < 0.5) {
        const fps = 1 / dt;
        this._srcFps = this._srcFps ? this._srcFps * 0.9 + fps * 0.1 : fps;
      }
    }
    this._lastMediaTime = mt;

    // Dimension change (new video) → rebuild model in the background; until
    // it lands, present real frames only.
    if (this._rt && (r16(video.videoWidth) !== this._rt.w || r16(video.videoHeight) !== this._rt.h)) {
      this._ensureModel().catch((err) => {
        console.warn('[frame-interp] model rebuild failed:', err?.message || err);
      });
    }
    if (!this._rt) {
      this._ensureModel().catch(() => {});
    }

    const next = this._inPool[this._inIdx % INPUT_SLOTS];
    this._inIdx++;

    const done = () => this._afterCopy(next);
    const pending = this._copyVideoInto(next);
    if (pending && typeof pending.then === 'function') pending.then(done).catch(() => {});
    else done();
  }

  /**
   * Copy the current video frame into a model-rung texture.
   * Native path (dims already match the rung) uses VideoFrame directly;
   * downscaled rungs go through createImageBitmap. Returns a promise only
   * for the bitmap path.
   */
  _copyVideoInto(tex) {
    const video = this._video;
    const rt = this._rt;
    const W = rt ? rt.w : r16(video.videoWidth);
    const H = rt ? rt.h : r16(video.videoHeight);

    if (video.videoWidth === W && video.videoHeight === H) {
      let vf = null;
      try {
        vf = new VideoFrame(video);
        this._device.queue.copyExternalImageToTexture(
          { source: vf },
          { texture: tex },
          [video.videoWidth, video.videoHeight],
        );
        return null;
      } catch (err) {
        console.warn('[frame-interp] VideoFrame copy failed:', err?.message || err);
        return null;
      } finally {
        vf?.close();
      }
    }

    return createImageBitmap(video, { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' })
      .then((bmp) => {
        this._device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [W, H]);
        bmp.close();
      });
  }

  _afterCopy(next) {
    if (!this._active) return;
    const factor = this._effectiveFactor();

    if (this._curTex && this._rt && factor > 1) {
      const bank = this._ring[this._parity];
      try {
        this._rt.prepPair(this._curTex, next);
        for (let k = 1; k < factor; k++) {
          this._rt.runT(k / factor, bank[k - 1]);
        }
        this._parity ^= 1;
        for (let k = 1; k < factor; k++) this._presentQ.push(bank[k - 1]);
      } catch (err) {
        console.warn('[frame-interp] runT failed:', err?.message || err);
      }
    }
    this._presentQ.push(next);

    // Backlog guard: drop oldest generated mids — never a real source frame,
    // so resyncing costs softness (a duplicated real frame), not a dropped one.
    while (this._presentQ.length > MAX_PRESENT_QUEUE) {
      const dropIdx = this._presentQ.findIndex((t) => this._isMidTex(t));
      if (dropIdx < 0) break;
      this._presentQ.splice(dropIdx, 1);
    }

    this._prevTex = this._curTex;
    this._curTex = next;
  }

  _rafLoop(now) {
    if (!this._active) return;
    this._rafHandle = requestAnimationFrame(this._boundRaf);

    // Display refresh estimate.
    if (this._lastRafAt > 0) {
      const dt = now - this._lastRafAt;
      if (dt > 1 && dt < 200) {
        const fps = 1000 / dt;
        this._refreshFps = this._refreshFps ? this._refreshFps * 0.92 + fps * 0.08 : fps;
      }
    }
    this._lastRafAt = now;

    const tex = this._presentQ.shift() ?? this._lastTex;
    if (tex) {
      this._present(tex);
      this._lastTex = tex;
      this._outCount++;
    }

    this._queueSum += this._presentQ.length;
    this._queueN++;

    // AIMD factor controller (auto mode only).
    if (now - this._aimdAt >= AIMD_WINDOW_MS) {
      this._aimdAt = now;
      if (this._factor === 'auto' && this._srcFps > 0 && this._refreshFps > 0) {
        const avgQ = this._queueN ? this._queueSum / this._queueN : 0;
        this._aimdAdjust(avgQ);
      }
      this._queueSum = 0;
      this._queueN = 0;
    }

    // Output fps + HUD.
    if (now - this._lastOutAt >= 1000) {
      this._outFps = this._outCount * 1000 / (now - this._lastOutAt);
      this._outCount = 0;
      this._lastOutAt = now;
    }
    if (this._hud && now - this._lastHudAt >= 500) {
      this._lastHudAt = now;
      this._updateHud();
    }
  }

  _updateHud() {
    if (!this._hudEl) return;
    const f = this._effectiveFactor();
    const src = this._srcFps ? Math.round(this._srcFps) : '?';
    const out = this._outFps ? Math.round(this._outFps) : '?';
    const gpu = this._gpuName ? ` · ${this._gpuName.slice(0, 24)}` : '';
    this._hudEl.textContent = `${f}× ${src}→${out}fps${gpu}`;
  }

  // ------------------------------------------------------------------
  // Present pass
  // ------------------------------------------------------------------

  _resizeCanvas() {
    if (!this.canvas || !this._container) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this._container.clientWidth * dpr));
    const h = Math.max(1, Math.round(this._container.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._rect = null;
    }
  }

  _computeRect() {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const vw = this._video?.videoWidth;
    const vh = this._video?.videoHeight;
    if (!vw || !vh || !cw || !ch) return null;
    let fit = 'contain';
    try {
      fit = getComputedStyle(this._video).objectFit || 'contain';
    } catch { /* jsdom etc. */ }
    if (fit === 'fill' || fit === 'none') {
      return [0, 0, cw, ch];
    }
    const scale = fit === 'cover' ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh);
    const rw = vw * scale;
    const rh = vh * scale;
    return [(cw - rw) / 2, (ch - rh) / 2, rw, rh];
  }

  _present(tex) {
    const device = this._device;
    const ctx = this._ctx;
    // NOTE: `device.lost` is a Promise (always truthy) — never use it as a
    // boolean guard here, or every present silently no-ops (black canvas
    // with audio still playing). Device loss is handled by the
    // `device.lost.then(...)` handler in _ensureGpu; `destroyed` is the
    // boolean we can check synchronously.
    if (!device || !ctx || device.destroyed) return;

    const now = performance.now();
    if (!this._rect || now - this._rectAt > 500) {
      this._rect = this._computeRect();
      this._rectAt = now;
    }
    const rect = this._rect || [0, 0, this.canvas.width, this.canvas.height];
    this._rectData[0] = rect[0];
    this._rectData[1] = rect[1];
    this._rectData[2] = rect[2];
    this._rectData[3] = rect[3];
    this._rectData[4] = this.canvas.width;
    this._rectData[5] = this.canvas.height;

    let bg = this._presentBgCache.get(tex);
    if (!bg) {
      bg = device.createBindGroup({
        layout: this._presentBgl,
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: this._sampler },
          { binding: 2, resource: { buffer: this._uniformBuf } },
        ],
      });
      this._presentBgCache.set(tex, bg);
    }

    device.queue.writeBuffer(this._uniformBuf, 0, this._rectData);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this._presentPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}

export default FrameInterpolator;
