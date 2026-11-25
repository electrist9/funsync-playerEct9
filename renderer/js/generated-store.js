// The generated-script folder, as the settings panel sees it.
//
// The backend owns this store: it decides where generated scripts live, checks a
// folder the user picks, and copies the existing scripts into it (a copy, never
// a move — pointing the setting back at the old folder brings those scripts
// back). This module is only the transport plus the shape of the answer, kept
// out of the settings panel so the one ordering rule can be unit-tested:
//
//     POST /api/generate/store/dir  →  THEN write library.generatedStoreDir.
//
// The setting is what the backend reads back on its next store call, so writing
// it first would park the app in a folder the backend had already refused, and
// the user would never be told why.
//
// Every request is loopback-only: generateApiUrl builds the URL.

import { generateApiUrl } from './generate-panel.js';
import { t } from './i18n.js';

/** The one store-folder route. Literal, not `/store/{id}`. */
export const STORE_DIR_ROUTE = '/store/dir';

/**
 * Compare two folder paths the way the backend does, loosely enough that a
 * hand-edited setting (`C:\x\` vs `C:\x`) still reads as the same folder.
 * Deliberately not a full Windows path parser — the backend has that.
 */
export function sameStorePath(left, right) {
  const norm = (value) => String(value || '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  const a = norm(left);
  const b = norm(right);
  return !!a && a === b;
}

/**
 * The settings row, built from a GET /store/dir payload
 * (`{ configured, effective, default, writable }`). Unknown or missing pieces
 * become empty strings rather than guesses. Returns null for anything that is
 * not a payload at all — the row then says the backend did not answer instead
 * of showing a blank path.
 */
export function storeDirStateFor(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const configured = text(payload.configured);
  const effective = text(payload.effective);
  const defaultDir = text(payload.default);

  return {
    configured,
    effective,
    defaultDir,
    // What to show: what the backend is really using. When a configured folder
    // is unusable the backend already fell back, and the row has to show the
    // folder it fell back to — not the one that is being ignored.
    shownPath: effective || defaultDir,
    usingDefault: !configured,
    // Configured but not what is in use: the backend refused it at runtime.
    fellBack: !!configured && !sameStorePath(configured, effective || defaultDir),
    writable: payload.writable !== false,
    // A reset only makes sense while the setting points somewhere else.
    canReset: !!configured && !sameStorePath(configured, defaultDir),
  };
}

/**
 * Ask the backend where its script store is. null = no usable answer (no port
 * yet, backend down, or a reply we cannot read), which the panel shows as such.
 */
export async function loadStoreDir(port) {
  const backendPort = Number(port);
  if (!Number.isInteger(backendPort) || backendPort <= 0) return null;
  try {
    const res = await fetch(generateApiUrl(backendPort, STORE_DIR_ROUTE));
    if (!res.ok) return null;
    return storeDirStateFor(await res.json());
  } catch {
    // Backend not listening yet, or the reply was not JSON.
    return null;
  }
}

/**
 * Ask the backend to adopt `path` as the script folder.
 *
 * Resolves `{ ok: true, payload }` — `payload.path` is the normalised folder to
 * store, `payload.copied` how many scripts came along, `payload.unchanged` true
 * when it was already the store — or `{ ok: false, payload }` whose code maps to
 * a localised refusal (`invalidPath`, `nested`, `notWritable`, `offline`).
 *
 * Nothing on disk and no setting has moved when `ok` is false, which is exactly
 * why the caller is allowed to treat this as the gate.
 */
export async function chooseStoreDir(port, path) {
  const backendPort = Number(port);
  const dir = typeof path === 'string' ? path.trim() : '';

  if (!Number.isInteger(backendPort) || backendPort <= 0) {
    return { ok: false, payload: { code: 'offline' } };
  }
  if (!dir) {
    // Nothing was picked; the backend would answer the same, and asking it to
    // create a folder from an empty string is not a thing.
    return { ok: false, payload: { code: 'invalidPath' } };
  }

  try {
    const res = await fetch(generateApiUrl(backendPort, STORE_DIR_ROUTE), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    const data = await res.json().catch(() => ({}));
    const payload = data && typeof data === 'object' ? data : {};
    return res.ok ? { ok: true, payload } : { ok: false, payload };
  } catch {
    return { ok: false, payload: { code: 'offline' } };
  }
}

/** Result text for a move that succeeded, so the panel does not invent its own. */
export function storeDirMovedText(payload) {
  if (payload?.unchanged) return t('settingsPanel.generated.alreadyThere');
  const copied = Number(payload?.copied);
  return copied > 0
    ? t('settingsPanel.generated.moved', { count: copied })
    : t('settingsPanel.generated.movedNone');
}
