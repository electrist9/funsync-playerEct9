// Unit tests for the generated-script folder (renderer/js/generated-store.js).
//
// The store folder is user-configurable, and two rules hold the feature up:
//
//   1. The backend decides first. The panel POSTs /api/generate/store/dir, and
//      only a successful answer — the folder was checked, and the existing
//      scripts were COPIED into it — may write library.generatedStoreDir. A
//      refusal must reach the user as a reason, not as a silent no-op.
//   2. Every request is loopback-only, exactly like the rest of the generate
//      API. generateApiUrl builds the URL; nothing here composes a host.
//
// Layer 1 is pure helpers plus a stubbed fetch. The ordering rule itself cannot
// be exercised without a live backend, so it is asserted on the panel's source
// text, which is how variants.test.js and log-redact.test.js pin wiring.
//
// tests/setup.js preloads the English locale bundle, so t() and errorTextFor()
// below return the real English strings.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  STORE_DIR_ROUTE,
  sameStorePath,
  storeDirStateFor,
  loadStoreDir,
  chooseStoreDir,
  storeDirMovedText,
} from '../../renderer/js/generated-store.js';
import { generateApiUrl, errorTextFor } from '../../renderer/js/generate-panel.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

// ------------------------------------------------------------------ the route

describe('store folder route', () => {
  it('is one literal route on the loopback backend', () => {
    // Literal, not `/store/{id}`: the backend declares /store/dir first so the
    // id route cannot swallow it, and the renderer must use the same literal.
    expect(STORE_DIR_ROUTE).toBe('/store/dir');
    expect(generateApiUrl(5123, STORE_DIR_ROUTE))
      .toBe('http://127.0.0.1:5123/api/generate/store/dir');
  });

  it('never produces a non-loopback host', () => {
    for (const port of [5123, 8000, 65535]) {
      expect(generateApiUrl(port, STORE_DIR_ROUTE))
        .toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/generate/store/dir$`));
    }
  });
});

// -------------------------------------------------------------------- path use

describe('sameStorePath', () => {
  it('reads a hand-edited setting as the folder it means', () => {
    expect(sameStorePath('C:\\Scripts\\', 'C:\\Scripts')).toBe(true);
    expect(sameStorePath('C:/Scripts/', 'C:\\scripts')).toBe(true);
    expect(sameStorePath('C:\\Scripts\\\\nested', 'C:/Scripts/nested')).toBe(true);
  });

  it('is false for anything that is not the same folder', () => {
    expect(sameStorePath('C:\\Scripts', 'C:\\Other')).toBe(false);
    expect(sameStorePath('C:\\Scripts', 'D:\\Scripts')).toBe(false);
    // An empty side is never "the same folder" as another empty side.
    expect(sameStorePath('', '')).toBe(false);
    expect(sameStorePath(null, 'C:\\Scripts')).toBe(false);
    expect(sameStorePath('C:\\Scripts', undefined)).toBe(false);
  });
});

// ------------------------------------------------------------------- row state

describe('storeDirStateFor', () => {
  it('returns null for anything that is not a payload', () => {
    for (const junk of [null, undefined, '', 'C:\\Scripts', 5, false]) {
      expect(storeDirStateFor(junk)).toBeNull();
    }
  });

  it('shows the built-in folder while nothing is configured', () => {
    const state = storeDirStateFor({
      configured: null,
      effective: 'C:\\Users\\me\\AppData\\generated-scripts',
      default: 'C:\\Users\\me\\AppData\\generated-scripts',
      writable: true,
    });
    expect(state.usingDefault).toBe(true);
    expect(state.fellBack).toBe(false);
    // Nothing to undo, so no "use default folder" button.
    expect(state.canReset).toBe(false);
    expect(state.shownPath).toBe('C:\\Users\\me\\AppData\\generated-scripts');
  });

  it('offers a reset once the setting points somewhere else', () => {
    const state = storeDirStateFor({
      configured: 'D:\\FunScripts',
      effective: 'D:\\FunScripts',
      default: 'C:\\Users\\me\\AppData\\generated-scripts',
      writable: true,
    });
    expect(state.usingDefault).toBe(false);
    expect(state.canReset).toBe(true);
    expect(state.fellBack).toBe(false);
    expect(state.shownPath).toBe('D:\\FunScripts');
  });

  it('says which folder is really in use when the configured one was refused', () => {
    const state = storeDirStateFor({
      configured: 'E:\\missing',
      effective: 'C:\\Users\\me\\AppData\\generated-scripts',
      default: 'C:\\Users\\me\\AppData\\generated-scripts',
      writable: true,
    });
    expect(state.fellBack).toBe(true);
    // The row must not show the folder that is being ignored.
    expect(state.shownPath).toBe('C:\\Users\\me\\AppData\\generated-scripts');
    expect(state.canReset).toBe(true);
  });

  it('does not offer a reset when the setting merely spells the default differently', () => {
    const state = storeDirStateFor({
      configured: 'C:\\Users\\Me\\AppData\\generated-scripts\\',
      effective: 'C:\\Users\\me\\AppData\\generated-scripts',
      default: 'C:\\Users\\me\\AppData\\generated-scripts',
      writable: true,
    });
    expect(state.canReset).toBe(false);
    expect(state.fellBack).toBe(false);
  });

  it('falls back to the default path when the payload omits the effective one', () => {
    const state = storeDirStateFor({ configured: '', default: 'C:\\gen' });
    expect(state.shownPath).toBe('C:\\gen');
    // A payload that never says "not writable" is treated as writable.
    expect(state.writable).toBe(true);
  });

  it('reports an unwritable effective folder', () => {
    const state = storeDirStateFor({ configured: 'D:\\x', effective: 'D:\\x', default: 'C:\\gen', writable: false });
    expect(state.writable).toBe(false);
  });

  it('turns junk fields into empty strings instead of guessing', () => {
    const state = storeDirStateFor({ configured: 5, effective: {}, default: ['C:\\gen'] });
    expect(state.configured).toBe('');
    expect(state.effective).toBe('');
    expect(state.defaultDir).toBe('');
    expect(state.shownPath).toBe('');
    expect(state.usingDefault).toBe(true);
    expect(state.canReset).toBe(false);
  });
});

// ------------------------------------------------------------------ the GET

describe('loadStoreDir', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the backend instead of reading the setting', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      configured: 'D:\\FunScripts',
      effective: 'D:\\FunScripts',
      default: 'C:\\gen',
      writable: true,
    }));

    const state = await loadStoreDir(5123);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:5123/api/generate/store/dir');
    expect(state.shownPath).toBe('D:\\FunScripts');
    expect(state.canReset).toBe(true);
  });

  it('does not ask at all before there is a backend port', async () => {
    for (const port of [0, undefined, null, NaN, 'nope']) {
      expect(await loadStoreDir(port)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports no answer for an error status, a broken reply, or a dead backend', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { detail: 'boom' }));
    expect(await loadStoreDir(5123)).toBeNull();

    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
    expect(await loadStoreDir(5123)).toBeNull();

    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await loadStoreDir(5123)).toBeNull();
  });
});

// ----------------------------------------------------------------- the POST

describe('chooseStoreDir', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the backend to adopt the picked folder', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      ok: true,
      path: 'D:\\FunScripts',
      copied: 3,
      skipped: 0,
    }));

    const result = await chooseStoreDir(5123, '  D:\\FunScripts  ');

    expect(result.ok).toBe(true);
    expect(result.payload.path).toBe('D:\\FunScripts');
    expect(result.payload.copied).toBe(3);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5123/api/generate/store/dir');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    // Trimmed before it goes over the wire, so a stray space cannot become part
    // of a folder name.
    expect(JSON.parse(init.body)).toEqual({ path: 'D:\\FunScripts' });
  });

  it('refuses locally when there is no backend port or nothing was picked', async () => {
    expect((await chooseStoreDir(0, 'D:\\x')).payload.code).toBe('offline');
    expect((await chooseStoreDir(undefined, 'D:\\x')).payload.code).toBe('offline');
    expect((await chooseStoreDir(5123, '   ')).payload.code).toBe('invalidPath');
    expect((await chooseStoreDir(5123, null)).payload.code).toBe('invalidPath');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the backend reason for every refusal', async () => {
    const refusals = [
      [400, 'invalidPath', "That folder can't be used. Pick a real folder you can write to."],
      [409, 'nested', 'That folder is already inside the current script folder.'],
      [500, 'notWritable', "That folder can't be written to."],
    ];

    for (const [status, code, english] of refusals) {
      // The backend answers with FastAPI's detail envelope.
      fetchMock.mockResolvedValue(jsonResponse(status, { detail: { code } }));
      const result = await chooseStoreDir(5123, 'D:\\nope');
      expect(result.ok).toBe(false);
      expect(errorTextFor(result.payload)).toBe(english);
    }
  });

  it('still refuses without a reason when the error reply is unreadable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
    const result = await chooseStoreDir(5123, 'D:\\nope');
    expect(result.ok).toBe(false);
    expect(result.payload).toEqual({});
    expect(errorTextFor(result.payload)).toBe('Generation failed.');
  });

  it('calls the backend unreachable when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const result = await chooseStoreDir(5123, 'D:\\FunScripts');
    expect(result.ok).toBe(false);
    expect(errorTextFor(result.payload)).toBe('The local backend is not reachable.');
  });
});

// --------------------------------------------------------------- result toast

describe('storeDirMovedText', () => {
  it('counts what was copied, and says so in plural or singular', () => {
    expect(storeDirMovedText({ path: 'D:\\x', copied: 2 })).toBe('2 scripts copied to the new folder');
    expect(storeDirMovedText({ path: 'D:\\x', copied: 1 })).toBe('1 script copied to the new folder');
  });

  it('distinguishes an empty store from a folder that was already the store', () => {
    expect(storeDirMovedText({ path: 'D:\\x', copied: 0, skipped: 0 }))
      .toBe('Scripts will be saved in the new folder.');
    expect(storeDirMovedText({ path: 'D:\\x', copied: 0, skipped: 0, unchanged: true }))
      .toBe('Scripts are already saved in that folder.');
    expect(storeDirMovedText(undefined)).toBe('Scripts will be saved in the new folder.');
  });
});

// ------------------------------------------------------------------ the wiring

describe('the settings panel asks the backend before it writes the setting', () => {
  const settings = read('../../renderer/components/settings-panel.js');
  const transport = read('../../renderer/js/generated-store.js');
  const app = read('../../renderer/js/app.js');

  const section = settings.slice(
    settings.indexOf('_buildGeneratedStoreSection() {'),
    settings.indexOf('_buildPlaybackTab() {'),
  );

  it('the section exists and is built into the sources tab', () => {
    expect(section).not.toBe('');
    expect(settings).toContain("panel.appendChild(this._buildGeneratedStoreSection());");
  });

  it('app.js hands the panel a live port and refreshes the views on a move', () => {
    // The port only exists in app.js, so it arrives as a getter rather than a
    // number baked in when the panel was constructed.
    expect(app).toContain('getBackendPort: () => this.backendPort,');
    expect(app).toContain('onGeneratedStoreChanged: () => this._refreshGeneratedStoreViews(),');
    expect(app).toContain('onStoredChanged: () => this._refreshGeneratedStoreViews(),');
    const views = app.slice(
      app.indexOf('_refreshGeneratedStoreViews() {'),
      app.indexOf('async _refreshGeneratedVariants() {'),
    );
    // One method, so a store move cannot update the generate dialog and leave
    // the library list (or the current video's chips) pointing at the old folder.
    for (const call of [
      'this._refreshGeneratedVariants();',
      'this._refreshCurrentVariantsFromDisk();',
      'this.library?.refreshGeneratedScripts?.();',
    ]) {
      expect(views, `app.js _refreshGeneratedStoreViews ${call}`).toContain(call);
    }
  });

  it('the POST comes first, and the setting is only written on success', () => {
    const asked = section.indexOf('chooseStoreDir(');
    const wrote = section.indexOf("this._settings.set(");
    expect(asked).toBeGreaterThan(-1);
    expect(wrote).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(wrote);
    expect(section).toContain("'library.generatedStoreDir'");
    // The refusal path returns before the write, so a rejected folder never
    // lands in config.json — and the reason is shown, not swallowed.
    expect(section).toContain('if (!result.ok)');
    expect(section.indexOf('if (!result.ok)')).toBeLessThan(wrote);
    expect(section).toContain('showToast(errorTextFor(result.payload), \'error\');');
  });

  it('the folder it stores is the backend answer, not the raw pick', () => {
    // Windows quietly rewrites a path; storing the normalised answer is what
    // keeps the row and the backend agreeing.
    expect(section).toContain('result.payload.path');
    expect(section).toContain('sameStorePath(');
    // Reset means "no setting", i.e. the built-in folder.
    expect(section).toContain("SETTINGS_DEFAULTS['library.generatedStoreDir']");
  });

  it('every path in this panel is text, never markup', () => {
    // A folder name is user data; innerHTML would let a crafted name inject DOM.
    expect(section).not.toMatch(/innerHTML/);
    expect(section).toMatch(/pathEl\.textContent = state\.shownPath;/);
  });

  it('the transport owns the HTTP and the panel owns no fetch', () => {
    expect(transport).toContain("method: 'POST'");
    expect(transport).toContain('fetch(generateApiUrl(backendPort, STORE_DIR_ROUTE)');
    // The renderer never writes config.json itself, and the store module must
    // not start doing it.
    expect(transport).not.toContain('_settings.set');
    expect(section).not.toMatch(/fetch\(/);
    expect(section).not.toMatch(/127\.0\.0\.1/);
  });
});

// --------------------------------------------------------------------- i18n

describe('every locale ships the store-folder strings', () => {
  const KEYS = [
    'header', 'hint', 'choose', 'useDefault', 'working', 'unknown', 'unreachable',
    'folderDefault', 'folderCustom', 'fellBack', 'notWritableWarning',
    'moved', 'movedNone', 'alreadyThere',
  ];
  const ERROR_KEYS = ['invalidPath', 'nested', 'notWritable'];

  it('all eight bundles carry them, and the plural form is a real plural', () => {
    for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const json = JSON.parse(read(`../../renderer/locales/${locale}.json`));
      const generated = json.settingsPanel?.generated;
      for (const key of KEYS) {
        expect(generated?.[key], `${locale}.json settingsPanel.generated.${key}`).toBeTruthy();
      }
      for (const key of ERROR_KEYS) {
        expect(json.generate?.error?.[key], `${locale}.json generate.error.${key}`).toBeTruthy();
      }
      // locale-key-parity.test.js proves the keys match across bundles; this
      // pins that `moved` is an ICU plural the panel can count with.
      expect(generated.moved, `${locale}.json settingsPanel.generated.moved`)
        .toContain('{count, plural');
      expect(generated.moved, `${locale}.json settingsPanel.generated.moved`).toContain('#');
    }
  });
});
