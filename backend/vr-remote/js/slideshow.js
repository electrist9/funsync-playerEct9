/**
 * Slideshow (flat-video photo mode) for the WebXR VR client.
 *
 * Timing and dominant-color math come from the SAME modules the desktop
 * player uses, served by the backend at /shared-js/* so behaviour is
 * identical across apps:
 *   - /shared-js/slideshow-timing.js (funscript switch points, photo order,
 *     image arrangement, wipe geometry — rhythmslide port)
 *   - /shared-js/slideshow-color.js  (dominant background extraction)
 *
 * Folder selection stays desktop-only; the VR client reads the configured
 * folder through GET /api/remote/slideshow/config and /images.
 *
 * SlideshowModel is pure (no DOM) and unit-tested; SlideshowRenderer does
 * the canvas compositing that feeds the VR screen texture.
 */

import {
  computeSwitchTimes,
  photoIndexAt,
  arrangeImages,
  resolvePreset,
  sanitizeTransition,
  sanitizeBackground,
  pickRandomTransition,
  wipeGeometry,
  WIPE_MARGIN_PX,
} from '/shared-js/slideshow-timing.js';
import { dominantColorFromImageData } from '/shared-js/slideshow-color.js';

/** Cap for the cross-switch transition window (seconds). */
export const MAX_TRANSITION_S = 0.5;

/** A transition never eats more than this share of the gap to the next switch. */
const TRANSITION_GAP_SHARE = 4;

/**
 * Pure slideshow state. configure() derives switch times from the video's
 * funscript; frame(t) answers which photo(s) to show at video time t.
 */
export class SlideshowModel {
  /**
   * @param {{canvasW:number, canvasH:number, corner:string, sizeDenom:number,
   *          imageOrder:string, transition:string, background:string,
   *          preset:string, presets:Array, imageUrls:Array, actions:Array}} cfg
   *        the /api/remote/slideshow/config payload merged with the image
   *        listing and the funscript actions.
   */
  constructor(cfg = {}) {
    this.canvasW = Math.max(1, Math.floor(Number(cfg.canvasW) || 1920));
    this.canvasH = Math.max(1, Math.floor(Number(cfg.canvasH) || 1080));
    this.corner = cfg.corner;
    this.sizeDenom = cfg.sizeDenom;
    this.order = (() => {
      const o = String(cfg.order ?? cfg.imageOrder ?? 'name');
      return o === 'random' ? 'random' : 'name';
    })();
    this.transition = sanitizeTransition(cfg.transition);
    this.background = sanitizeBackground(cfg.background);
    this.preset = resolvePreset(cfg.presets, cfg.preset);
    this._randomCache = new Map(); // switch ordinal → concrete kind (stable across frames)
    this._rng = cfg.rng || Math.random;

    this.switchTimes = [];
    this.images = []; // arranged URL list
    this.build(cfg.actions, cfg.imageUrls);
  }

  /** Derive switch points and the arranged image list. Safe to re-call. */
  build(actions, imageUrls) {
    this.switchTimes = computeSwitchTimes(Array.isArray(actions) ? actions : [], this.preset);
    this.images = arrangeImages(Array.isArray(imageUrls) ? imageUrls : [], this.order, this._rng);
    return this;
  }

  /** Concrete transition kind for the Nth switch (0-based ordinal). */
  transitionKind(ordinal) {
    if (this.transition !== 'random') return this.transition;
    let kind = this._randomCache.get(ordinal);
    if (!kind) {
      kind = pickRandomTransition(this._rng);
      this._randomCache.set(ordinal, kind);
    }
    return kind;
  }

  /**
   * Compose state at video time `t` (seconds).
   * @returns {{fromIndex:number, toIndex:number, progress:number,
   *            photoIndex:number, transition:string|null, wipe:{x,y,w,h}}}
   */
  frame(t, videoW = 0, videoH = 0) {
    const count = this.images.length;
    const wipe = wipeGeometry(this.canvasW, this.canvasH, videoW, videoH, this.corner, WIPE_MARGIN_PX, this.sizeDenom);
    let time = Number(t);
    if (!Number.isFinite(time) || time < 0) time = 0;

    if (count === 0) {
      return { fromIndex: -1, toIndex: -1, progress: 0, photoIndex: -1, transition: null, wipe };
    }
    // Number of switches already crossed.
    let n = 0;
    while (n < this.switchTimes.length && this.switchTimes[n] <= time) n += 1;

    if (n === 0) {
      const idx = photoIndexAt(count, this.preset.order, 0);
      return { fromIndex: idx, toIndex: -1, progress: 0, photoIndex: idx, transition: null, wipe };
    }

    const switchAt = this.switchTimes[n - 1];
    const toIndex = photoIndexAt(count, this.preset.order, n);
    const fromIndex = photoIndexAt(count, this.preset.order, n - 1);
    const nextAt = n < this.switchTimes.length ? this.switchTimes[n] : null;
    const gap = nextAt !== null ? (nextAt - switchAt) / TRANSITION_GAP_SHARE : MAX_TRANSITION_S;
    const dur = Math.min(MAX_TRANSITION_S, Math.max(0, gap));
    const progress = dur > 0 ? Math.min(1, (time - switchAt) / dur) : 1;
    const transition = progress < 1 && fromIndex !== toIndex
      ? this.transitionKind(n - 1)
      : null;
    return { fromIndex, toIndex, progress, photoIndex: toIndex, transition, wipe };
  }
}

/**
 * Canvas compositor: paints {background, from photo, to photo, video wipe
 * window} into an offscreen 2D canvas each frame; main.js uploads the canvas
 * to a THREE.CanvasTexture.
 */
export class SlideshowRenderer {
  constructor({ width = 1920, height = 1080 } = {}) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.images = new Map(); // image index → { el, ready, dominant }
  }

  /** Kick off loading one arranged image URL. Idempotent per index. */
  loadImage(urls, index) {
    if (index < 0 || index >= urls.length) return null;
    let entry = this.images.get(index);
    if (entry) return entry;
    const el = new Image();
    entry = { el, ready: false, dominant: null, probed: false };
    el.addEventListener('load', () => { entry.ready = true; });
    el.src = urls[index];
    this.images.set(index, entry);
    return entry;
  }

  /** Dominant #rrggbb for an entry (computed once from a ~48px downscale). */
  dominantOf(entry) {
    if (!entry || !entry.ready) return entry ? entry.dominant : null;
    if (entry.probed) return entry.dominant;
    entry.probed = true;
    try {
      const probe = document.createElement('canvas');
      const iw = entry.el.naturalWidth || 1;
      const ih = entry.el.naturalHeight || 1;
      const scale = 48 / Math.max(iw, ih);
      probe.width = Math.max(1, Math.round(iw * scale));
      probe.height = Math.max(1, Math.round(ih * scale));
      const pctx = probe.getContext('2d');
      pctx.drawImage(entry.el, 0, 0, probe.width, probe.height);
      const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
      entry.dominant = dominantColorFromImageData(data, probe.width, probe.height);
    } catch {
      entry.dominant = null; // tainted/failed canvas → solid fallback
    }
    return entry.dominant;
  }

  _drawImageContain(entry, ctx = this.ctx) {
    if (!entry || !entry.ready) return;
    const iw = entry.el.naturalWidth;
    const ih = entry.el.naturalHeight;
    if (!iw || !ih) return;
    const scale = Math.min(this.width / iw, this.height / ih);
    const w = iw * scale;
    const h = ih * scale;
    ctx.drawImage(entry.el, (this.width - w) / 2, (this.height - h) / 2, w, h);
  }

  /** Draw one photo fully (contain-fit) into the canvas. */
  drawFull(entry) {
    this._drawImageContain(entry);
  }

  /**
   * Paint a full slideshow frame.
   * @param {object} state  SlideshowModel.frame() result
   * @param {SlideshowModel} model (for background setting)
   * @param {HTMLVideoElement|null} video current video element (wipe window)
   */
  render(state, model, video) {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Background: dominant color of the current photo, else solid.
    const cur = this.images.get(state.photoIndex);
    let bg = '#101018';
    if (model && model.background === 'dominant') {
      bg = (cur && this.dominantOf(cur)) || bg;
    }
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.width, this.height);

    const from = state.fromIndex >= 0 ? this.images.get(state.fromIndex) : null;
    const to = state.toIndex >= 0 ? this.images.get(state.toIndex) : null;

    if (!state.transition || !from || !to || !from.ready || !to.ready) {
      if (from) this._drawImageContain(from);
    } else {
      this._drawTransition(ctx, state.transition, from, to, state.progress);
    }

    ctx.globalAlpha = 1;

    // Video window (videowipe) — the clock (and audio) keeps running behind
    // the photos, so show the video small in its configured corner.
    if (video && state.wipe && state.wipe.w > 0 && video.readyState >= 2) {
      ctx.drawImage(video, state.wipe.x, state.wipe.y, state.wipe.w, state.wipe.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(state.wipe.x + 1, state.wipe.y + 1, state.wipe.w - 2, state.wipe.h - 2);
    }
  }

  _drawTransition(ctx, kind, from, to, p) {
    const W = this.width;
    const H = this.height;
    ctx.save();
    switch (kind) {
      case 'wipe_left': {
        this._drawImageContain(from);
        ctx.beginPath();
        ctx.rect(0, 0, W * p, H);
        ctx.clip();
        this._drawImageContain(to);
        break;
      }
      case 'wipe_right': {
        this._drawImageContain(from);
        ctx.beginPath();
        ctx.rect(W * (1 - p), 0, W * p, H);
        ctx.clip();
        this._drawImageContain(to);
        break;
      }
      case 'slide_left': {
        this._drawShifted(from, -p * W);
        this._drawShifted(to, (1 - p) * W);
        break;
      }
      case 'slide_right': {
        this._drawShifted(from, p * W);
        this._drawShifted(to, -(1 - p) * W);
        break;
      }
      case 'zoom': {
        this._drawImageContain(from);
        const s = 0.7 + 0.3 * p;
        ctx.globalAlpha = p;
        ctx.translate(W / 2, H / 2);
        ctx.scale(s, s);
        ctx.translate(-W / 2, -H / 2);
        this._drawImageContain(to);
        break;
      }
      case 'crossfade':
      default: {
        this._drawImageContain(from);
        ctx.globalAlpha = p;
        this._drawImageContain(to);
        break;
      }
    }
    ctx.restore();
  }

  _drawShifted(entry, dx) {
    this.ctx.save();
    this.ctx.translate(dx, 0);
    this._drawImageContain(entry);
    this.ctx.restore();
  }
}
