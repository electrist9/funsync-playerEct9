/**
 * Photo slideshow during playback (rhythmslide-style).
 *
 * The timing rules themselves live in slideshow-timing.js — a port of
 * rhythmslide's funscript.py (© electrist9, GPL-3.0). This module is the
 * player-side glue only:
 *
 *   - one shared photo folder for the whole app (player.slideshowFolder,
 *     persisted; seeded once from the old library.slideshowLastFolder)
 *   - recursive image listing + data-URL cache via the slideshow IPC bridge
 *   - photo transition layer (crossfade / wipe / slide / zoom, 100ms) +
 *     corner video wipe (wipeGeometry from the port) + dominant-color background
 *   - live preset switching while a slideshow runs
 *   - the in-player popover (folder / preset / corner / size / order /
 *     transition / background)
 *
 * A slideshow requires a loaded funscript — without one there are no switch
 * times, so enabling is refused (the ⋮ menu entry is hidden for scriptless
 * videos anyway).
 */
import {
  computeSwitchTimes,
  photoIndexAt,
  arrangeImages,
  resolvePreset,
  sanitizePresets,
  wipeGeometry,
  WIPE_MARGIN_PX,
  DEFAULT_WIPE_SIZE_DENOM,
  TRANSITIONS,
  CONCRETE_TRANSITIONS,
  BACKGROUNDS,
  sanitizeTransition,
  sanitizeBackground,
  pickRandomTransition,
} from './slideshow-timing.js';
import { dominantColorFromImageData } from './slideshow-color.js';

const CACHE_MAX = 12;
const PREFETCH_AHEAD = 2;
/** Grace for the new video's script to load after a hand-off (ms). */
const SCRIPT_GRACE_MS = 8000;
/** Photo-switch transition duration — fixed 100ms (user requirement). */
const TRANSITION_MS = 100;
/** Side length of the tiny canvas used for dominant-color sampling (px). */
const DOMINANT_SAMPLE = 48;

const CORNERS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
const SIZES = [16, 8, 4]; // wipe area = 1/denom → small / medium / large

export class SlideshowController {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {HTMLElement} opts.wrapper  .player__video-wrapper (positioning context)
   * @param {HTMLElement} opts.layer    #slideshow-layer (two stacked <img>)
   * @param {HTMLImageElement} opts.imgA
   * @param {HTMLImageElement} opts.imgB
   * @param {HTMLButtonElement} opts.wipeBtn  transparent button over the wipe
   * @param {object} opts.settings      dataService (dotted get/set)
   * @param {() => Array|null} opts.getActions      funscript actions
   * @param {() => boolean} opts.isScriptLoaded
   * @param {(state: object) => void} opts.onStateChange
   * @param {(kind: string) => void} opts.onNotice  'no-script' | 'no-images' | 'read-failed'
   * @param {(key: string) => string} opts.t
   */
  constructor(opts) {
    this.video = opts.video;
    this.wrapper = opts.wrapper;
    this.layer = opts.layer;
    this.imgA = opts.imgA;
    this.imgB = opts.imgB;
    this.wipeBtn = opts.wipeBtn;
    this.settings = opts.settings;
    this.getActions = opts.getActions;
    this.isScriptLoaded = opts.isScriptLoaded;
    this.onStateChange = opts.onStateChange || (() => {});
    this.onNotice = opts.onNotice || (() => {});
    this.t = opts.t || ((k) => k);
    /** Injectable rng for the per-switch 'random' transition draw (tests). */
    this._rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

    this._active = false;
    this._folder = null;
    this._images = [];          // ordered image paths (arrangeImages output)
    this._switchTimes = [];     // seconds, ascending
    this._actionsRef = null;    // identity of the actions array last compiled
    this._segment = 0;          // number of switches at/before currentTime
    this._shownIdx = -1;        // photo currently visible
    this._targetIdx = -1;       // photo we want visible (may still be loading)
    this._front = this.imgA;    // currently visible img
    this._back = this.imgB;     // next img (gets new src, then fades in)
    this._cache = new Map();    // path -> data URL (insertion order = LRU-ish)
    this._inflight = new Set();
    this._dominantCache = new Map(); // path -> '#rrggbb' | null (port of renderer.py _dominant)
    this._holdTimers = new Set();    // pending outgoing-image hold timeouts (wipe/slide)
    this._sessionPresetName = null; // null = use settings default
    this._raf = 0;
    this._scriptGraceUntil = 0;
    this._enableSeq = 0;        // invalidates superseded async enables

    this.wipeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.disable();
    });
    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.applyGeometry());
    }
    this.video.addEventListener('loadedmetadata', () => this.applyGeometry());
  }

  get active() { return this._active; }

  /** Snapshot for the popover / menu item. */
  get state() {
    return {
      active: this._active,
      folder: this._folder || this.resolveFolder(),
      imageCount: this._images.length,
      presets: this.presets(),
      presetName: this._sessionPresetName ?? (this.settings.get('player.slideshowPreset') || ''),
      corner: this.settings.get('player.slideshowCorner') || 'bottom_right',
      sizeDenom: this.settings.get('player.slideshowSizeDenom') || DEFAULT_WIPE_SIZE_DENOM,
      imageOrder: this.settings.get('player.slideshowImageOrder') || 'name',
      transition: sanitizeTransition(this.settings.get('player.slideshowTransition')),
      background: sanitizeBackground(this.settings.get('player.slideshowBackground')),
    };
  }

  presets() {
    return sanitizePresets(this.settings.get('player.slideshowPresets') || []);
  }

  currentPreset() {
    return resolvePreset(this.presets(), this._sessionPresetName ?? (this.settings.get('player.slideshowPreset') || ''));
  }

  /**
   * The shared photo folder (player.slideshowFolder) — one folder for the
   * whole app, not per video. Seeded once from the pre-2026-11-21
   * library.slideshowLastFolder so existing users keep their choice.
   */
  resolveFolder() {
    return this.settings.get('player.slideshowFolder')
      || this.settings.get('library.slideshowLastFolder')
      || null;
  }

  _persistFolder(folder) {
    this.settings.set('player.slideshowFolder', folder);
    this._folder = folder;
  }

  async toggle() {
    if (this._active) { this.disable(); return false; }
    return this.enable();
  }

  async enable() {
    if (this._active) return true;
    if (!this.isScriptLoaded()) {
      this.onNotice('no-script');
      return false;
    }
    let folder = this.resolveFolder();
    if (!folder) {
      // No folder chosen yet (ever): ask for the shared photo folder now.
      try { folder = await window.funsync.selectDirectory(); } catch { folder = null; }
      if (!folder) return false;
    }
    const seq = ++this._enableSeq;
    let res = null;
    try { res = await window.funsync.listSlideshowImages(folder); } catch { res = null; }
    if (seq !== this._enableSeq || this._active) return false; // superseded
    if (!res || res.error === 'read-failed' || res.error === 'not-a-directory') {
      this.onNotice('read-failed');
      return false;
    }
    if (!res.images || res.images.length === 0) {
      this.onNotice('no-images');
      return false;
    }
    this._folder = folder;
    this._persistFolder(folder);
    this._loadImages(res.images);
    this._compileTiming();
    this._segment = this._segmentAt(this.video.currentTime || 0);
    this._shownIdx = -1;
    this._targetIdx = -1;
    this._active = true;
    this._scriptGraceUntil = 0;
    this.wrapper.classList.add('player__video-wrapper--slideshow');
    this.layer.hidden = false;
    this.wipeBtn.hidden = false;
    this.applyGeometry();
    if (this._resizeObserver) this._resizeObserver.observe(this.wrapper);
    this._showPhoto(photoIndexAt(this._images.length, this.currentPreset().order, this._segment));
    this._startLoop();
    this.onStateChange(this.state);
    return true;
  }

  disable() {
    if (!this._active) return;
    this._active = false;
    this._enableSeq++; // drop any in-flight enable/list results
    this._stopLoop();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this.wrapper.classList.remove('player__video-wrapper--slideshow');
    this.layer.hidden = true;
    this.wipeBtn.hidden = true;
    const s = this.video.style;
    s.left = s.top = s.width = s.height = '';
    for (const img of [this.imgA, this.imgB]) {
      for (const cls of [...img.classList]) {
        if (cls.startsWith('slideshow-layer__img--')) img.classList.remove(cls);
      }
      img.removeAttribute('src');
    }
    this._front = this.imgA;
    this._back = this.imgB;
    this._shownIdx = -1;
    this._targetIdx = -1;
    this._segment = 0;
    this._cache.clear();
    this._inflight.clear();
    this._dominantCache.clear();
    for (const timer of this._holdTimers) clearTimeout(timer);
    this._holdTimers.clear();
    this.layer.style.backgroundColor = '';
    this.onStateChange(this.state);
  }

  /**
   * Called from loadVideo() after the engine teardown. Keeps the slideshow
   * running across a queue hand-off when a script is arriving for the new
   * video (the photo folder is shared app-wide); disables (with a notice)
   * when the new video can't support it.
   */
  onVideoLoaded() {
    this._cache.clear();
    this._inflight.clear();
    this._dominantCache.clear();
    this._images = [];
    this._switchTimes = [];
    this._actionsRef = null;
    this._segment = 0;
    this._shownIdx = -1;
    this._targetIdx = -1;
    if (!this._active) return;
    const folder = this.resolveFolder();
    if (!folder) {
      this.disable();
      this.onNotice('no-images');
      return;
    }
    this._folder = folder;
    this._scriptGraceUntil = Date.now() + SCRIPT_GRACE_MS;
    const seq = ++this._enableSeq;
    window.funsync.listSlideshowImages(folder).then((res) => {
      if (seq !== this._enableSeq || !this._active) return;
      if (res && !res.error && res.images.length) {
        this._loadImages(res.images);
        this._compileTiming();
        this._segment = this._segmentAt(this.video.currentTime || 0);
        this._showPhoto(photoIndexAt(this._images.length, this.currentPreset().order, this._segment));
      } else {
        this.disable();
        this.onNotice(res && res.error === 'read-failed' ? 'read-failed' : 'no-images');
      }
    }).catch(() => {
      if (seq === this._enableSeq && this._active) {
        this.disable();
        this.onNotice('read-failed');
      }
    });
  }

  /** Session-only preset switch (while running or for the next enable). */
  setPresetName(name) {
    this._sessionPresetName = name || null;
    if (!this._active) { this.onStateChange(this.state); return; }
    this._compileTiming();
    this._segment = this._segmentAt(this.video.currentTime || 0);
    this._showPhoto(photoIndexAt(this._images.length, this.currentPreset().order, this._segment));
    this.onStateChange(this.state);
  }

  setFolder(folder) {
    if (!folder) return;
    this._persistFolder(folder);
    if (!this._active) { this.onStateChange(this.state); return; }
    const seq = ++this._enableSeq;
    window.funsync.listSlideshowImages(folder).then((res) => {
      if (seq !== this._enableSeq || !this._active) return;
      if (res && !res.error && res.images.length) {
        this._cache.clear();
        this._inflight.clear();
        this._dominantCache.clear();
        this._loadImages(res.images);
        this._showPhoto(photoIndexAt(this._images.length, this.currentPreset().order, this._segment));
      } else {
        this.disable();
        this.onNotice(res && res.error === 'read-failed' ? 'read-failed' : 'no-images');
      }
    }).catch(() => {
      if (seq === this._enableSeq && this._active) { this.disable(); this.onNotice('read-failed'); }
    });
    this.onStateChange(this.state);
  }

  setCorner(corner) {
    if (!CORNERS.includes(corner)) return;
    this.settings.set('player.slideshowCorner', corner);
    this.applyGeometry();
    this.onStateChange(this.state);
  }

  setSizeDenom(denom) {
    if (!SIZES.includes(denom)) return;
    this.settings.set('player.slideshowSizeDenom', denom);
    this.applyGeometry();
    this.onStateChange(this.state);
  }

  setImageOrder(order) {
    if (order !== 'name' && order !== 'random') return;
    this.settings.set('player.slideshowImageOrder', order);
    if (this._active && this._images.length) {
      this._images = arrangeImages(this._images, order);
      this._showPhoto(photoIndexAt(this._images.length, this.currentPreset().order, this._segment));
    }
    this.onStateChange(this.state);
  }

  /** Photo-switch transition kind ('random' draws per switch). */
  setTransition(mode) {
    const v = sanitizeTransition(mode);
    this.settings.set('player.slideshowTransition', v);
    this.onStateChange(this.state);
  }

  /** 'solid' (CSS default) or 'dominant' (shown photo's dominant color). */
  setBackgroundMode(mode) {
    const v = sanitizeBackground(mode);
    this.settings.set('player.slideshowBackground', v);
    if (this._active) this._applyBackground();
    this.onStateChange(this.state);
  }

  // --- internals -----------------------------------------------------------

  _loadImages(paths) {
    this._images = arrangeImages(paths, this.settings.get('player.slideshowImageOrder') || 'name');
  }

  _compileTiming() {
    this._actionsRef = this.getActions();
    this._switchTimes = computeSwitchTimes(this._actionsRef, this.currentPreset());
  }

  /** Number of switch times at/before t (seconds). Binary search. */
  _segmentAt(t) {
    const st = this._switchTimes;
    let lo = 0;
    let hi = st.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (st[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _startLoop() {
    this._stopLoop();
    this._raf = requestAnimationFrame(this._tick);
  }

  _stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _tick = () => {
    if (!this._active) return;
    const actions = this.getActions();
    if (actions !== this._actionsRef) {
      // Script swapped (variant switch, multi-axis, cloud load): recompile.
      this._compileTiming();
      this._segment = this._segmentAt(this.video.currentTime || 0);
    }
    if (this._scriptGraceUntil) {
      if (this.isScriptLoaded()) this._scriptGraceUntil = 0;
      else if (Date.now() > this._scriptGraceUntil) {
        this.disable();
        this.onNotice('no-script');
        return;
      }
    }
    const seg = this._segmentAt(this.video.currentTime || 0);
    if (seg !== this._segment) {
      this._segment = seg;
      this._showPhoto(photoIndexAt(this._images.length, this.currentPreset().order, seg));
    } else if (this._targetIdx !== this._shownIdx) {
      // Still waiting on a slow load — retry (cache hit once it resolves).
      this._showPhoto(this._targetIdx);
    }
    this._prefetch();
    this._raf = requestAnimationFrame(this._tick);
  };

  _prefetch() {
    if (!this._images.length) return;
    const order = this.currentPreset().order;
    for (let k = 1; k <= PREFETCH_AHEAD; k++) {
      const idx = photoIndexAt(this._images.length, order, this._segment + k);
      if (idx >= 0 && idx !== this._shownIdx && !this._cache.has(this._images[idx])) {
        this._loadImage(this._images[idx]);
      }
    }
  }

  _showPhoto(idx) {
    if (idx < 0 || idx >= this._images.length) return;
    if (idx === this._shownIdx) return;
    this._targetIdx = idx;
    const path = this._images[idx];
    const url = this._cache.get(path);
    if (url) { this._swap(url, idx); return; }
    this._loadImage(path).then((u) => {
      if (!this._active || this._targetIdx !== idx || !u) return;
      this._swap(u, idx);
    });
  }

  /** Resolve the stored transition setting; 'random' draws a concrete kind. */
  _resolveTransition() {
    const stored = sanitizeTransition(this.settings.get('player.slideshowTransition'));
    return stored === 'random' ? pickRandomTransition(this._rng) : stored;
  }

  _swap(url, idx) {
    const mode = this._resolveTransition();
    const enterClass = `slideshow-layer__img--enter-${mode}`;
    const back = this._back;
    const front = this._front;
    // Incoming on top (DOM order) — safe: .slideshow-layer is its own
    // stacking context, so this never escapes into the wrapper/V-R layers.
    this.layer.appendChild(back);
    // Commit the enter state with transitions off, then release so the
    // 100ms CSS transition animates enter -> visible.
    back.classList.add('slideshow-layer__img--no-anim', enterClass);
    back.src = url;
    void back.offsetWidth;
    back.classList.remove('slideshow-layer__img--no-anim', enterClass);
    back.classList.add('slideshow-layer__img--visible');
    if (mode === 'crossfade' || mode === 'zoom') {
      front.classList.remove('slideshow-layer__img--visible');
    } else {
      // wipe/slide: the outgoing photo stays fully visible underneath
      // until the incoming one has finished covering it.
      const timer = setTimeout(() => {
        this._holdTimers.delete(timer);
        front.classList.remove('slideshow-layer__img--visible');
      }, TRANSITION_MS);
      this._holdTimers.add(timer);
    }
    const tmp = this._front;
    this._front = this._back;
    this._back = tmp;
    this._shownIdx = idx;
    this._applyBackground();
  }

  /** Paint the layer background per the background setting (renderer.py port). */
  _applyBackground() {
    if (sanitizeBackground(this.settings.get('player.slideshowBackground')) !== 'dominant') {
      this.layer.style.backgroundColor = '';
      return;
    }
    const path = this._images[this._shownIdx];
    if (!path) return;
    if (this._dominantCache.has(path)) {
      const cached = this._dominantCache.get(path);
      if (cached) this.layer.style.backgroundColor = cached;
      return;
    }
    const url = this._cache.get(path);
    if (!url) return;
    this._ensureDominant(path, url).then((color) => {
      if (!this._active) return;
      if (sanitizeBackground(this.settings.get('player.slideshowBackground')) !== 'dominant') return;
      if (this._images[this._shownIdx] !== path) return; // stale (folder/order switch)
      if (color) this.layer.style.backgroundColor = color;
    });
  }

  /**
   * Dominant color of a cached data URL: draw the image aspect-fit into a
   * 48x48 canvas (renderer.py scales to 48x48 KeepAspectRatio) and bucket
   * the pixels. data: URLs never taint the canvas. Caches failures as null.
   */
  _ensureDominant(path, url) {
    if (this._dominantCache.has(path)) return Promise.resolve(this._dominantCache.get(path));
    const computed = new Promise((resolve) => {
      let color = null;
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const iw = img.naturalWidth || img.width;
            const ih = img.naturalHeight || img.height;
            if (iw > 0 && ih > 0) {
              const scale = Math.min(DOMINANT_SAMPLE / iw, DOMINANT_SAMPLE / ih);
              const w = Math.max(1, Math.round(iw * scale));
              const h = Math.max(1, Math.round(ih * scale));
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(img, 0, 0, iw, ih, 0, 0, w, h);
                color = dominantColorFromImageData(ctx.getImageData(0, 0, w, h).data, w, h);
              }
            }
          } catch { color = null; }
          resolve(color);
        };
        img.onerror = () => resolve(null);
        img.src = url;
      } catch { resolve(null); }
    });
    return computed.then((color) => {
      this._dominantCache.set(path, color);
      return color;
    });
  }

  async _loadImage(path) {
    if (this._cache.has(path)) return this._cache.get(path);
    if (this._inflight.has(path)) return null;
    this._inflight.add(path);
    let url = null;
    try {
      url = await window.funsync.readSlideshowImage({
        folder: this._folder,
        filePath: path,
        maxDim: 1920,
      });
    } catch { url = null; }
    this._inflight.delete(path);
    if (url) {
      this._cache.set(path, url);
      if (this._cache.size > CACHE_MAX) {
        const keepA = this._images[this._shownIdx];
        const keepB = this._images[this._targetIdx];
        for (const key of this._cache.keys()) {
          if (key === keepA || key === keepB) continue;
          this._cache.delete(key);
          break;
        }
      }
    }
    return url;
  }

  applyGeometry() {
    if (!this._active) return;
    const rect = wipeGeometry(
      this.wrapper.clientWidth,
      this.wrapper.clientHeight,
      this.video.videoWidth || 0,
      this.video.videoHeight || 0,
      this.settings.get('player.slideshowCorner') || 'bottom_right',
      WIPE_MARGIN_PX,
      this.settings.get('player.slideshowSizeDenom') || DEFAULT_WIPE_SIZE_DENOM,
    );
    const vs = this.video.style;
    vs.left = `${rect.x}px`;
    vs.top = `${rect.y}px`;
    vs.width = `${rect.w}px`;
    vs.height = `${rect.h}px`;
    const ws = this.wipeBtn.style;
    ws.left = `${rect.x}px`;
    ws.top = `${rect.y}px`;
    ws.width = `${rect.w}px`;
    ws.height = `${rect.h}px`;
  }
}

/**
 * Build the slideshow popover (folder / preset / corner / size / order).
 * Mirrors the speed-popover anchoring pattern: the caller opens it with the
 * trigger element; positioning is pure CSS (inside #controls-overflow).
 *
 * @returns {{ open: (anchor: HTMLElement) => void, close: () => void,
 *            refresh: () => void, isOpen: () => boolean }}
 */
export function createSlideshowPopover({ controller, popoverEl, t }) {
  const tt = t || ((k) => k);
  let anchor = null;

  const btn = (label, { current = false, onClick, title = null } = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slideshow-popover__item';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(current));
    if (current) b.classList.add('slideshow-popover__item--current');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
      refresh();
    });
    return b;
  };

  const section = (labelText) => {
    const wrap = document.createElement('div');
    wrap.className = 'slideshow-popover__section';
    const label = document.createElement('div');
    label.className = 'slideshow-popover__label';
    label.textContent = labelText;
    wrap.appendChild(label);
    return wrap;
  };

  const row = (parent) => {
    const r = document.createElement('div');
    r.className = 'slideshow-popover__row';
    parent.appendChild(r);
    return r;
  };

  // Compact dropdown for long option lists (presets, transitions): one
  // line in the popover instead of one radio item per option.
  const selectEl = (options, { value, label, onChange }) => {
    const sel = document.createElement('select');
    sel.className = 'slideshow-popover__select';
    sel.setAttribute('aria-label', label);
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    // Guard against a stored value that is no longer offered (e.g. a
    // preset deleted while selected): fall back to the first option.
    sel.value = options.some((opt) => opt.value === value) ? value : options[0].value;
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      onChange(sel.value);
      refresh();
    });
    return sel;
  };

  const refresh = () => {
    if (popoverEl.hidden) return;
    const st = controller.state;
    popoverEl.innerHTML = '';

    // On / off ---------------------------------------------------------------
    popoverEl.appendChild(btn(
      st.active ? tt('player.slideshow.toggleOff') : tt('player.slideshow.toggleOn'),
      { onClick: () => controller.toggle() },
    ));

    // Folder ---------------------------------------------------------------
    const folderSec = section(tt('player.slideshow.folderLabel'));
    const folderRow = row(folderSec);
    const folderVal = document.createElement('span');
    folderVal.className = 'slideshow-popover__value';
    const folderName = st.folder ? String(st.folder).split(/[\\/]/).pop() : tt('player.slideshow.folderNone');
    folderVal.textContent = folderName;
    if (st.folder) folderVal.title = st.folder;
    folderRow.appendChild(folderVal);
    folderRow.appendChild(btn(tt('player.slideshow.changeFolder'), {
      onClick: async () => {
        let dir = null;
        try { dir = await window.funsync.selectDirectory(); } catch { dir = null; }
        if (dir) controller.setFolder(dir);
      },
    }));
    popoverEl.appendChild(folderSec);

    // Preset ---------------------------------------------------------------
    const presetSec = section(tt('player.slideshow.presetLabel'));
    presetSec.appendChild(selectEl(
      [
        { value: '', label: tt('player.slideshow.presetBuiltin') },
        ...st.presets.map((p) => ({ value: p.name, label: p.name })),
      ],
      {
        value: st.presetName || '',
        label: tt('player.slideshow.presetLabel'),
        onChange: (v) => controller.setPresetName(v),
      },
    ));
    popoverEl.appendChild(presetSec);

    // Corner ---------------------------------------------------------------
    const cornerSec = section(tt('player.slideshow.cornerLabel'));
    const cornerRow = row(cornerSec);
    const cornerGlyph = { top_left: '↖', top_right: '↗', bottom_left: '↙', bottom_right: '↘' };
    const cornerKey = {
      top_left: 'player.slideshow.cornerTopLeft',
      top_right: 'player.slideshow.cornerTopRight',
      bottom_left: 'player.slideshow.cornerBottomLeft',
      bottom_right: 'player.slideshow.cornerBottomRight',
    };
    for (const corner of ['top_left', 'top_right', 'bottom_left', 'bottom_right']) {
      cornerRow.appendChild(btn(cornerGlyph[corner], {
        current: st.corner === corner,
        title: tt(cornerKey[corner]),
        onClick: () => controller.setCorner(corner),
      }));
    }
    popoverEl.appendChild(cornerSec);

    // Size -----------------------------------------------------------------
    const sizeSec = section(tt('player.slideshow.sizeLabel'));
    const sizeRow = row(sizeSec);
    const sizeLabel = { 16: 'player.slideshow.sizeSmall', 8: 'player.slideshow.sizeMedium', 4: 'player.slideshow.sizeLarge' };
    for (const denom of SIZES) {
      sizeRow.appendChild(btn(tt(sizeLabel[denom]), {
        current: st.sizeDenom === denom,
        onClick: () => controller.setSizeDenom(denom),
      }));
    }
    popoverEl.appendChild(sizeSec);

    // Photo order ----------------------------------------------------------
    const orderSec = section(tt('player.slideshow.orderLabel'));
    const orderRow = row(orderSec);
    orderRow.appendChild(btn(tt('player.slideshow.orderName'), {
      current: st.imageOrder === 'name',
      onClick: () => controller.setImageOrder('name'),
    }));
    orderRow.appendChild(btn(tt('player.slideshow.orderRandom'), {
      current: st.imageOrder === 'random',
      onClick: () => controller.setImageOrder('random'),
    }));
    popoverEl.appendChild(orderSec);

    // Transition effect ------------------------------------------------------
    const transSec = section(tt('player.slideshow.transitionLabel'));
    const transitionKey = {
      crossfade: 'player.slideshow.transitionCrossfade',
      wipe_left: 'player.slideshow.transitionWipeLeft',
      wipe_right: 'player.slideshow.transitionWipeRight',
      slide_left: 'player.slideshow.transitionSlideLeft',
      slide_right: 'player.slideshow.transitionSlideRight',
      zoom: 'player.slideshow.transitionZoom',
      random: 'player.slideshow.transitionRandom',
    };
    transSec.appendChild(selectEl(
      TRANSITIONS.map((mode) => ({ value: mode, label: tt(transitionKey[mode]) })),
      {
        value: st.transition,
        label: tt('player.slideshow.transitionLabel'),
        onChange: (v) => controller.setTransition(v),
      },
    ));
    popoverEl.appendChild(transSec);

    // Background ---------------------------------------------------------------
    const bgSec = section(tt('player.slideshow.backgroundLabel'));
    const bgRow = row(bgSec);
    const bgKey = {
      solid: 'player.slideshow.backgroundSolid',
      dominant: 'player.slideshow.backgroundDominant',
    };
    for (const mode of BACKGROUNDS) {
      bgRow.appendChild(btn(tt(bgKey[mode]), {
        current: st.background === mode,
        onClick: () => controller.setBackgroundMode(mode),
      }));
    }
    popoverEl.appendChild(bgSec);
  };

  const open = (anchorEl) => {
    anchor = anchorEl;
    // Unhide BEFORE refresh(): refresh() early-returns while hidden, so
    // refreshing first would open the popover empty (fixed 2026-11-20).
    popoverEl.hidden = false;
    refresh();
    anchorEl?.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    popoverEl.hidden = true;
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
  };

  return { open, close, refresh, isOpen: () => !popoverEl.hidden };
}
