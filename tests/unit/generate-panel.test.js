// Unit tests for the auto-generate panel (renderer/js/generate-panel.js).
//
// Two layers, matching how the module is built:
//   1. Pure helpers (URL shape, request body, error mapping, chip/summary text)
//      — no DOM, no timers.
//   2. A few class-level flows driven with a stubbed fetch, because they encode
//      the two hard product rules: every request is loopback-only, and a
//      generated script never replaces a hand-made sidecar without an explicit
//      confirm.
//
// tests/setup.js preloads the English locale bundle, so t() returns the real
// English strings asserted below.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GeneratePanel,
  generateApiUrl,
  errorTextFor,
  startBodyFor,
  percentFor,
  chipStateFor,
  summaryTextFor,
} from '../../renderer/js/generate-panel.js';
import { Modal } from '../../renderer/components/modal.js';

// ------------------------------------------------------------------ pure helpers

describe('generateApiUrl', () => {
  it('targets the local backend only', () => {
    expect(generateApiUrl(5123, '/audio')).toBe('http://127.0.0.1:5123/api/generate/audio');
    expect(generateApiUrl(9999, '/store/abc/export')).toBe(
      'http://127.0.0.1:9999/api/generate/store/abc/export',
    );
  });

  it('never produces a non-loopback host', () => {
    for (const path of ['/audio', '/motion', '/j1', '/j1/cancel', '/store']) {
      expect(generateApiUrl(5123, path)).toMatch(/^http:\/\/127\.0\.0\.1:5123\/api\/generate/);
    }
  });
});

describe('startBodyFor', () => {
  const base = {
    engine: 'audio',
    preset: 'standard',
    style: 'alternating',
    device: 'handy',
    sensitivity: 1.4,
    minPos: 0,
    maxPos: 100,
  };

  it('sends sensitivity for the audio engine and no quality preset', () => {
    const body = startBodyFor({ ...base, engine: 'audio', sensitivity: 1.8 });
    expect(body).toEqual({
      style: 'alternating',
      device: 'handy',
      min_pos: 0,
      max_pos: 100,
      sensitivity: 1.8,
    });
    expect(body.quality).toBeUndefined();
  });

  it('sends the quality preset for the motion engine and no sensitivity', () => {
    const body = startBodyFor({ ...base, engine: 'motion', preset: 'fast', style: 'energy' });
    expect(body.quality).toBe('fast');
    expect(body.style).toBe('energy');
    expect(body.sensitivity).toBeUndefined();
  });

  it('keeps the device and style selections', () => {
    const body = startBodyFor({ ...base, device: 'handy2pro_oc', style: 'sine' });
    expect(body.device).toBe('handy2pro_oc');
    expect(body.style).toBe('sine');
  });

  it('orders a reversed range instead of rejecting it', () => {
    const body = startBodyFor({ ...base, minPos: 90, maxPos: 10 });
    expect(body.min_pos).toBe(10);
    expect(body.max_pos).toBe(90);
  });

  it('clamps out-of-range values and falls back on garbage', () => {
    const clamped = startBodyFor({ ...base, minPos: -20, maxPos: 250 });
    expect(clamped.min_pos).toBe(0);
    expect(clamped.max_pos).toBe(100);

    const garbage = startBodyFor({ ...base, minPos: 'abc', maxPos: '' });
    expect(garbage.min_pos).toBe(0);
    expect(garbage.max_pos).toBe(0);
  });
});

describe('percentFor', () => {
  it('turns the backend fraction into a whole percent', () => {
    expect(percentFor(0.423)).toBe(42);
    expect(percentFor(0)).toBe(0);
    expect(percentFor(1)).toBe(100);
  });

  it('clamps and tolerates missing values', () => {
    expect(percentFor(undefined)).toBe(0);
    expect(percentFor(null)).toBe(0);
    expect(percentFor(-1)).toBe(0);
    expect(percentFor(1.5)).toBe(100);
  });
});

describe('errorTextFor', () => {
  it('maps a backend detail.code to a localised message', () => {
    expect(errorTextFor({ detail: { code: 'noAudio' } })).toBe('This video has no audio track.');
    expect(errorTextFor({ detail: { code: 'noFfmpeg' } }))
      .toBe('FFmpeg is missing, so the video cannot be read.');
    expect(errorTextFor({ code: 'exists' }))
      .toBe('A .funscript file already exists next to this video.');
    expect(errorTextFor({ code: 'offline' }))
      .toBe('The local backend is not reachable.');
  });

  it('falls back to the generic failure text for unknown codes', () => {
    expect(errorTextFor({ code: 'somethingNew' })).toBe('Generation failed.');
    expect(errorTextFor({})).toBe('Generation failed.');
    expect(errorTextFor(null)).toBe('Generation failed.');
  });

  it('never echoes the backend detail', () => {
    const text = errorTextFor({ detail: { code: 'badRange', message: 'C:\\secret\\video.mp4' } });
    expect(text).toBe('The selected options are invalid.');
    expect(text).not.toContain('secret');
  });
});

describe('chipStateFor', () => {
  it('is null with no job', () => {
    expect(chipStateFor(null)).toBeNull();
    expect(chipStateFor(undefined)).toBeNull();
  });

  it('reports a running job with a percent and no linger', () => {
    const state = chipStateFor({ status: 'running', progress: 0.42, engine: 'audio' });
    expect(state.state).toBe('running');
    expect(state.percent).toBe(42);
    expect(state.text).toBe('Generating… 42%');
    expect(state.linger).toBeUndefined();
  });

  it('reports a finished job as done', () => {
    const state = chipStateFor({
      status: 'done', engine: 'audio', summary: {}, script: { actions: [{ at: 0, pos: 10 }] },
    });
    expect(state).toEqual({ state: 'done', text: 'Script ready', linger: true });
  });

  it('reports an empty result per engine', () => {
    const audio = chipStateFor({ status: 'done', engine: 'audio', summary: { empty: true } });
    expect(audio.state).toBe('empty');
    expect(audio.text).toBe('No beats detected');

    const motion = chipStateFor({ status: 'done', engine: 'motion', summary: { empty: true } });
    expect(motion.state).toBe('empty');
    expect(motion.text).toBe('No motion detected');
  });

  it('reports an error with the mapped message', () => {
    const state = chipStateFor({ status: 'error', engine: 'audio', error_code: 'noVideo' });
    expect(state.state).toBe('error');
    expect(state.text).toBe('The video file could not be found.');
    expect(state.linger).toBe(true);
  });

  it('shows nothing for a cancelled job', () => {
    expect(chipStateFor({ status: 'cancelled', engine: 'audio', summary: {} })).toBeNull();
  });
});

describe('summaryTextFor', () => {
  it('counts the generated actions', () => {
    const job = { status: 'done', engine: 'audio', summary: {}, script: { actions: new Array(12).fill({ at: 0, pos: 1 }) } };
    expect(summaryTextFor(job)).toBe('12 actions');
  });

  it('appends the detected tempo when the backend reported one', () => {
    const job = {
      status: 'done', engine: 'audio', script: { actions: [{ at: 0, pos: 1 }] },
      summary: { tempo: { bpm: 128.4 } },
    };
    expect(summaryTextFor(job)).toBe('1 actions · ~128 BPM');
  });

  it('says nothing was detected for an empty result', () => {
    expect(summaryTextFor({ status: 'done', engine: 'motion', summary: { empty: true } }))
      .toBe('No motion detected');
  });

  it('reports cancellation and errors', () => {
    expect(summaryTextFor({ status: 'cancelled', engine: 'audio', summary: {} })).toBe('Cancelled');
    expect(summaryTextFor({ status: 'error', engine: 'audio', error_code: 'noAudio' }))
      .toBe('This video has no audio track.');
  });
});

// ---------------------------------------------------------------- class flows

function makePanel(overrides = {}) {
  return new GeneratePanel({
    getBackendPort: () => 5123,
    getVideo: () => ({ path: 'V', name: 'v.mp4' }),
    onPreview: () => {},
    onChip: () => {},
    ...overrides,
  });
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function toastTexts(type) {
  const container = document.getElementById('toast-container');
  if (!container) return [];
  return Array.from(container.querySelectorAll(`.toast--${type} .toast__body`))
    .map((node) => node.textContent);
}

describe('GeneratePanel start', () => {
  let fetchMock;

  beforeEach(() => {
    if (!document.getElementById('toast-container')) {
      const holder = document.createElement('div');
      holder.id = 'toast-container';
      document.body.appendChild(holder);
    }
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.getElementById('toast-container')?.remove();
  });

  it('posts to the loopback backend with the current form state', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { job_id: 'j1', status: 'queued' }));
    const panel = makePanel();
    panel.engine = 'motion';
    panel.preset = 'high';
    panel.style = 'energy';
    panel.device = 'handy2';

    await panel._start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5123/api/generate/motion');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      video_path: 'V',
      style: 'energy',
      device: 'handy2',
      min_pos: 0,
      max_pos: 100,
      quality: 'high',
    });
    expect(panel.busy).toBe(true);
    panel.reset();
  });

  it('sends the current video path because the backend reads the file itself', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { job_id: 'j1', status: 'queued' }));
    const panel = makePanel({ getVideo: () => ({ path: 'F:\\media\\a.mp4', name: 'a.mp4' }) });

    await panel._start();

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).video_path).toBe('F:\\media\\a.mp4');
    panel.reset();
  });

  it('does not call the backend when the loaded video has no path', async () => {
    // Remote (yt-dlp) streams have no local file the backend could open.
    const panel = makePanel({ getVideo: () => ({ name: 'stream' }) });

    await panel._start();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(panel.busy).toBe(false);
  });

  it('adopts a job another client started when the backend is busy', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { code: 'busy', job_id: 'other', engine: 'motion' }));
    const chips = [];
    const panel = makePanel({ onChip: (state) => chips.push(state) });

    await panel._start();

    expect(panel._job.job_id).toBe('other');
    expect(panel._job.engine).toBe('motion');
    expect(panel.busy).toBe(true);
    expect(chips[0]?.state).toBe('running');
    expect(toastTexts('warn')).toContain('Another generation is already running.');
    panel.reset();
    expect(chips[chips.length - 1]).toBeNull();
  });

  it('does not request anything when the backend port is unknown', async () => {
    const panel = makePanel({ getBackendPort: () => null });
    await panel._start();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastTexts('error')).toContain('The local backend is not reachable.');
  });

  it('does not request anything for a remote stream (no local file)', async () => {
    const panel = makePanel({ getVideo: () => null });
    await panel._start();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastTexts('error')).toContain('The video file could not be found.');
  });

  it('surfaces a backend rejection as a localised toast', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { detail: { code: 'badRange', field: 'device' } }));
    const panel = makePanel();
    await panel._start();
    expect(panel._job).toBeNull();
    expect(toastTexts('error')).toContain('The selected options are invalid.');
  });
});

describe('GeneratePanel repeat and reset', () => {
  let fetchMock;

  beforeEach(() => {
    if (!document.getElementById('toast-container')) {
      const holder = document.createElement('div');
      holder.id = 'toast-container';
      document.body.appendChild(holder);
    }
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.getElementById('toast-container')?.remove();
  });

  it('runs a fresh generation straight away instead of showing the start screen', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { job_id: 'j2', status: 'queued' }));
    const chips = [];
    const panel = makePanel({ onChip: (state) => chips.push(state) });
    panel._job = { job_id: 'j1', engine: 'audio', status: 'done', summary: {}, script_id: 's9' };

    await panel._again();

    expect(chips[0]).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:5123/api/generate/audio');
    expect(panel._job.job_id).toBe('j2');
    panel.reset();
  });

  it('cancels a job that is still running when the video changes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { job_id: 'j1', status: 'queued' }));
    const panel = makePanel();
    await panel._start();
    expect(panel.busy).toBe(true);
    fetchMock.mockClear();

    panel.reset();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:5123/api/generate/j1/cancel');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(panel._job).toBeNull();
    expect(panel.busy).toBe(false);
  });

  it('does not cancel anything for a job that already finished', () => {
    const panel = makePanel();
    panel._job = { job_id: 'j1', engine: 'audio', status: 'done', summary: {} };

    panel.reset();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(panel._job).toBeNull();
  });
});

describe('GeneratePanel export', () => {
  let fetchMock;
  let panel;

  beforeEach(() => {
    if (!document.getElementById('toast-container')) {
      const holder = document.createElement('div');
      holder.id = 'toast-container';
      document.body.appendChild(holder);
    }
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    panel = makePanel();
    panel._job = {
      job_id: 'j1',
      engine: 'audio',
      status: 'done',
      progress: 1,
      summary: {},
      script_id: 's1',
      script: { version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 500, pos: 90 }] },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.getElementById('toast-container')?.remove();
  });

  it('writes straight through when no sidecar exists', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      ok: true, filename: 'v.funscript', action_count: 2, overwrote: false,
    }));

    await panel._export();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5123/api/generate/store/s1/export');
    expect(JSON.parse(init.body)).toEqual({ overwrite: false });
    expect(panel._job.exported).toBe('v.funscript');
    expect(toastTexts('info')).toContain('Saved as v.funscript');
  });

  it('asks before replacing a hand-made sidecar, then retries with overwrite', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { detail: { code: 'exists', filename: 'v.funscript' } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true, filename: 'v.funscript', action_count: 2, overwrote: true,
      }));
    const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);

    await panel._export();

    expect(confirm).toHaveBeenCalledWith(
      'A funscript already exists',
      'There is already a .funscript file next to this video. Saving will replace it, and your existing file will be lost.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ overwrite: false });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ overwrite: true });
    expect(panel._job.exported).toBe('v.funscript');
    expect(toastTexts('info')).toContain('Saved as v.funscript');
  });

  it('never sends an overwrite request when the user declines', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { detail: { code: 'exists', filename: 'v.funscript' } }));
    vi.spyOn(Modal, 'confirm').mockResolvedValue(false);

    await panel._export();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ overwrite: false });
    expect(panel._job.exported).toBeUndefined();
    expect(toastTexts('info')).toHaveLength(0);
  });

  it('does nothing without a stored script', async () => {
    panel._job = { ...panel._job, script_id: null };
    await panel._export();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GeneratePanel preview', () => {
  it('hands the stored script to the player with its metadata', async () => {
    if (!document.getElementById('toast-container')) {
      const holder = document.createElement('div');
      holder.id = 'toast-container';
      document.body.appendChild(holder);
    }
    try {
      const onPreview = vi.fn();
      const panel = makePanel({ onPreview });
      const script = { version: '1.0', actions: [{ at: 0, pos: 10 }] };
      panel._job = { job_id: 'j1', engine: 'motion', status: 'done', summary: {}, script_id: 's9', script };

      await panel._preview();

      expect(onPreview).toHaveBeenCalledWith(script, { scriptId: 's9', engine: 'motion' });
      expect(toastTexts('info')).toContain('Generated script loaded for preview');
    } finally {
      document.getElementById('toast-container')?.remove();
    }
  });

  it('reports a failed preview without throwing', async () => {
    if (!document.getElementById('toast-container')) {
      const holder = document.createElement('div');
      holder.id = 'toast-container';
      document.body.appendChild(holder);
    }
    try {
      const panel = makePanel({ onPreview: () => { throw new Error('bad script'); } });
      panel._close = vi.fn();
      panel._job = {
        job_id: 'j1', engine: 'audio', status: 'done', summary: {},
        script_id: 's9', script: { version: '1.0', actions: [{ at: 0, pos: 10 }] },
      };

      await panel._preview();

      expect(toastTexts('error')).toContain('Generation failed.');
      // A failed preview keeps the window open so the user can retry.
      expect(panel._close).not.toHaveBeenCalled();
    } finally {
      document.getElementById('toast-container')?.remove();
    }
  });

  it('closes the window after a successful preview so the player is visible', async () => {
    if (!document.getElementById('toast-container')) {
      const holder = document.createElement('div');
      holder.id = 'toast-container';
      document.body.appendChild(holder);
    }
    try {
      const panel = makePanel({ onPreview: vi.fn() });
      panel._close = vi.fn();
      panel._job = {
        job_id: 'j1', engine: 'audio', status: 'done', summary: {},
        script_id: 's9', script: { version: '1.0', actions: [{ at: 0, pos: 10 }] },
      };

      await panel._preview();

      expect(panel._close).toHaveBeenCalledWith(null);
    } finally {
      document.getElementById('toast-container')?.remove();
    }
  });
});
