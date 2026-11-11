// generate-panel.js — auto-generate a funscript from the video being played.
//
// Talks to the local backend `/api/generate/*` routes (backend/routes/generate.py).
// The backend runs one job at a time and answers 409 {"code":"busy"} when a
// second request arrives; a finished job's script is kept in the app-internal
// generated-script store, never written next to the video automatically.
//
// HARD PRODUCT RULES enforced here:
//   1. Nothing leaves the machine — every request targets 127.0.0.1.
//   2. Writing a `.funscript` beside the video is a SEPARATE, explicit action
//      ("Save next to the video"). If a hand-made sidecar already exists the
//      backend answers 409 {"code":"exists"}; we ask the user to confirm and
//      only then retry with {"overwrite": true}. A generated script can never
//      silently replace something the user made by hand.
//   3. Logs carry job IDs, script IDs, engines, counts and durations only —
//      never file paths or usernames (console.* is forwarded to the log file
//      by js/logger.js, so the same privacy rule applies to console calls).
//
// The job keeps running when this modal is closed: progress is mirrored to the
// player's generate chip (see `_emitChip`) so the user can watch the video
// while the backend works.

import { Modal } from '../components/modal.js';
import { t } from './i18n.js';
import { showToast } from './toast.js';
import { icon, AudioWaveform, Activity, WandSparkles, Download } from './icons.js';

const POLL_MS = 600;
const TERMINAL_STATUSES = ['done', 'error', 'cancelled'];
// Terminal chip messages fade out; a running job never does.
const CHIP_LINGER_MS = 6000;

const ENGINES = ['audio', 'motion'];
const PRESETS = ['fast', 'standard', 'high'];
const STYLES = ['alternating', 'sine', 'energy'];
const DEVICES = ['handy', 'handy2', 'handy2pro', 'handy2pro_oc'];
// Slider band: 0.1 (dense) .. 1.5 (sparse), step 0.1. The engine accepts a
// wider band and clamps anything outside it (services/audio_analysis.py).
const SENSITIVITY_MIN = 0.1;
const SENSITIVITY_MAX = 1.5;
// Starting point for the panel. The panel always sends an explicit value, so
// this is what the user sees first; services/audio_analysis.py keeps its own
// 1.4 default for requests that omit the field (web remote, hand-crafted API
// calls).
const SENSITIVITY_DEFAULT = 0.2;

/** Tiny DOM helper — textContent only, never innerHTML (CSP + XSS hygiene). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function button(className, label, onClick, iconNode) {
  const btn = el('button', className);
  btn.type = 'button';
  if (iconNode) btn.appendChild(icon(iconNode, { width: 15, height: 15, 'stroke-width': 1.9 }));
  btn.appendChild(el('span', null, label));
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

export class GeneratePanel {
  /**
   * @param {Object} opts
   * @param {() => number|null} opts.getBackendPort — live backend port.
   * @param {() => ({path: string, name: string}|null)} opts.getVideo — the
   *        currently loaded LOCAL video (null for remote streams, which the
   *        backend cannot analyse because it needs a file on disk).
   * @param {(script: object, meta: {scriptId: string|null, engine: string}) => Promise<void>|void} opts.onPreview
   *        Loads the generated script into the player for auditioning. The
   *        caller is responsible for keeping the script editor pointed away
   *        from the on-disk sidecar (setFunscriptPath(null)).
   * @param {(state: object|null) => void} [opts.onChip] — player progress chip.
   */
  constructor(opts = {}) {
    this._getPort = opts.getBackendPort || (() => null);
    this._getVideo = opts.getVideo || (() => null);
    this._onPreview = opts.onPreview || (() => {});
    this._onChip = opts.onChip || (() => {});

    this._job = null;      // latest job payload from the backend
    this._port = null;     // port the running job was started against
    this._timer = null;    // poll timer
    this._chipTimer = null;
    this._ui = null;       // live modal refs (null while the modal is closed)
    this._isOpen = false;

    // Form state, remembered for the rest of the session.
    this.engine = 'audio';
    this.preset = 'standard';
    this.style = 'alternating';
    this.device = 'handy';
    this.sensitivity = SENSITIVITY_DEFAULT;
    this.minPos = 0;
    this.maxPos = 100;
  }

  /** True while a job is queued or running. */
  get busy() {
    return !!this._job && !TERMINAL_STATUSES.includes(this._job.status);
  }

  /** Open the generate modal (no-op when one is already showing). */
  open() {
    if (this._isOpen) return;
    const video = this._getVideo();
    if (!video || !video.path) {
      showToast(t('generate.error.noVideo'), 'error');
      return;
    }
    this._isOpen = true;
    Modal.open({
      title: t('generate.title'),
      onRender: (body, close) => {
        this._close = close;
        this._build(body);
      },
    }).then(() => {
      this._isOpen = false;
      this._close = null;
      this._ui = null;
    });
  }

  /**
   * Drop the current generation context: stop polling, cancel a job that is
   * still running (its result would belong to a video the user has left
   * behind), clear the chip and put an open modal back on the start screen.
   */
  reset() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._chipTimer) { clearTimeout(this._chipTimer); this._chipTimer = null; }
    const job = this._job;
    if (job && !TERMINAL_STATUSES.includes(job.status)) this._cancel();
    this._job = null;
    this._port = null;
    this._emitChip(null);
    this._render();
  }

  // ---------------------------------------------------------------- requests

  _url(path) {
    return generateApiUrl(this._port || this._getPort(), path);
  }

  /** Map a backend error payload to a localised message (never echoes detail). */
  _errorText(payload) {
    return errorTextFor(payload);
  }

  async _start() {
    if (this.busy) return;
    const port = this._getPort();
    const video = this._getVideo();
    if (!port) {
      showToast(t('generate.error.offline'), 'error');
      return;
    }
    if (!video || !video.path) {
      showToast(t('generate.error.noVideo'), 'error');
      return;
    }

    // A generation replaces the stored `<video>-audio.funscript` /
    // `<video>-motion.funscript` for this video and engine family, so when one
    // is already there the user confirms first: the previous script is lost.
    // Nothing on screen changes until that answer comes back yes.
    if (!(await this._confirmOverwrite())) return;

    // The backend opens the file itself, so it needs the absolute path of the
    // local video. startBodyFor() stays free of it (pure form state); the path
    // is attached here, at the one place that knows which video is loaded.
    const body = { ...startBodyFor(this), video_path: video.path };

    try {
      const res = await fetch(this._url(`/${this.engine}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && (data?.code ?? data?.detail?.code) === 'busy') {
        // Another generation is already running (possibly started from the
        // web remote). Adopt it so the chip + modal track the real job.
        showToast(t('generate.error.busy'), 'warn');
        if (data.job_id) this._adopt(data.job_id, data.engine);
        return;
      }
      if (!res.ok) {
        showToast(this._errorText(data), 'error');
        return;
      }

      this._port = port;
      this._job = {
        job_id: data.job_id,
        engine: this.engine,
        status: data.status || 'queued',
        progress: 0,
        summary: {},
      };
      console.log('[generate] job started', { jobId: data.job_id, engine: this.engine });
      this._render();
      this._emitChip();
      this._schedulePoll();
    } catch (err) {
      console.warn('[generate] start request failed', String(err?.message || err));
      showToast(t('generate.error.offline'), 'error');
    }
  }

  /** Track a job this panel did not start (backend 409 busy → job_id). */
  _adopt(jobId, engine) {
    if (!jobId) return;
    this._job = { job_id: jobId, engine: engine || 'audio', status: 'running', progress: 0, summary: {} };
    this._render();
    this._emitChip();
    this._schedulePoll();
  }

  async _cancel() {
    const job = this._job;
    if (!job || TERMINAL_STATUSES.includes(job.status)) return;
    try {
      await fetch(this._url(`/${job.job_id}/cancel`), { method: 'POST' });
      console.log('[generate] cancel requested', { jobId: job.job_id });
    } catch (err) {
      console.warn('[generate] cancel request failed', String(err?.message || err));
    }
  }

  _schedulePoll() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this._pollOnce(); }, POLL_MS);
  }

  async _pollOnce() {
    const job = this._job;
    if (!job) return;
    try {
      const res = await fetch(this._url(`/${job.job_id}`));
      if (res.status === 404) {
        this._applyUpdate({ ...job, status: 'error', error_code: 'notFound' });
        return;
      }
      const data = await res.json().catch(() => ({}));
      this._applyUpdate({ ...job, ...data });
    } catch (err) {
      // Transient (backend restart, momentary refusal) — keep polling.
      console.warn('[generate] poll failed', String(err?.message || err));
      this._schedulePoll();
    }
  }

  _applyUpdate(next) {
    const prev = this._job;
    this._job = next;
    if (prev?.status !== next.status) {
      console.log('[generate] job status', { jobId: next.job_id, status: next.status });
    }
    this._render();
    this._emitChip();
    if (TERMINAL_STATUSES.includes(next.status)) {
      if (next.status === 'error') {
        console.warn('[generate] job failed', {
          jobId: next.job_id, code: next.error_code || 'failed',
        });
      }
    } else {
      this._schedulePoll();
    }
  }

  /**
   * Run a fresh generation with the current settings — one click, no trip back
   * through the start screen. The overwrite confirm lives in `_start()`, so a
   * declined prompt leaves the finished result exactly where it was.
   */
  async _again() {
    return this._start();
  }

  /**
   * Ask before a generation replaces the script already stored for this video
   * and engine family. False means "do not start". A store that cannot be read
   * answers "nothing stored", because the worst case should be a missing
   * confirm, never a generation the user asked for being blocked.
   */
  async _confirmOverwrite() {
    const stored = await this._storedFor(this.engine);
    if (!stored.length) return true;
    return Modal.confirm(
      t('generate.overwriteTitle'),
      t('generate.overwriteBody', { filename: stored[0].filename || '' }),
    );
  }

  /**
   * Scripts already stored for the loaded video and one engine family, newest
   * first. Empty on any failure: the worst case is skipping the confirm, never
   * blocking the generation the user asked for.
   */
  async _storedFor(engine) {
    const port = this._port || this._getPort();
    const video = this._getVideo();
    if (!port || !video?.path) return [];
    try {
      const res = await fetch(this._url(`/store?video_path=${encodeURIComponent(video.path)}`));
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return (Array.isArray(data?.items) ? data.items : [])
        .filter((item) => String(item?.engine || '').split(':')[0] === engine);
    } catch (err) {
      console.warn('[generate] store lookup failed', String(err?.message || err));
      return [];
    }
  }

  // ---------------------------------------------------------------- preview

  async _preview() {
    const job = this._job;
    if (!job?.script) return;
    try {
      await this._onPreview(job.script, {
        scriptId: job.script_id || null,
        engine: job.engine,
      });
      showToast(t('generate.previewed'), 'info');
      // The audition happens in the player, so get out of the way. Only on
      // success: a failed preview leaves the modal open to retry from.
      this._close?.(null);
    } catch (err) {
      console.warn('[generate] preview failed', String(err?.message || err));
      showToast(t('generate.error.failed'), 'error');
    }
  }

  // ------------------------------------------------------------------- export

  /**
   * Write the stored script next to the video. Never overwrites silently:
   * the backend refuses with 409 {"code":"exists"} when a sidecar is already
   * there, and we only retry with overwrite=true after an explicit confirm.
   */
  async _export() {
    const job = this._job;
    if (!job?.script_id || this._exporting) return;
    this._exporting = true;
    try {
      let res = await this._postExport(false);
      let data = await res.json().catch(() => ({}));
      const code = data?.detail?.code ?? data?.code;

      if (res.status === 409 && code === 'exists') {
        const replace = await Modal.confirm(t('generate.existsTitle'), t('generate.existsBody'));
        if (!replace) return;
        res = await this._postExport(true);
        data = await res.json().catch(() => ({}));
      }

      if (!res.ok) {
        showToast(this._errorText(data), 'error');
        return;
      }
      this._job = { ...this._job, exported: data.filename || null };
      console.log('[generate] exported', {
        scriptId: job.script_id, overwrote: !!data.overwrote,
        actionCount: data.action_count ?? null,
      });
      showToast(t('generate.saved', { filename: data.filename || '' }), 'info');
      this._render();
    } catch (err) {
      console.warn('[generate] export failed', String(err?.message || err));
      showToast(t('generate.error.offline'), 'error');
    } finally {
      this._exporting = false;
    }
  }

  _postExport(overwrite) {
    return fetch(this._url(`/store/${this._job.script_id}/export`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overwrite: !!overwrite }),
    });
  }

  // -------------------------------------------------------------------- chip

  _emitChip(explicit) {
    if (this._chipTimer) { clearTimeout(this._chipTimer); this._chipTimer = null; }
    if (explicit === null) { this._onChip(null); return; }

    const state = chipStateFor(this._job);
    this._onChip(state);
    // Fade the terminal chip out; the modal (if open) still shows the result.
    if (state?.linger) {
      this._chipTimer = setTimeout(() => { this._chipTimer = null; this._onChip(null); }, CHIP_LINGER_MS);
    }
  }

  // ------------------------------------------------------------------- modal

  _build(body) {
    const root = el('div', 'generate');

    root.appendChild(el('p', 'generate__intro', t('generate.intro')));

    // --- analysis method -------------------------------------------------
    const engineField = el('div', 'generate__field');
    engineField.appendChild(el('span', 'generate__label', t('generate.engineLabel')));
    const engineRow = el('div', 'generate__cards');
    engineRow.setAttribute('role', 'radiogroup');
    engineRow.setAttribute('aria-label', t('generate.engineLabel'));
    for (const key of ENGINES) {
      const card = el('label', 'generate__card');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'generate-engine';
      input.value = key;
      input.checked = this.engine === key;
      input.addEventListener('change', () => {
        this.engine = key;
        this._render();
      });
      card.appendChild(input);
      card.appendChild(icon(key === 'audio' ? AudioWaveform : Activity, {
        width: 18, height: 18, 'stroke-width': 1.9, class: 'generate__card-icon',
      }));
      const text = el('span', 'generate__card-text');
      text.appendChild(el('span', 'generate__card-title', t(`generate.engine${cap(key)}`)));
      text.appendChild(el('span', 'generate__card-hint', t(`generate.engine${cap(key)}Hint`)));
      card.appendChild(text);
      engineRow.appendChild(card);
    }
    engineField.appendChild(engineRow);
    root.appendChild(engineField);

    // --- quality preset (motion only: it selects engine + resolution) -----
    const presetField = el('div', 'generate__field');
    presetField.appendChild(el('span', 'generate__label', t('generate.presetLabel')));
    const presetRow = el('div', 'generate__cards generate__cards--compact');
    presetRow.setAttribute('role', 'radiogroup');
    presetRow.setAttribute('aria-label', t('generate.presetLabel'));
    for (const key of PRESETS) {
      const card = el('label', 'generate__card');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'generate-preset';
      input.value = key;
      input.checked = this.preset === key;
      input.addEventListener('change', () => { this.preset = key; });
      card.appendChild(input);
      const text = el('span', 'generate__card-text');
      text.appendChild(el('span', 'generate__card-title', t(`generate.preset${cap(key)}`)));
      text.appendChild(el('span', 'generate__card-hint', t(`generate.preset${cap(key)}Hint`)));
      card.appendChild(text);
      presetRow.appendChild(card);
    }
    presetField.appendChild(presetRow);
    root.appendChild(presetField);

    // --- details ----------------------------------------------------------
    const details = el('details', 'generate__details');
    const summary = el('summary', 'generate__details-summary', t('generate.details'));
    details.appendChild(summary);

    const styleField = el('div', 'generate__subfield');
    const styleLabel = el('label', 'generate__label', t('generate.styleLabel'));
    const styleSelect = document.createElement('select');
    styleSelect.className = 'generate__select';
    styleLabel.htmlFor = styleSelect.id = `generate-style-${Math.random().toString(36).slice(2, 8)}`;
    for (const key of STYLES) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = t(`generate.style${cap(key)}`);
      if (this.style === key) opt.selected = true;
      styleSelect.appendChild(opt);
    }
    styleSelect.addEventListener('change', () => { this.style = styleSelect.value; });
    styleField.appendChild(styleLabel);
    styleField.appendChild(styleSelect);
    details.appendChild(styleField);

    const deviceField = el('div', 'generate__subfield');
    const deviceLabel = el('label', 'generate__label', t('generate.deviceLabel'));
    const deviceSelect = document.createElement('select');
    deviceSelect.className = 'generate__select';
    deviceLabel.htmlFor = deviceSelect.id = `generate-device-${Math.random().toString(36).slice(2, 8)}`;
    for (const key of DEVICES) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = deviceDisplayName(key);
      if (this.device === key) opt.selected = true;
      deviceSelect.appendChild(opt);
    }
    deviceSelect.addEventListener('change', () => { this.device = deviceSelect.value; });
    deviceField.appendChild(deviceLabel);
    deviceField.appendChild(deviceSelect);
    details.appendChild(deviceField);

    const sensField = el('div', 'generate__subfield');
    const sensLabel = el('label', 'generate__label', t('generate.sensitivityLabel'));
    const sensRow = el('div', 'generate__range-row');
    const sensInput = document.createElement('input');
    sensInput.type = 'range';
    sensInput.className = 'generate__range';
    sensInput.min = String(SENSITIVITY_MIN);
    sensInput.max = String(SENSITIVITY_MAX);
    sensInput.step = '0.1';
    sensInput.value = String(this.sensitivity);
    sensLabel.htmlFor = sensInput.id = `generate-sens-${Math.random().toString(36).slice(2, 8)}`;
    const sensValue = el('span', 'generate__range-value', formatSensitivity(this.sensitivity));
    sensInput.addEventListener('input', () => {
      this.sensitivity = Number(sensInput.value);
      sensValue.textContent = formatSensitivity(this.sensitivity);
    });
    sensRow.appendChild(sensInput);
    sensRow.appendChild(sensValue);
    sensField.appendChild(sensLabel);
    sensField.appendChild(sensRow);
    sensField.appendChild(el('span', 'generate__hint', t('generate.sensitivityHint')));
    details.appendChild(sensField);

    const rangeField = el('div', 'generate__subfield');
    rangeField.appendChild(el('span', 'generate__label', t('generate.rangeLabel')));
    const rangeRow = el('div', 'generate__range-inputs');
    const minInput = numberInput(this.minPos, t('generate.minPos'), (value) => { this.minPos = value; });
    const maxInput = numberInput(this.maxPos, t('generate.maxPos'), (value) => { this.maxPos = value; });
    rangeRow.appendChild(minInput);
    rangeRow.appendChild(el('span', 'generate__range-dash', '–'));
    rangeRow.appendChild(maxInput);
    rangeField.appendChild(rangeRow);
    rangeField.appendChild(el('span', 'generate__hint', t('generate.rangeHint')));
    details.appendChild(rangeField);

    root.appendChild(details);

    // --- progress ---------------------------------------------------------
    const progress = el('div', 'generate__progress');
    progress.hidden = true;
    const bar = el('div', 'generate__bar');
    const fill = el('div', 'generate__bar-fill');
    bar.appendChild(fill);
    progress.appendChild(bar);
    const progressText = el('div', 'generate__progress-text', t('generate.running'));
    progress.appendChild(progressText);
    root.appendChild(progress);

    // --- result -----------------------------------------------------------
    const result = el('div', 'generate__result');
    result.hidden = true;
    const resultSummary = el('div', 'generate__result-summary');
    result.appendChild(resultSummary);
    const resultNote = el('div', 'generate__hint', t('generate.storedNote'));
    result.appendChild(resultNote);
    const resultActions = el('div', 'generate__result-actions');
    const previewBtn = button('generate__btn', t('generate.preview'), () => this._preview(), WandSparkles);
    const saveBtn = button('generate__btn generate__btn--primary', t('generate.saveToFile'), () => this._export(), Download);
    const againBtn = button('generate__btn', t('generate.again'), () => this._again());
    resultActions.appendChild(previewBtn);
    resultActions.appendChild(saveBtn);
    resultActions.appendChild(againBtn);
    result.appendChild(resultActions);
    const savedLine = el('div', 'generate__saved');
    savedLine.hidden = true;
    result.appendChild(savedLine);
    root.appendChild(result);

    // --- actions ----------------------------------------------------------
    const actions = el('div', 'modal-actions');
    const closeBtn = button('modal-btn modal-btn--secondary', t('common.close'), () => this._close?.(null));
    const startBtn = button('modal-btn modal-btn--primary', t('generate.start'), () => this._start(), WandSparkles);
    const cancelBtn = button('modal-btn modal-btn--secondary', t('generate.cancel'), () => this._cancel());
    cancelBtn.hidden = true;
    actions.appendChild(closeBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(startBtn);
    root.appendChild(actions);

    body.appendChild(root);
    this._ui = {
      root, presetField, sensField, progress, bar, fill, progressText,
      result, resultSummary, resultNote, resultActions, savedLine,
      startBtn, cancelBtn,
    };
    this._render();
    setTimeout(() => startBtn.focus(), 0);
  }

  /** Reflect current job state into the open modal (safe when closed). */
  _render() {
    const ui = this._ui;
    if (!ui) return;
    const job = this._job;
    const running = !!job && !TERMINAL_STATUSES.includes(job.status);
    const finished = !!job && TERMINAL_STATUSES.includes(job.status);

    // Motion presets pick the analysis engine; audio has a single pass.
    ui.presetField.hidden = this.engine !== 'motion';
    ui.sensField.hidden = this.engine !== 'audio';

    ui.progress.hidden = !running;
    if (running) {
      const percent = percentFor(job.progress);
      ui.fill.style.width = `${percent}%`;
      ui.progressText.textContent = t(
        job.engine === 'motion' ? 'generate.progressMotion' : 'generate.progressAudio',
        { percent },
      );
    }

    ui.startBtn.hidden = running || finished;
    ui.cancelBtn.hidden = !running;
    ui.result.hidden = !finished;

    if (finished) {
      ui.resultSummary.textContent = this._summaryText(job);
      const isEmpty = job.status !== 'done' || job.summary?.empty;
      ui.resultActions.hidden = isEmpty;
      ui.resultNote.hidden = isEmpty || !job.script_id;
      if (!ui.resultNote.hidden) {
        // Naming the stored file tells the user what a second generation
        // would replace; older backends omit it, so keep the generic note.
        const filename = job.summary?.filename;
        ui.resultNote.textContent = filename
          ? t('generate.storedAs', { filename })
          : t('generate.storedNote');
      }
      ui.savedLine.hidden = !job.exported;
      if (job.exported) {
        ui.savedLine.textContent = t('generate.saved', { filename: job.exported });
      }
    }
  }

  _summaryText(job) {
    return summaryTextFor(job);
  }
}

// ------------------------------------------------------------------- helpers

function cap(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function formatSensitivity(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : String(SENSITIVITY_DEFAULT);
}

function deviceDisplayName(key) {
  if (key === 'handy') return 'Handy';
  if (key === 'handy2') return 'Handy 2';
  if (key === 'handy2pro') return 'Handy 2 Pro';
  if (key === 'handy2pro_oc') return 'Handy 2 Pro (open cycle)';
  return key;
}

function numberInput(value, ariaLabel, onChange) {
  const wrap = el('label', 'generate__number');
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'generate__input';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.value = String(value);
  input.setAttribute('aria-label', ariaLabel);
  input.addEventListener('change', () => { onChange(clampInt(input.value, 0, 100, 0)); });
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'generate__number-label', ariaLabel));
  return wrap;
}

// ------------------------------------------------------- pure helpers (unit-tested)
//
// Kept free of DOM and timers so tests/unit/generate-panel.test.js can pin the
// request shape, the loopback-only URL, the error mapping and the chip states.

/** Backend URL for a generate route. Always loopback: nothing leaves the machine. */
export function generateApiUrl(port, path) {
  return `http://127.0.0.1:${port}/api/generate${path}`;
}

/** Map a backend/renderer error payload to a localised message (never echoes detail). */
export function errorTextFor(payload) {
  const code = payload?.detail?.code ?? payload?.code ?? '';
  const key = `generate.error.${code}`;
  const text = t(key);
  // t() returns the key itself when a translation is missing.
  return text === key ? t('generate.error.failed') : text;
}

/** Request body for POST /api/generate/{engine} from the current form state. */
export function startBodyFor(state) {
  const minPos = clampInt(state.minPos, 0, 100, 0);
  const maxPos = clampInt(state.maxPos, 0, 100, 100);
  const body = {
    style: state.style,
    device: state.device,
    min_pos: Math.min(minPos, maxPos),
    max_pos: Math.max(minPos, maxPos),
  };
  // Motion presets pick the analysis engine + resolution; audio has sensitivity.
  if (state.engine === 'motion') body.quality = state.preset;
  else body.sensitivity = Number(state.sensitivity);
  return body;
}

/** Backend progress fraction (0..1) → whole percent clamped to 0..100. */
export function percentFor(progress) {
  return Math.max(0, Math.min(100, Math.round((Number(progress) || 0) * 100)));
}

/**
 * Player chip state for a job payload, or null when nothing should show.
 * `linger: true` marks a terminal message that fades out on its own.
 */
export function chipStateFor(job) {
  if (!job) return null;

  if (TERMINAL_STATUSES.includes(job.status)) {
    if (job.status === 'cancelled') return null;
    if (job.status === 'error') {
      return { state: 'error', text: errorTextFor({ code: job.error_code }), linger: true };
    }
    if (job.summary?.empty) {
      return {
        state: 'empty',
        text: t(job.engine === 'motion' ? 'generate.emptyMotion' : 'generate.emptyAudio'),
        linger: true,
      };
    }
    return { state: 'done', text: t('generate.chipDone'), linger: true };
  }

  const percent = percentFor(job.progress);
  return { state: 'running', percent, text: t('generate.chipRunning', { percent }) };
}

/** One-line result summary for the modal (and the chip's sibling text). */
export function summaryTextFor(job) {
  if (job.status === 'cancelled') return t('generate.cancelled');
  if (job.status === 'error') return errorTextFor({ code: job.error_code });
  if (job.summary?.empty) {
    return t(job.engine === 'motion' ? 'generate.emptyMotion' : 'generate.emptyAudio');
  }
  const count = job.script?.actions?.length ?? job.summary?.action_count ?? 0;
  let text = t('generate.resultSummary', { count });
  const bpm = job.summary?.tempo?.bpm ?? job.summary?.bpm;
  if (typeof bpm === 'number' && bpm > 0) {
    text += ` · ${t('generate.tempoInfo', { bpm: Math.round(bpm) })}`;
  }
  return text;
}

export default GeneratePanel;
