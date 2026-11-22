// Borderless-window fullscreen state, shared by the main window and the
// player pop-out.
//
// The DOM Fullscreen API used to back F / the fullscreen button. It pins
// fullscreen to one element, which keeps its own stacking and alt-tab
// quirks. `BrowserWindow.setFullScreen()` instead makes the whole window
// borderless — the player view already hides the nav bar and sizes the
// container to 100vw/100vh, so the result looks identical while behaving
// like a normal window (alt-tab, taskbar, multi-monitor).
//
// The renderer cannot read window fullscreen from the DOM, so it tracks the
// state pushed from main (`window:fullscreen-changed`) here. Every consumer
// — the fullscreen button icon, the mini-player guard, Esc, caption-overlay
// sync — reads `isWindowFullscreen()` instead of `document.fullscreenElement`.
//
// Outside Electron (tests, plain browser) there is no bridge and the state
// stays false; callers fall back to the DOM Fullscreen API.

let _active = false;
let _installed = false;

/** True while THIS window is in borderless window fullscreen. */
export function isWindowFullscreen() {
  return _active;
}

/** True when the Electron bridge for window fullscreen is available. */
export function hasWindowFullscreenBridge() {
  return typeof window !== 'undefined' && !!window.funsync?.setWindowFullscreen;
}

function _set(on) {
  const next = !!on;
  if (next === _active) return;
  _active = next;
  window.dispatchEvent(new CustomEvent('window-fullscreen-changed', { detail: { on: _active } }));
}

/**
 * Enter/leave borderless window fullscreen on the window hosting this
 * renderer. No-ops (returns the unchanged state) without the Electron bridge.
 * @param {boolean} on
 * @returns {Promise<boolean>} the resulting state
 */
export async function setWindowFullscreen(on) {
  const bridge = typeof window !== 'undefined' ? window.funsync : null;
  if (!bridge?.setWindowFullscreen) return _active;
  const result = await bridge.setWindowFullscreen(!!on);
  // The push event is authoritative, but the invoke result lets callers
  // await the state change without racing the round trip.
  _set(typeof result === 'boolean' ? result : !!on);
  return _active;
}

/**
 * Leave window fullscreen if active. Never throws.
 * @returns {Promise<boolean>} the resulting state
 */
export async function exitWindowFullscreen() {
  if (!hasWindowFullscreenBridge()) return _active;
  try {
    await setWindowFullscreen(false);
  } catch { /* window mid-teardown; the push event will correct us */ }
  return _active;
}

/**
 * Subscribe to fullscreen pushes from main — covers the menu's F11 role and
 * any other main-process toggle. Idempotent; no-op without the bridge.
 */
export function installWindowFullscreenWatch() {
  if (_installed) return;
  const bridge = typeof window !== 'undefined' ? window.funsync : null;
  if (!bridge?.onWindowFullscreenChanged) return;
  _installed = true;
  bridge.onWindowFullscreenChanged((on) => _set(on));
  // Adopt the current state in case this renderer loaded while the window
  // was already fullscreen (e.g. a pop-out opened from a fullscreen player).
  Promise.resolve(bridge.getWindowFullscreen?.())
    .then((on) => { if (typeof on === 'boolean') _set(on); })
    .catch(() => { /* non-fatal */ });
}
