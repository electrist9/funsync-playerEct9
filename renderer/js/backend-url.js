// backend-url.js — loopback backend URL helpers for the renderer.
//
// With settings.backend.tls on, the backend is spawned with --tls and
// serves HTTPS using a self-signed cert (needed for WebXR: browsers only
// expose navigator.xr on a secure context). The main process knows the
// scheme it actually launched with; app.js fetches it once at boot
// (IPC `get-backend-tls`) and calls setBackendTls() before any renderer
// code builds backend URLs.
//
// Default is plain http — non-Electron contexts (unit tests) and any
// early call before the IPC resolves keep the historical behavior.

let tls = false;

export function setBackendTls(value) {
  tls = value === true;
}

export function backendTls() {
  return tls;
}

/** Loopback http(s) URL for a backend route, scheme matched to TLS state. */
export function httpUrl(port, path) {
  return `${tls ? 'https' : 'http'}://127.0.0.1:${port}${path}`;
}

/** Loopback ws(s) URL for a backend WebSocket, scheme matched to TLS state. */
export function wsUrl(port, path) {
  return `${tls ? 'wss' : 'ws'}://127.0.0.1:${port}${path}`;
}
