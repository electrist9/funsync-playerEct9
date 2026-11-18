/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The library's 「一致あり」 filter and generated scripts.
//
// Regression: a video whose only funscript was generated —
// えなこ-ZZZZ__dj pawa-orgasm (hardstyle) [MB0CkGfoGoY]-audio.funscript —
// never showed up under the matched filter. Generated scripts live in the app's
// own store folder, which the library scan never walks, so the scan answered
// "no script". The library now joins the backend store against its scan list and
// marks those videos as matched, without ever writing an association: the store
// stays the source of truth, so deleting the script un-marks the video again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library } from '../../renderer/components/library.js';
import { canonicalPath } from '../../renderer/js/path-utils.js';

const STORE_DIR = 'C:\\Users\\me\\AppData\\Roaming\\FunSync\\generated-scripts';
const VIDEO = 'D:\\Y\\SLIB\\Movie\\えなこ-ZZZZ__dj pawa-orgasm (hardstyle) [MB0CkGfoGoY].mp4';
const GENERATED = `${STORE_DIR}\\えなこ-ZZZZ__dj pawa-orgasm (hardstyle) [MB0CkGfoGoY]-audio.funscript`;

/** A library instance with just the state these paths touch. */
function makeLibrary(videos, settings = {}) {
  const lib = Object.create(Library.prototype);
  lib._videos = videos;
  lib._generatedScriptsByVideo = new Map();
  lib._generatedRetryTimer = null;
  lib._generatedRetryAttempts = 0;
  lib._settings = { get: (key) => settings[key] };
  return lib;
}

const record = (overrides = {}) => ({
  id: 's-1',
  engine: 'audio:clicks',
  filename: 'えなこ-ZZZZ__dj pawa-orgasm (hardstyle) [MB0CkGfoGoY]-audio.funscript',
  video_path: VIDEO,
  path: GENERATED,
  ...overrides,
});

describe('Library._applyGeneratedScripts', () => {
  it('marks a video whose only script is a generated one as matched', () => {
    const video = { path: VIDEO, hasFunscript: false, funscriptPath: null };
    const lib = makeLibrary([video]);
    lib._generatedScriptsByVideo = new Map([[canonicalPath(VIDEO), {
      scriptId: 's-1', path: GENERATED, family: 'audio', filename: record().filename,
    }]]);
    lib._applyGeneratedScripts();
    expect(video.hasFunscript).toBe(true);
    expect(video.funscriptPath).toBe(GENERATED);
    expect(video._generatedScript.scriptId).toBe('s-1');
  });

  it('leaves a video that already has a script alone — manual wins', () => {
    const sidecar = 'D:\\Y\\SLIB\\Movie\\えなこ-ZZZZ__dj pawa-orgasm (hardstyle) [MB0CkGfoGoY].funscript';
    const video = { path: VIDEO, hasFunscript: true, funscriptPath: sidecar, _manualAssociation: true };
    const lib = makeLibrary([video]);
    lib._generatedScriptsByVideo = new Map([[canonicalPath(VIDEO), {
      scriptId: 's-1', path: GENERATED, family: 'audio', filename: 'x-audio.funscript',
    }]]);
    lib._applyGeneratedScripts();
    expect(video.funscriptPath).toBe(sidecar);
    expect(video._generatedScript).toBeUndefined();
  });

  it('un-marks a video once the store no longer lists its script', () => {
    // Deleting the script in the generate dialog must not leave the video in
    // 「一致あり」 pointing at a file that is gone.
    const video = { path: VIDEO, hasFunscript: true, funscriptPath: GENERATED, _generatedScript: {
      scriptId: 's-1', path: GENERATED, family: 'audio', filename: 'x-audio.funscript',
    } };
    const lib = makeLibrary([video]);
    lib._applyGeneratedScripts();
    expect(video.hasFunscript).toBe(false);
    expect(video.funscriptPath).toBeNull();
    expect(video._generatedScript).toBeNull();
  });

  it('keeps a path the user pointed elsewhere in the meantime', () => {
    // The marker says where the join put the path; if something else moved it
    // (a manual association saved after the join), that newer answer wins.
    const manual = 'D:\\Y\\SLIB\\Movie\\other.funscript';
    const video = { path: VIDEO, hasFunscript: true, funscriptPath: manual, _generatedScript: {
      scriptId: 's-1', path: GENERATED, family: 'audio', filename: 'x-audio.funscript',
    } };
    const lib = makeLibrary([video]);
    lib._applyGeneratedScripts();
    expect(video.funscriptPath).toBe(manual);
    expect(video._generatedScript).toBeNull();
  });

  it('joins through the canonical path, not the spelling', () => {
    // The store records the path the app was handed; the scan spells it with the
    // separators the OS uses. Same file, one join.
    const video = { path: 'd:/Y/SLIB/Movie/えなこ-ZZZZ__dj pawa-orgasm (hardstyle) [MB0CkGfoGoY].mp4', hasFunscript: false, funscriptPath: null };
    const lib = makeLibrary([video]);
    lib._generatedScriptsByVideo = new Map([[canonicalPath(VIDEO), {
      scriptId: 's-1', path: GENERATED, family: 'audio', filename: 'x-audio.funscript',
    }]]);
    lib._applyGeneratedScripts();
    expect(video.hasFunscript).toBe(true);
  });
});

describe('Library._funscriptBadgeStyle', () => {
  it('says which kind of script a generated match is', () => {
    const lib = makeLibrary([]);
    expect(lib._funscriptBadgeStyle({ _generatedScript: { family: 'audio' } }))
      .toEqual({ modifier: 'audio', title: 'Generated audio' });
    expect(lib._funscriptBadgeStyle({ _generatedScript: { family: 'motion' } }))
      .toEqual({ modifier: 'motion', title: 'Generated motion' });
  });

  it('falls back to manual / auto markers for everything else', () => {
    const lib = makeLibrary([]);
    // A family this build has no label for still plays — plain auto marker.
    expect(lib._funscriptBadgeStyle({ _generatedScript: { family: '' } }))
      .toEqual({ modifier: 'auto', title: 'Funscript (auto-detected)' });
    expect(lib._funscriptBadgeStyle({ _manualAssociation: true }))
      .toEqual({ modifier: 'manual', title: 'Funscript (manual)' });
    expect(lib._funscriptBadgeStyle({}))
      .toEqual({ modifier: 'auto', title: 'Funscript (auto-detected)' });
  });
});

describe('Library._refreshGeneratedScripts', () => {
  let fetches;
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetches = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  const stubFetch = (impl) => {
    globalThis.fetch = (url, init) => {
      fetches.push({ url, init });
      return impl(url, init);
    };
  };

  it('asks the store for every record, once', async () => {
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [record()] }) }));
    const video = { path: VIDEO, hasFunscript: false, funscriptPath: null };
    const lib = makeLibrary([video]);
    await lib._refreshGeneratedScripts();
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe('http://127.0.0.1:5123/api/generate/store');
    expect(video.hasFunscript).toBe(true);
    expect(video.funscriptPath).toBe(GENERATED);
  });

  it('obeys the same switch as the player dropdown and fetches nothing', async () => {
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [record()] }) }));
    const video = { path: VIDEO, hasFunscript: true, funscriptPath: GENERATED, _generatedScript: {
      scriptId: 's-1', path: GENERATED, family: 'audio', filename: 'x-audio.funscript',
    } };
    const lib = makeLibrary([video], { 'library.useGeneratedVariants': false });
    await lib._refreshGeneratedScripts();
    expect(fetches).toHaveLength(0);
    expect(video.hasFunscript).toBe(false);
    expect(video.funscriptPath).toBeNull();
  });

  it('falls back to the scan and schedules a bounded retry when the store is unreachable', async () => {
    vi.useFakeTimers();
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const video = { path: VIDEO, hasFunscript: false, funscriptPath: null };
    const lib = makeLibrary([video]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await lib._refreshGeneratedScripts();
    expect(lib._generatedScriptsByVideo.size).toBe(0);
    expect(video.hasFunscript).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    // One chain at a time, and the chain is capped.
    await lib._refreshGeneratedScripts();
    expect(vi.getTimerCount()).toBe(1);
    lib._generatedRetryAttempts = 2;
    lib._generatedRetryTimer = null;
    lib._scheduleGeneratedScriptsRetry();
    // Still just the one pending retry — the cap stopped a new one.
    expect(vi.getTimerCount()).toBe(1);
    warn.mockRestore();
  });

  it('counts a reachable-but-empty store as an answer, not a failure', async () => {
    vi.useFakeTimers();
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) }));
    const lib = makeLibrary([{ path: VIDEO, hasFunscript: false, funscriptPath: null }]);
    await lib._refreshGeneratedScripts();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats an HTTP error like an unreachable store', async () => {
    vi.useFakeTimers();
    stubFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    const lib = makeLibrary([{ path: VIDEO, hasFunscript: false, funscriptPath: null }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await lib._refreshGeneratedScripts();
    expect(lib._generatedScriptsByVideo.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    warn.mockRestore();
  });
});

describe('Library.refreshGeneratedScripts', () => {
  it('does nothing before the first scan', async () => {
    const originalFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = () => { called += 1; return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) }); };
    const lib = makeLibrary([]);
    try {
      await lib.refreshGeneratedScripts();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(0);
  });

  it('re-joins, then re-filters and re-registers so every surface agrees', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [record()] }) });
    const video = { path: VIDEO, hasFunscript: false, funscriptPath: null };
    const lib = makeLibrary([video]);
    const calls = [];
    lib._applyFilters = () => calls.push('filters');
    lib._registerWithBackend = () => calls.push('register');
    try {
      await lib.refreshGeneratedScripts();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(video.hasFunscript).toBe(true);
    expect(calls).toEqual(['filters', 'register']);
  });
});