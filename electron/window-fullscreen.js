// Borderless-window fullscreen plumbing, shared by the main window and the
// player pop-out (both run the same preload, so both need the same push).
//
// `BrowserWindow.setFullScreen()` is the borderless fullscreen on Windows —
// no title bar, no taskbar, normal alt-tab behaviour. The BrowserWindow
// `enter-full-screen` / `leave-full-screen` events fire for it (and NOT for
// DOM Fullscreen API toggles on Windows), so they are the single source of
// truth the renderer tracks for the fullscreen button icon, Esc handling,
// the mini-player guard and caption-overlay sync — including toggles made
// through the menu's `role: 'togglefullscreen'` (F11).

'use strict';

/**
 * Push fullscreen state changes from a BrowserWindow to its renderer.
 * Call once per window, right after creation.
 * @param {import('electron').BrowserWindow} win
 */
function wireWindowFullscreenEvents(win) {
  const push = (on) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('window:fullscreen-changed', on);
    } catch { /* window mid-teardown */ }
  };
  win.on('enter-full-screen', () => push(true));
  win.on('leave-full-screen', () => push(false));
}

module.exports = { wireWindowFullscreenEvents };
