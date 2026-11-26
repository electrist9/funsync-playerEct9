/**
 * Flat-video playback for the VR client.
 *
 * The video decodes in a hidden HTMLVideoElement and is sampled onto a
 * Three.js VideoTexture — exactly the pattern WebXR samples use, since
 * XR sessions cannot composite a DOM <video>. The element is the single
 * source of truth the desktop mirrors: we attach the phone remote's own
 * RemoteSyncClient (clientKind='vr') so the desktop's sync engines bind to
 * OUR clock and connected funscript devices follow the headset. This is the
 * existing phone-as-controller protocol, unchanged.
 *
 * Autoplay caveat: a WebXR controller "select" does not reliably count as
 * DOM user activation, so we always START muted (autoplay-safe) and let the
 * unmute button call play() again in the select handler; if the browser
 * rejects it we fall back to muted rather than stalling playback.
 */

import * as THREE from '../vendor/three/three.module.js';
import { RemoteSyncClient } from '/remote/remote-sync.js';

export class VideoPlayer {
  /**
   * @param {object} opts
   * @param {(msg:object)=>void} [opts.onServerMessage] device-status / script-* relay
   * @param {()=>void} [opts.onKicked] another device took over the session
   */
  constructor({ onServerMessage, onKicked } = {}) {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.muted = true; // autoplay-safe start; unmute is an explicit action

    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    this.info = null;      // current video record from /api/remote/videos
    this.sync = null;
    this.lastError = null;
    this.wsConnected = false; // sync socket open (device drive also needs the desktop app)

    this._onServerMessage = onServerMessage || (() => {});
    this._onKicked = onKicked || (() => {});

    this.video.addEventListener('error', () => {
      this.lastError = this.video.error ? `再生できない形式です (${this.video.error.code})` : '再生エラー';
    });
  }

  get paused() { return this.video.paused; }
  get currentTime() { return this.video.currentTime || 0; }
  get duration() { return this.video.duration || this.info?.duration || 0; }
  get muted() { return this.video.muted; }

  /** Load (and start) a video record; previous playback is torn down. */
  open(videoRecord) {
    this.close();
    this.info = videoRecord;
    this.lastError = null;
    this.video.src = videoRecord.streamUrl || '';
    this.video.load();

    this.sync = new RemoteSyncClient({
      video: this.video,
      videoId: videoRecord.id,
      clientKind: 'vr',
      onServerMessage: this._onServerMessage,
      onKicked: this._onKicked,
      onOpen: () => { this.wsConnected = true; },
      onClose: () => { this.wsConnected = false; },
    });
    this.sync.start();

    this.play();
  }

  /** Start/resume. Never throws — rejections are recorded in lastError. */
  play() {
    const p = this.video.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        // Most likely autoplay policy after an unmute: retry muted so the
        // headset keeps playing rather than freezing on a still frame.
        if (!this.video.muted) {
          this.video.muted = true;
          const retry = this.video.play();
          if (retry && typeof retry.catch === 'function') {
            retry.catch(() => { this.lastError = '再生を再開できません'; });
          }
        } else {
          this.lastError = '再生を開始できません';
        }
        void err;
      });
    }
  }

  pause() { this.video.pause(); }

  toggle() {
    if (this.video.paused) this.play();
    else this.video.pause();
  }

  /** Toggle audio; called from a controller select, which may double as activation. */
  toggleMute() {
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.paused) this.play();
  }

  seekBy(seconds) {
    const dur = this.duration;
    const next = Math.max(0, Math.min(dur || Infinity, this.currentTime + seconds));
    this.video.currentTime = next;
  }

  seekTo(fraction) {
    const dur = this.duration;
    if (!dur) return;
    this.video.currentTime = Math.max(0, Math.min(dur, dur * fraction));
  }

  close() {
    if (this.sync) {
      this.sync.stop();
      this.sync = null;
    }
    this.wsConnected = false;
    try { this.video.pause(); } catch { /* ignore */ }
    this.video.removeAttribute('src');
    this.video.load();
    this.info = null;
    this.lastError = null;
  }

  dispose() {
    this.close();
    this.texture.dispose();
  }
}
