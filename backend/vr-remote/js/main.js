/**
 * FunSync VR — WebXR headset client (Phase 1 MVP).
 *
 * Flow: DOM overlay (pre-session) → immersive-vr session → in-scene UI.
 * There is no DOM inside the session, so all UI is UIPanel quads
 * (CanvasTexture + controller ray + raycaster hit regions).
 *
 * Two modes:
 *   library — browse videos from GET /api/remote/videos (same API as the
 *             phone remote), pick one to play.
 *   player  — flat video on a big screen quad, hidden <video> +
 *             VideoTexture, control panel (play/pause, ±10s, mute, back).
 *
 * Sync: the hidden <video> is driven through the phone remote's own
 * RemoteSyncClient with clientKind='vr'. The desktop observer treats us as
 * the "phone" (last-wins takeover unchanged) and its sync engines bind to
 * our clock, so connected funscript devices follow the headset.
 *
 * Projection modes (Phase 3): flat videos play on the screen quad; equirect
 * (180/360) and angular fisheye videos render on a head-centered sphere
 * with per-eye SBS/TB sampling (see vr-screen.js / vr-shaders.js). The
 * per-video format comes from the backend (`video.vrFormat`), the player
 * control offers a manual override cycle. Subtitles ride a panel anchored
 * below the screen/sphere in the world; during video playback the control
 * panel auto-hides and re-appears when aim moves onto it or the trigger is
 * pressed. In-scene
 * search / playlists in Phase 4. Flat videos support the
 * photo slideshow (Phase 2) using the desktop-configured folder and the
 * shared /shared-js/slideshow-timing.js + slideshow-color.js logic.
 */

import * as THREE from '../vendor/three/three.module.js';
import { UIPanel, drawPanelBackground, drawButton, ellipsize, roundRect } from './panel.js';
import { LibraryModel, fetchVideos } from './library.js';
import { VideoPlayer } from './player.js';
import { SlideshowModel, SlideshowRenderer } from './slideshow.js';
import { VRScreen } from './vr-screen.js';
import { resolveVRMode, nextOverride, modeLabel, overrideButtonLabel } from './vr-mode.js';
import { parseSubtitles, activeCue } from './subtitles.js';
import { formatTime } from './util.js';

const FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif';
const SORT_LABELS = { name: '名前', recent: '追加日', duration: '長さ' };
const SORT_CYCLE = ['name', 'recent', 'duration'];
// Player-panel auto-hide: after this much idle time during playback the
// control panel fades fully out of view (see _updatePanelFade). The mesh
// stays visible=true at opacity 0, which keeps it raycastable so aiming
// where it was (then pressing) always brings it back.
const PANEL_IDLE_MS = 3000;
const PANEL_GHOST_OPACITY = 0;

// Seek bar on the player panel, in canvas pixel space (panel 1200×300).
const SEEK_SIDE = 40;   // track inset from the panel edges
const SEEK_CY = 112;    // track centre line (y)
const SEEK_HIT_Y = 96;  // invisible touch strip around the track
const SEEK_HIT_H = 36;

// Left-thumbstick control of the flat (2D) screen: up/down = viewing
// distance, left/right = size. Quest Browser exposes the left thumbstick
// on gamepad axes 2/3 (0/1 is the legacy touchpad pair, 4/5 the right
// stick). Rates are per frame at full tilt; deadzone keeps resting
// thumbs from drifting the screen.
const STICK_AXIS_X = 2;
const STICK_AXIS_Y = 3;
const STICK_DEADZONE = 0.25;
const SCREEN_DIST_MIN = 0.5;
const SCREEN_DIST_MAX = 4.0;
const SCREEN_SCALE_MIN = 0.2;
const SCREEN_SCALE_MAX = 2.2;

class VrApp {
  constructor() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controllers = [];

    this.mode = 'library';
    this.library = new LibraryModel();
    // Panel-fit paging: rows paint from y=150 at 72 px each, so 9 rows end
    // at y=788 — clear of the toast strip drawn at H-128 and the paging
    // buttons at H-96. (The model default of 12 overflowed the 960 px
    // canvas, which is why the "N 本のビデオを読み込みました" toast landed
    // on top of a video row.)
    this.library.pageSize = 9;
    this.libraryPanel = null;
    this.playerPanel = null;
    this.subtitlePanel = null; // world-anchored subtitle quad (Phase 3)
    this.screenMesh = null;
    this.vrScreen = null; // VRScreen wrapper (quad + optional sphere)
    this.libraryGroup = null;
    this.playerGroup = null;

    this.vrOverride = 'auto'; // OVERRIDE_CYCLE member (see vr-mode.js)
    this.vrMode = null; // resolved {projection, stereo, fovDeg, source}
    this._cues = []; // parsed subtitle cues for the open video
    this._cueSig = ''; // last rendered subtitle text (redraw gate)
    this._subtitleCache = new Map(); // subtitleUrl → cues

    this.player = new VideoPlayer({
      onServerMessage: (msg) => this._onSyncMessage(msg),
      onKicked: () => {
        this._closePlayback('他のデバイスがこのセッションを引き継ぎました');
      },
    });

    // Flat-screen aspect: the quad is fixed 16:9, so re-fit it from the
    // actual decoded frame size whenever a video's metadata arrives — a
    // non-16:9 source otherwise looked vertically squashed (stretched wide).
    // loadedmetadata fires before the first painted frame, so the quad is
    // already correct when the picture appears.
    this.player.video.addEventListener('loadedmetadata', () => {
      if (this.vrScreen && !this.slideshow) {
        this.vrScreen.setAspect(this.player.video.videoWidth, this.player.video.videoHeight);
      }
    });

    this.sync = { connected: false, script: null, devices: [] };
    this.slideshow = null; // { model, renderer, texture } while SS is on
    this._ssScriptCache = new Map(); // scriptUrl → actions[]
    this.toast = null; // { text, until }
    this._hover = null; // { controller, mesh, uv, distance }
    this._playerSig = ''; // player-panel refresh gate (see _playerSignature)
    this._scrubT = null;  // last scrub seek time (throttle; see _seekToUv)
    this._screenDist = 2.6;  // flat-screen placement (left thumbstick; see _updateScreenControls)
    this._screenScale = 1;
    this._panelActiveUntil = 0; // player-panel auto-hide deadline (see _updatePanelFade)
    this.session = null; // active XR session (the VR exit buttons call session.end())
    this._raycaster = new THREE.Raycaster();
    this._tmpMatrix = new THREE.Matrix4();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._frameError = null; // first frame-loop exception, surfaced on the visible panel
  }

  // -------------------------------------------------------------------------
  // Entry (DOM overlay → XR session)
  // -------------------------------------------------------------------------

  async start() {
    const overlay = document.getElementById('overlay');
    const status = document.getElementById('overlay-status');
    const button = document.getElementById('enter-vr');

    if (!navigator.xr) {
      status.textContent = 'このブラウザは WebXR に対応していません。Quest ブラウザなど VR ヘッドセットのブラウザから開いてください。';
      return;
    }
    let supported = false;
    try {
      supported = await navigator.xr.isSessionSupported('immersive-vr');
    } catch { /* unsupported browser */ }
    if (!supported) {
      status.textContent = 'immersive-vr セッションを利用できません。ヘッドセットを接続し、HTTPS（または adb reverse 経由の localhost）で開いているか確認してください。';
      return;
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = 'VR セッションを開始しています…';
      try {
        const session = await navigator.xr.requestSession('immersive-vr', {
          optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
        });
        await this._enterSession(session);
        overlay.classList.add('hidden');
      } catch (err) {
        status.textContent = `VR セッションを開始できません: ${err && err.message ? err.message : err}`;
        button.disabled = false;
      }
    });
    status.textContent = 'ヘッドセットの [VR を開始] を押して入場してください。';
  }

  async _enterSession(session) {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.xr.enabled = true;
      this.renderer.xr.setReferenceSpaceType('local-floor');
      document.body.appendChild(this.renderer.domElement);
      await this.renderer.xr.setSession(session);

      this.session = session;
      session.addEventListener('end', () => this._exitSession());

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0a0c14);
      this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
      this.scene.add(this.camera);

      // Soft floor grid for spatial grounding. Hidden whenever the
      // surround sphere is up: the grid lies INSIDE the 8 m sphere (its
      // plane crosses the room around the viewer), so it would otherwise
      // blend over the video's lower half — the "the footage looks
      // see-through, I can see the grid" artifact.
      this.grid = new THREE.GridHelper(12, 24, 0x2a3050, 0x171c2c);
      this.grid.material.transparent = true;
      this.grid.material.opacity = 0.5;
      this.scene.add(this.grid);

      this._buildLibraryPanel();
      this._buildPlayerRig();
      this._buildSubtitlePanel();
      this._buildControllers();

      this.mode = 'library';
      this._frameError = null;
      this.toast = { text: 'コントローラーをパネルに向けてトリガーで選択します', until: Date.now() + 6000 };
      this._refreshLibrary(true);

      this.renderer.setAnimationLoop(() => this._frame());
    } catch (err) {
      // Never strand the user inside a half-built XR scene: end the session
      // and surface the failure on the DOM overlay instead.
      try { await session.end(); } catch { /* ignore */ }
      throw err;
    }
  }

  _exitSession() {
    this.session = null;
    this.renderer.setAnimationLoop(null);
    this._disableSlideshow();
    if (this.vrScreen) {
      this.vrScreen.dispose();
      this.vrScreen = null;
    }
    this.vrMode = null;
    this._cues = [];
    this.player.close();
    this.mode = 'library';
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
    this.renderer = null;
    const overlay = document.getElementById('overlay');
    overlay.classList.remove('hidden');
    const button = document.getElementById('enter-vr');
    button.disabled = false;
    document.getElementById('overlay-status').textContent = 'VR セッションを終了しました。';
  }

  /**
   * Headset-side "exit VR" (see the VR終了 button on the library panel):
   * end the XR session. The session's 'end' listener then runs _exitSession,
   * which tears the scene down and restores the DOM overlay with [VR を開始],
   * so the user can re-enter from the browser page. Safe to call from a panel
   * click inside the frame loop — the session tears down asynchronously,
   * after this frame finishes.
   */
  _endVrSession() {
    const session = this.session;
    if (!session) return;
    try {
      const p = session.end();
      if (p && p.catch) p.catch(() => { /* already ending */ });
    } catch { /* already ending */ }
  }

  // -------------------------------------------------------------------------
  // World construction
  // -------------------------------------------------------------------------

  _buildLibraryPanel() {
    this.libraryGroup = new THREE.Group();
    this.libraryPanel = new UIPanel({ worldWidth: 1.7, pixelWidth: 1280, pixelHeight: 960 });
    this.libraryPanel.mesh.position.set(0, 1.5, -1.9);
    this.libraryPanel.setDraw(() => this._drawLibrary());
    this.libraryGroup.add(this.libraryPanel.mesh);
    this.scene.add(this.libraryGroup);
  }

  _buildPlayerRig() {
    this.playerGroup = new THREE.Group();

    // Flat screen quad fed by the VideoTexture (VRScreen swaps in a
    // world-anchored surround sphere for equirect/fisheye modes — see
    // vr-screen.js; the sphere rides on this world-fixed group).
    this.vrScreen = new VRScreen(this.player.texture, this.playerGroup);
    this.screenMesh = this.vrScreen.quad;
    this.playerGroup.add(this.screenMesh);

    this.playerPanel = new UIPanel({ worldWidth: 2.2, pixelWidth: 1200, pixelHeight: 300 });
    // The screen quad is always 1.8 m tall (the aspect fit only narrows it),
    // centered at y 1.65 → its bottom edge is y 0.75. The panel is 0.55 m
    // tall, so centering it at 0.45 tops out at 0.725 — a clear gap below
    // the picture instead of overlapping it.
    this.playerPanel.mesh.position.set(0, 0.45, -2.6); // default screen plane (dist 2.6; see _updateScreenControls)
    this.playerPanel.mesh.rotation.x = 0; // upright, parallel to the screen — no tilt
    // Opacity-0 ghost panels must not write depth, or the transparent quad
    // would punch a see-through hole in the screen/sphere behind it.
    this.playerPanel.mesh.material.depthWrite = false;
    this.playerPanel.setDraw(() => this._drawPlayerControls());
    this.playerGroup.add(this.playerPanel.mesh);

    this.playerGroup.visible = false;
    this.scene.add(this.playerGroup);
  }

  _buildSubtitlePanel() {
    // Captions hang just below the player panel in playerGroup, so they are
    // world-anchored like the video: turning your head lets them drift out
    // of view instead of hovering in front of the face.
    this.subtitlePanel = new UIPanel({ worldWidth: 1.6, pixelWidth: 1280, pixelHeight: 192 });
    // z sits just BEHIND the control panel (default screen plane −2.6):
    // while the panel is fully shown it occludes the subtitle instead of
    // the subtitle floating over the buttons; once the panel fades to
    // opacity 0 (depthWrite off) the subtitle shows through again.
    this.subtitlePanel.mesh.position.set(0, 0.3, -2.7);
    this.subtitlePanel.mesh.rotation.x = 0.3; // tilt up toward the eye line
    this.subtitlePanel.setDraw(() => this._drawSubtitle());
    this.subtitlePanel.mesh.visible = false;
    this.playerGroup.add(this.subtitlePanel.mesh);
  }

  _buildControllers() {
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      const rayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ]);
      const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0x86a8ff }));
      ray.scale.z = 4;
      controller.add(ray);
      controller.userData.ray = ray;
      // Gaze input is a fallback ONLY while no tracked-pointer device is
      // providing rays. While a controller is connected the head must not
      // steer the selection (field report: nodding in the library slid the
      // highlighted video row up/down).
      controller.userData.connected = false;
      controller.userData.selecting = false;
      controller.userData.inputSource = null; // XRInputSource: gamepad axes for the thumbstick
      controller.addEventListener('connected', (e) => {
        controller.userData.connected = !!(e.data && e.data.targetRayMode === 'tracked-pointer');
        controller.userData.selecting = false;
        controller.userData.inputSource = e.data || null;
      });
      controller.addEventListener('disconnected', () => {
        controller.userData.connected = false;
        controller.userData.selecting = false;
        controller.userData.inputSource = null;
      });
      // Trigger hold state drives seek-bar scrubbing (see _updateHover);
      // selectstart still fires the normal press action.
      controller.addEventListener('selectstart', () => {
        controller.userData.selecting = true;
        this._select(controller);
      });
      controller.addEventListener('selectend', () => {
        controller.userData.selecting = false;
        this._scrubT = null;
      });
      this.scene.add(controller);

      const grip = this.renderer.xr.getControllerGrip(i);
      const gripMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.014, 0.02, 0.1, 16),
        new THREE.MeshBasicMaterial({ color: 0x20242f }),
      );
      gripMesh.rotation.x = -Math.PI / 4;
      grip.add(gripMesh);
      this.scene.add(grip);

      this.controllers.push(controller);
    }
  }

  // -------------------------------------------------------------------------
  // Frame loop: hover raycast + player panel status refresh
  // -------------------------------------------------------------------------

  _frame() {
    try {
      this._updateHover();
      if (this.slideshow) this._slideshowTick();
      this._updateSubtitle();
      if (this.vrScreen) this.vrScreen.recenter(this.renderer);
      this._updateScreenControls();
      if (this.toast && Date.now() > this.toast.until) {
        this.toast = null;
        this._redrawActivePanel();
      }
      if (this.mode === 'player') {
        if (this.player.policyMuted) {
          // play() had to fall back to muted (autoplay policy): tell the
          // user where the unmute button is while the panel is still up.
          this.player.policyMuted = false;
          this.toast = { text: '音声を開始できなかったためミュートにしました。パネルの 🔇 で解除できます', until: Date.now() + 5000 };
          this._redrawActivePanel();
        }
        // The player panel carries everything the retired head-attached OSD
        // did (title, time, sync status, projection, toasts): refresh it
        // whenever anything it shows changes.
        const sig = this._playerSignature();
        if (sig !== this._playerSig) {
          this._playerSig = sig;
          this.playerPanel.redraw();
        }
        this._updatePanelFade();
      }
    } catch (err) {
      // An exception inside the XR loop otherwise freezes the headset view
      // with zero diagnostics (the last submitted frame just persists).
      // Keep the loop alive and surface the first failure on the visible panel.
      if (!this._frameError) {
        this._frameError = `内部エラー: ${err && err.message ? err.message : err}`;
        console.error('[FunSync VR] frame error', err);
        this._redrawActivePanel();
      }
    }
    try {
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      if (!this._frameError) {
        this._frameError = `描画エラー: ${err && err.message ? err.message : err}`;
        console.error('[FunSync VR] render error', err);
        this._redrawActivePanel();
      }
    }
  }

  /**
   * Auto-hide for the player control panel: while a video is playing and
   * nothing is looking at / touching the panel, it fades fully out of
   * sight (opacity 0) so it never floats in front of the picture. A
   * controller ray (or gaze when no controller is connected) RESTING ON
   * the panel keeps it fully open for as long as it stays there — the
   * fade countdown only restarts once the ray leaves — and pressing the
   * trigger over it (see _select) also resets the countdown. Pausing, an
   * error, or a toast keep it showing. The ghosted panel stays raycastable,
   * so pointing where it was (then pressing) always brings it back.
   */
  _updatePanelFade() {
    const panel = this.playerPanel;
    if (!panel) return;
    const now = Date.now();
    const pointed =
      (this._hover && this._hover.mesh === panel.mesh) || panel.hoverId !== null;
    const mustShow =
      pointed ||
      this.player.paused ||
      this.player.lastError ||
      this._frameError ||
      (this.toast && now <= this.toast.until);
    if (mustShow) this._panelActiveUntil = now + PANEL_IDLE_MS;
    const target = now <= this._panelActiveUntil ? 1 : PANEL_GHOST_OPACITY;
    const mat = panel.mesh.material; // transparent: true from UIPanel
    mat.opacity += (target - mat.opacity) * 0.18;
    if (Math.abs(target - mat.opacity) < 0.01) mat.opacity = target;
  }

  _rayFrom(controller) {
    this._tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this._origin.setFromMatrixPosition(controller.matrixWorld);
    this._dir.set(0, 0, -1).applyMatrix4(this._tmpMatrix);
    this._raycaster.ray.origin.copy(this._origin);
    this._raycaster.ray.direction.copy(this._dir);
  }

  /** True while at least one tracked-pointer input source is connected. */
  _hasTrackedController() {
    return this.controllers.some((c) => c.userData.connected);
  }

  /**
   * Left thumbstick drives the flat (2D) screen: stick up/down pushes it
   * farther / pulls it closer, left/right grows / shrinks it. The control
   * panel rides along IN the screen's plane (its top edge clears the
   * screen's pinned bottom edge, so the two never overlap) and the
   * subtitle sits just behind it; the screen's bottom edge stays pinned
   * above the panel at any size (see VRScreen). Ignored in the library
   * and in surround-sphere modes (there is no quad there).
   */
  _updateScreenControls() {
    if (this.mode !== 'player' || !this.vrScreen || this.vrScreen.sphere) return;
    let x = 0;
    let y = 0;
    for (const controller of this.controllers) {
      const src = controller.userData.inputSource;
      if (!src || src.handedness !== 'left') continue;
      const gp = src.gamepad;
      if (!gp || !gp.axes || gp.axes.length <= STICK_AXIS_Y) continue;
      const ax = gp.axes[STICK_AXIS_X] || 0;
      const ay = gp.axes[STICK_AXIS_Y] || 0;
      if (Math.abs(ax) >= STICK_DEADZONE) x = ax;
      if (Math.abs(ay) >= STICK_DEADZONE) y = ay; // gamepad Y: stick up = negative
      break;
    }
    if (!x && !y) return;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // Stick up (y negative) pushes the screen away, like physically
    // shoving it; right grows it. Tilt depth scales the rate.
    const dist = clamp(this._screenDist - y * 0.04, SCREEN_DIST_MIN, SCREEN_DIST_MAX);
    const scale = clamp(this._screenScale + x * 0.015, SCREEN_SCALE_MIN, SCREEN_SCALE_MAX);
    if (dist === this._screenDist && scale === this._screenScale) return;
    this._screenDist = dist;
    this._screenScale = scale;
    this.vrScreen.setPlacement(dist, scale);
    // Panel sits in the screen's own plane (no overlap: panel top edge
    // y 0.725 stays below the screen's pinned bottom edge y 0.75); the
    // subtitle hides just behind it so the panel still occludes captions.
    this.playerPanel.mesh.position.z = -dist;
    this.subtitlePanel.mesh.position.z = -dist - 0.1;
  }

  _targets() {
    if (this.mode === 'library') return [this.libraryPanel.mesh];
    const targets = [this.playerPanel.mesh, this.screenMesh];
    if (this.vrScreen && this.vrScreen.sphere) targets.push(this.vrScreen.sphere);
    return targets;
  }

  _updateHover() {
    let best = null;
    for (const controller of this.controllers) {
      this._rayFrom(controller);
      const hits = this._raycaster.intersectObjects(this._targets(), false);
      const hit = hits.length ? hits[0] : null;
      // Clamp the visible ray: a surround sphere sits 8 m out, which would
      // otherwise stretch the pointer line across the room.
      controller.userData.ray.scale.z = hit ? Math.min(hit.distance, 4) : 4;
      if (hit && (!best || hit.distance < best.distance)) {
        best = { controller, mesh: hit.object, uv: hit.uv, distance: hit.distance };
      }
    }

    // Gaze fallback: only when NO tracked controller is providing rays at
    // all (a real-device failure mode we cannot reproduce locally). With a
    // connected controller the head must never steer the hover — that made
    // the library selection slide with the user's neck.
    if (!best && !this._hasTrackedController() && this.camera) {
      this.camera.getWorldPosition(this._origin);
      this.camera.getWorldDirection(this._dir);
      this._raycaster.ray.origin.copy(this._origin);
      this._raycaster.ray.direction.copy(this._dir);
      const hits = this._raycaster.intersectObjects(this._targets(), false);
      if (hits.length) {
        best = { controller: null, mesh: hits[0].object, uv: hits[0].uv, distance: hits[0].distance };
      }
    }
    this._hover = best;

    // Exactly one panel may show a hovered region at a time.
    const panels = [this.libraryPanel, this.playerPanel];
    for (const panel of panels) {
      if (best && best.mesh === panel.mesh && best.uv) panel.handleHover(best.uv);
      else panel.clearHover();
    }

    // Scrub while dragging: with the trigger held and the ray kept on the
    // seek bar, keep moving the playhead (tap-to-jump goes through
    // activate/select instead).
    if (best && best.controller && best.controller.userData.selecting
        && best.mesh === this.playerPanel.mesh && best.uv
        && this.playerPanel.hoverId === 'seek'
        && this.playerPanel.mesh.material.opacity >= 0.5) {
      this._seekToUv(best.uv, true);
    }
  }

  _select(controller) {
    this._rayFrom(controller);
    let hits = this._raycaster.intersectObjects(this._targets(), false);
    if (!hits.length && this.camera && !this._hasTrackedController()) {
      // Same gaze fallback as hover: only when no tracked controller exists.
      this.camera.getWorldPosition(this._origin);
      this.camera.getWorldDirection(this._dir);
      this._raycaster.ray.origin.copy(this._origin);
      this._raycaster.ray.direction.copy(this._dir);
      hits = this._raycaster.intersectObjects(this._targets(), false);
    }
    if (!hits.length) return;
    const hit = hits[0];
    const panel = hit.object.userData.uiPanel;
    if (panel) {
      // Any press on the panel re-arms the auto-hide timer. While the
      // player panel is ghosted the press ONLY brings it back — firing an
      // invisible button would be the worst failure mode of this feature.
      this._panelActiveUntil = Date.now() + PANEL_IDLE_MS;
      if (panel.mesh.material.opacity < 0.5) return;
      panel.activate(hit.uv);
    } else if (hit.object === this.screenMesh || (this.vrScreen && hit.object === this.vrScreen.sphere)) {
      this.player.toggle();
      this.playerPanel.redraw();
    }
  }

  // -------------------------------------------------------------------------
  // Library mode
  // -------------------------------------------------------------------------

  async _refreshLibrary(initial = false) {
    try {
      const videos = await fetchVideos();
      this.library.setVideos(videos);
      if (initial && videos.length) {
        this.toast = { text: `${videos.length} 本のビデオを読み込みました`, until: Date.now() + 3000 };
      }
    } catch {
      this.toast = { text: 'ライブラリを読み込めませんでした（接続を確認してください）', until: Date.now() + 5000 };
    }
    this._redrawLibrary();
  }

  _redrawLibrary() {
    this.libraryPanel.redraw();
  }

  _openVideo(video) {
    this._disableSlideshow();
    this.mode = 'player';
    this.libraryGroup.visible = false;
    this.playerGroup.visible = true;
    // Fresh session per video: connection status belongs to the new socket.
    this.sync = { connected: false, script: null, devices: [] };

    // Projection mode: reset the manual override, then trust the backend's
    // filename-derived vrFormat (see vr_api / vr-mode.js).
    this.vrOverride = 'auto';
    this.vrMode = resolveVRMode(video, this.vrOverride);
    this.vrScreen.applyMode(this.renderer, this.vrMode);
    this._updateGridVisibility();
    if (this.vrMode.projection !== 'flat') {
      this.toast = { text: `VR 投影: ${modeLabel(this.vrMode)}`, until: Date.now() + 3000 };
    }

    // Subtitles (world-anchored caption panel).
    this._cues = [];
    this._cueSig = '';
    this.subtitlePanel.mesh.visible = false;
    this._loadSubtitles(video);

    this.player.open(video);
    // Fresh video: the panel starts fully visible, then auto-hides while
    // playing (see _updatePanelFade).
    this.playerPanel.mesh.material.opacity = 1;
    this._panelActiveUntil = Date.now() + PANEL_IDLE_MS;
    this.playerPanel.redraw();
  }

  /** Cycle the manual projection override (auto → flat → eq-sbs → ...). */
  _cycleProjectionOverride() {
    this.vrOverride = nextOverride(this.vrOverride);
    const video = this.player.info;
    if (!video) return;
    // A surround sphere and a flat slideshow can't share the screen: if the
    // new mode is not flat, stop the slideshow first (restores video frame).
    if (this.slideshow) this._disableSlideshow();
    this.vrMode = resolveVRMode(video, this.vrOverride);
    this.vrScreen.applyMode(this.renderer, this.vrMode);
    this._updateGridVisibility();
    this.toast = { text: `投影: ${modeLabel(this.vrMode)}`, until: Date.now() + 3500 };
    this.playerPanel.redraw();
  }

  /**
   * The floor grid only grounds the empty room — a surround sphere already
   * encloses the viewer, and the grid plane would slice through its
   * interior and show over the video.
   */
  _updateGridVisibility() {
    if (this.grid) this.grid.visible = !(this.vrScreen && this.vrScreen.sphere);
  }

  async _loadSubtitles(video) {
    if (!video || !video.hasSubtitle || !video.subtitleUrl) return;
    const videoId = video.id;
    try {
      let cues = this._subtitleCache.get(video.subtitleUrl);
      if (!cues) {
        const res = await fetch(video.subtitleUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error(`subtitle ${res.status}`);
        const text = await res.text();
        cues = parseSubtitles(text);
        this._subtitleCache.set(video.subtitleUrl, cues);
      }
      // Ignore a slow response that arrived after the user moved on.
      if (this.player.info && this.player.info.id === videoId) {
        this._cues = cues;
      }
    } catch {
      // No captions is survivable; playback continues silently.
    }
  }

  _closePlayback(toastText) {
    this._disableSlideshow();
    // Tear the surround sphere down so nothing hangs around in library mode.
    if (this.vrScreen) this.vrScreen.applyMode(this.renderer, { projection: 'flat', stereo: 'mono', fovDeg: 0 });
    this._updateGridVisibility();
    this.vrMode = null;
    this._cues = [];
    this._cueSig = '';
    this.subtitlePanel.mesh.visible = false;
    this.player.close();
    this.mode = 'library';
    this.sync = { connected: false, script: null, devices: [] };
    this.playerGroup.visible = false;
    this.libraryGroup.visible = true;
    if (toastText) this.toast = { text: toastText, until: Date.now() + 5000 };
    this._redrawLibrary();
  }

  _drawLibrary() {
    const { ctx } = this.libraryPanel;
    const W = this.libraryPanel.pixelWidth;
    const H = this.libraryPanel.pixelHeight;
    // Fully opaque fill: the default 94% alpha let the floor grid ghost
    // through the panel on-device (reported on Quest).
    drawPanelBackground(ctx, W, H, { fill: '#0e101a' });

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8ecf8';
    ctx.font = `600 44px ${FONT}`;
    ctx.fillText('FunSync VR — ライブラリ', 40, 64);

    const view = this.library.view();
    ctx.font = `26px ${FONT}`;
    ctx.fillStyle = '#8b93ad';
    ctx.fillText(`${view.total} 本 • ${view.page + 1}/${view.pages} ページ`, 40, 116);

    // Header buttons: refresh + sort cycle.
    const regions = [];
    const sortLabel = `ソート: ${SORT_LABELS[this.library.sort]}`;
    ctx.font = `28px ${FONT}`;
    const sortW = Math.max(220, ctx.measureText(sortLabel).width + 40);
    regions.push({ x: W - 40 - 140 - 16 - sortW, y: 40, w: sortW, h: 64, id: 'sort', label: sortLabel,
      onClick: () => {
        const i = SORT_CYCLE.indexOf(this.library.sort);
        this.library.setSort(SORT_CYCLE[(i + 1) % SORT_CYCLE.length]);
        this._redrawLibrary();
      } });
    regions.push({ x: W - 40 - 140, y: 40, w: 140, h: 64, id: 'refresh', label: '更新',
      onClick: () => this._refreshLibrary() });

    // Rows.
    const rowH = 72;
    const startY = 150;
    view.rows.forEach((video, i) => {
      const y = startY + i * rowH;
      const region = { x: 32, y, w: W - 64, h: rowH - 10, id: `video:${video.id}`, label: '',
        onClick: () => this._openVideo(video) };
      regions.push(region);

      const hovered = this.libraryPanel.hoverId === region.id;
      if (hovered) {
        roundRect(ctx, region.x, region.y, region.w, region.h, 10);
        ctx.fillStyle = '#232a44';
        ctx.fill();
      }
      ctx.fillStyle = hovered ? '#ffffff' : '#c9d2e8';
      ctx.font = `30px ${FONT}`;
      ctx.textAlign = 'left';
      let nameX = 56;
      const badges = [];
      if (video.hasFunscript) badges.push('F');
      if (video.hasSubtitle) badges.push('S');
      if (video.manualVRType === 'vr') badges.push('VR');
      if (badges.length) {
        const tag = `[${badges.join('')}]`;
        ctx.fillStyle = '#7ea2ff';
        ctx.fillText(tag, nameX, y + region.h / 2);
        nameX += ctx.measureText(tag).width + 14;
      }
      ctx.fillStyle = hovered ? '#ffffff' : '#c9d2e8';
      ctx.fillText(ellipsize(ctx, String(video.name || ''), W - nameX - 220), nameX, y + region.h / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#8b93ad';
      ctx.font = `26px ${FONT}`;
      ctx.fillText(formatTime(video.duration), W - 56, y + region.h / 2);
      ctx.textAlign = 'left';
    });

    if (!view.rows.length) {
      ctx.fillStyle = '#8b93ad';
      ctx.font = `30px ${FONT}`;
      ctx.fillText('ビデオが見つかりません。デスクトップでライブラリをスキャンしてください。', 56, startY + 40);
    }

    // Status line: toasts and frame errors surface here in library mode
    // (the head-attached OSD is gone; every message rides on the open panel).
    const message = this._frameError || (this.toast ? this.toast.text : '');
    if (message) {
      ctx.textAlign = 'center';
      ctx.fillStyle = this._frameError ? '#ff5d5d' : '#ffd76a';
      ctx.font = `600 28px ${FONT}`;
      ctx.fillText(ellipsize(ctx, message, W - 420), W / 2, H - 128);
      ctx.textAlign = 'left';
    }

    // Paging buttons last so they paint over rows and win overlapping hits.
    regions.push({ x: 32, y: H - 96, w: 140, h: 64, id: 'prev', label: '◀ 前',
      disabled: view.page === 0,
      onClick: () => { this.library.prevPage(); this._redrawLibrary(); } });
    regions.push({ x: W - 172, y: H - 96, w: 140, h: 64, id: 'next', label: '次 ▶',
      disabled: view.page + 1 >= view.pages,
      onClick: () => { this.library.nextPage(); this._redrawLibrary(); } });
    // Exit VR bottom-center: always visible in library mode.
    regions.push({ x: W / 2 - 80, y: H - 96, w: 160, h: 64, id: 'vr', label: 'VR終了',
      onClick: () => this._endVrSession() });

    for (const r of regions) {
      if (r.id.startsWith('video:')) continue; // rows have their own painting
      if (r.id === 'vr') {
        drawButton(ctx, r, this.libraryPanel, { fontSize: 28, base: '#5a2438', hover: '#8a3a52', text: '#ffdfe3' });
        continue;
      }
      drawButton(ctx, r, this.libraryPanel, { fontSize: 28 });
    }
    this.libraryPanel.setRegions(regions);
  }

  // -------------------------------------------------------------------------
  // Player mode
  // -------------------------------------------------------------------------

  _drawPlayerControls() {
    const { ctx } = this.playerPanel;
    const W = this.playerPanel.pixelWidth;
    const H = this.playerPanel.pixelHeight;
    // Fully opaque fill: the default 94% alpha let the floor grid ghost
    // through the panel on-device (reported on Quest).
    drawPanelBackground(ctx, W, H, { fill: '#0e101a' });

    ctx.textBaseline = 'middle';

    // Info strip: everything the retired head-attached OSD used to show.
    const v = this.player.info;

    // Sync-status chip first (right-aligned): measuring it lets the title
    // fit into whatever width is left, so long file names no longer run
    // underneath the status text.
    const st = this._syncStatus();
    let stText = st.text;
    if (this.sync.script) stText = `${stText} • ${this.sync.script}`;
    ctx.font = `24px ${FONT}`;
    const stShown = ellipsize(ctx, stText, 480);
    ctx.textAlign = 'right';
    ctx.fillStyle = st.color;
    ctx.fillText(stShown, W - 40, 46);
    const stW = ctx.measureText(stShown).width;

    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8ecf8';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText(ellipsize(ctx, v ? String(v.name || '') : 'FunSync VR', W - 140 - stW), 40, 46);

    ctx.font = `24px ${FONT}`;
    ctx.fillStyle = '#c9d2e8';
    const timeText = `${formatTime(this.player.currentTime)} / ${formatTime(this.player.duration)}`;
    ctx.fillText(timeText, 40, 84);
    let metaX = 40 + ctx.measureText(timeText).width + 24;
    if (this.vrMode && this.vrMode.projection !== 'flat') {
      ctx.fillStyle = '#7ea2ff';
      const proj = modeLabel(this.vrMode);
      ctx.fillText(proj, metaX, 84);
      metaX += ctx.measureText(proj).width + 24;
    }
    if (this.slideshow) {
      ctx.fillStyle = '#7ea2ff';
      ctx.fillText('📷 スライドショー', metaX, 84);
    }

    // Seek bar: tap to jump, or hold the trigger and slide the ray to scrub.
    const trackX = SEEK_SIDE;
    const trackW = W - SEEK_SIDE * 2;
    const seekEnabled = !this.slideshow && this.player.duration > 0;
    const frac = seekEnabled ? Math.max(0, Math.min(1, this.player.currentTime / this.player.duration)) : 0;
    const seekHovered = this.playerPanel.hoverId === 'seek';
    roundRect(ctx, trackX, SEEK_CY - 5, trackW, 10, 5);
    ctx.fillStyle = seekEnabled ? (seekHovered ? '#4a5578' : '#39415f') : '#232838';
    ctx.fill();
    if (frac > 0) {
      roundRect(ctx, trackX, SEEK_CY - 5, Math.max(10, trackW * frac), 10, 5);
      ctx.fillStyle = '#7ea2ff';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(trackX + trackW * frac, SEEK_CY, seekHovered ? 13 : 11, 0, Math.PI * 2);
    ctx.fillStyle = seekEnabled ? '#e8ecf8' : '#5a6070';
    ctx.fill();

    const playing = !this.player.paused;
    const bw = 152;
    const bh = 96;
    const gap = 10;
    const total = bw * 7 + gap * 6;
    const x0 = (W - total) / 2;
    const y0 = 152;

    const mk = (i, id, label, onClick, disabled) => ({ x: x0 + i * (bw + gap), y: y0, w: bw, h: bh, id, label, onClick, disabled });
    const buttons = [
      mk(0, 'back', '◀ ライブラリ', () => this._closePlayback()),
      mk(1, 'rew', '-10 秒', () => { this.player.seekBy(-10); this.playerPanel.redraw(); }),
      mk(2, 'playpause', playing ? '⏸ 一時停止' : '▶ 再生', () => { this.player.toggle(); this.playerPanel.redraw(); }),
      mk(3, 'fwd', '+10 秒', () => { this.player.seekBy(10); this.playerPanel.redraw(); }),
      mk(4, 'mute', this.player.muted ? '🔇 ミュート' : '🔊 音声', () => { this.player.toggleMute(); this.playerPanel.redraw(); }),
      mk(5, 'slideshow', this.slideshow ? 'SS 停止' : 'SS 開始',
        () => this._toggleSlideshow(),
        !this._canSlideshow()),
      mk(6, 'projection', overrideButtonLabel(this.vrOverride),
        () => this._cycleProjectionOverride()),
    ];

    for (const r of buttons) drawButton(ctx, r, this.playerPanel, { fontSize: 30 });
    // Seek strip first so a stray overlap can never steal a button press
    // (hitRegion lets later regions win).
    this.playerPanel.setRegions([
      {
        x: trackX, y: SEEK_HIT_Y, w: trackW, h: SEEK_HIT_H, id: 'seek', label: '',
        disabled: !seekEnabled,
        onClick: (region, uv) => this._seekToUv(uv),
      },
      ...buttons,
    ]);

    // Error / toast strip along the bottom edge, only when there is something
    // to say (frame errors outrank player errors, which outrank toasts).
    const errText = this._frameError || this.player.lastError;
    const message = errText || (this.toast ? this.toast.text : '');
    if (message) {
      ctx.textAlign = 'center';
      ctx.fillStyle = errText ? '#ff5d5d' : '#ffd76a';
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText(ellipsize(ctx, message, W - 120), W / 2, H - 24);
      ctx.textAlign = 'left';
    }
  }

  /**
   * Jump the playhead to the seek-bar position under `uv`. With scrub=true
   * (trigger held while dragging) seeks are throttled to ~0.25 s steps so a
   * fast drag does not spam the decoder / sync clock.
   */
  _seekToUv(uv, scrub = false) {
    const dur = this.player.duration;
    if (!dur || this.slideshow) return;
    const trackW = this.playerPanel.pixelWidth - SEEK_SIDE * 2;
    const frac = Math.max(0, Math.min(1, (uv.x * this.playerPanel.pixelWidth - SEEK_SIDE) / trackW));
    if (scrub) {
      const t = frac * dur;
      if (this._scrubT !== null && Math.abs(t - this._scrubT) < 0.25) return;
      this._scrubT = t;
    } else {
      this._scrubT = null;
    }
    this.player.seekTo(frac);
    this.playerPanel.redraw();
  }

  // -------------------------------------------------------------------------
  // Slideshow (flat videos, Phase 2)
  // -------------------------------------------------------------------------

  /**
   * SS needs a funscript (switch points) and is a flat-video feature only:
   * VR-tagged videos are excluded, and a surround sphere must never fight
   * the slideshow for the screen.
   */
  _canSlideshow() {
    const v = this.player.info;
    if (!v || !v.hasFunscript || v.manualVRType === 'vr') return false;
    return !this.vrMode || this.vrMode.projection === 'flat';
  }

  async _toggleSlideshow() {
    if (this.slideshow) {
      this._disableSlideshow();
      this.playerPanel.redraw();
      return;
    }
    await this._enableSlideshow();
  }

  async _enableSlideshow() {
    const v = this.player.info;
    if (!v) return;
    try {
      const cfgRes = await fetch('/api/remote/slideshow/config', { cache: 'no-store' });
      if (!cfgRes.ok) throw new Error(`config ${cfgRes.status}`);
      const cfg = await cfgRes.json();
      if (!cfg.configured) {
        this.toast = { text: 'スライドショーフォルダが未設定です。デスクトップで設定してください。', until: Date.now() + 5000 };
        this.playerPanel.redraw();
        return;
      }
      if (!cfg.folderExists) {
        this.toast = { text: 'スライドショーフォルダが見つかりません。', until: Date.now() + 5000 };
        this.playerPanel.redraw();
        return;
      }
      const imgRes = await fetch('/api/remote/slideshow/images', { cache: 'no-store' });
      if (!imgRes.ok) throw new Error(`images ${imgRes.status}`);
      const listing = await imgRes.json();
      if (!Array.isArray(listing.images) || !listing.images.length) {
        this.toast = { text: 'スライドショーフォルダに画像がありません。', until: Date.now() + 5000 };
        this.playerPanel.redraw();
        return;
      }
      const actions = await this._fetchActions(v.scriptUrl);
      if (!actions.length) {
        this.toast = { text: 'FunScript にアクションがありません。', until: Date.now() + 5000 };
        this.playerPanel.redraw();
        return;
      }

      const model = new SlideshowModel({
        canvasW: 1280,
        canvasH: 720,
        corner: cfg.corner,
        sizeDenom: cfg.sizeDenom,
        imageOrder: cfg.imageOrder,
        transition: cfg.transition,
        background: cfg.background,
        preset: cfg.preset,
        presets: cfg.presets,
        imageUrls: listing.images.map((im) => im.url),
        actions,
      });
      if (!model.switchTimes.length) {
        this.toast = { text: 'FunScript から切替ポイントを作成できませんでした。', until: Date.now() + 5000 };
        this.playerPanel.redraw();
        return;
      }

      const renderer = new SlideshowRenderer({ width: 1280, height: 720 });
      const texture = new THREE.CanvasTexture(renderer.canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      this.slideshow = { model, renderer, texture };

      // Prime the visible photo plus the next one before swapping screens.
      const first = model.frame(this.player.currentTime);
      renderer.loadImage(model.images, first.photoIndex);
      renderer.loadImage(model.images, first.toIndex >= 0 ? first.toIndex : first.photoIndex);

      this.screenMesh.material.map = texture;
      this.screenMesh.material.needsUpdate = true;
      // The video quad may have been shrunk to the video's aspect; the
      // slideshow composites 16:9, so restore the full-size quad.
      this.vrScreen.setAspect(renderer.canvas.width, renderer.canvas.height);
      this.playerPanel.redraw();
      this.toast = { text: `スライドショー開始（${model.switchTimes.length} 切替・${model.images.length} 枚）`, until: Date.now() + 3500 };
    } catch {
      this.toast = { text: 'スライドショーを開始できませんでした。', until: Date.now() + 5000 };
      this.playerPanel.redraw();
    }
  }

  _disableSlideshow() {
    if (!this.slideshow) return;
    this.slideshow.texture.dispose();
    this.slideshow = null;
    if (this.screenMesh) {
      this.screenMesh.material.map = this.player.texture;
      this.screenMesh.material.needsUpdate = true;
      // Back to the video frame: restore the video's own aspect fit.
      if (this.vrScreen) {
        this.vrScreen.setAspect(this.player.video.videoWidth, this.player.video.videoHeight);
      }
    }
  }

  /** Funscript actions for a script URL (cached across videos). */
  async _fetchActions(scriptUrl) {
    if (!scriptUrl) return [];
    const cached = this._ssScriptCache.get(scriptUrl);
    if (cached) return cached;
    const res = await fetch(scriptUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`script ${res.status}`);
    const data = await res.json();
    const actions = Array.isArray(data.actions) ? data.actions : [];
    this._ssScriptCache.set(scriptUrl, actions);
    return actions;
  }

  /** Re-composite the slideshow canvas from the current video time. */
  _slideshowTick() {
    const { model, renderer, texture } = this.slideshow;
    const video = this.player.video;
    const state = model.frame(this.player.currentTime, video.videoWidth, video.videoHeight);
    renderer.render(state, model, video);
    texture.needsUpdate = true;
    // Keep the next switch's photo warm.
    if (state.toIndex >= 0) renderer.loadImage(model.images, state.toIndex);
    const nextSwitch = model.switchTimes.find((s) => s > this.player.currentTime);
    if (nextSwitch !== undefined && nextSwitch - this.player.currentTime < 2) {
      const upcoming = model.frame(Math.min(nextSwitch + 0.01, model.switchTimes[model.switchTimes.length - 1] + 1));
      renderer.loadImage(model.images, upcoming.toIndex >= 0 ? upcoming.toIndex : upcoming.photoIndex);
    }
  }

  // -------------------------------------------------------------------------
  // Subtitles (world-anchored captions)
  // -------------------------------------------------------------------------

  /** Cheap per-frame caption sync: only redraw when the active cue changes. */
  _updateSubtitle() {
    const panel = this.subtitlePanel;
    if (!panel) return;
    const cue = this.mode === 'player' && this._cues.length
      ? activeCue(this._cues, this.player.currentTime)
      : null;
    const text = cue ? cue.text : '';
    if (text === this._cueSig) return;
    this._cueSig = text;
    panel.mesh.visible = !!text;
    if (text) panel.redraw();
  }

  _drawSubtitle() {
    const { ctx } = this.subtitlePanel;
    const W = this.subtitlePanel.pixelWidth;
    const H = this.subtitlePanel.pixelHeight;
    ctx.clearRect(0, 0, W, H);
    if (!this._cueSig) return;

    // Burned-in-caption look: black outline, white text, wrapped to 2 lines.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const size = 56;
    ctx.font = `600 ${size}px ${FONT}`;
    const maxW = W - 80;
    let line = this._cueSig;
    let lines = [line];
    if (ctx.measureText(line).width > maxW) {
      const mid = Math.floor(line.length / 2);
      let cut = mid;
      for (let i = mid; i > 0; i--) if (line[i] === ' ') { cut = i; break; }
      for (let i = mid; i < line.length; i++) if (line[i] === ' ') { cut = i; break; }
      lines = [line.slice(0, cut).trim(), line.slice(cut).trim()].filter(Boolean);
    }
    const y0 = H / 2 - (lines.length - 1) * (size + 8) / 2;
    lines.forEach((ln, i) => {
      const y = y0 + i * (size + 8);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.lineWidth = 8;
      ctx.lineJoin = 'round';
      ctx.strokeText(ellipsize(ctx, ln, maxW), W / 2, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(ellipsize(ctx, ln, maxW), W / 2, y);
    });
  }

  // -------------------------------------------------------------------------
  // Sync status (drawn on the player panel / library footer)
  // -------------------------------------------------------------------------

  _onSyncMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'device-status':
        this.sync.connected = true;
        this.sync.devices = Array.isArray(msg.devices) ? msg.devices : [];
        break;
      case 'script-loading':
        this.sync.script = 'スクリプト読み込み中…';
        break;
      case 'script-ready':
        this.sync.script = 'FunScript 同期中';
        break;
      case 'script-missing':
        this.sync.script = 'FunScript 見つかりません';
        break;
      default:
        break;
    }
    this.playerPanel.redraw();
  }

  /**
   * Sync status line, contextual per mode. In library mode there is no
   * sync socket at all, so a "not connected" warning there is misleading.
   * In player mode we distinguish: socket still opening → socket open but no
   * device-status relayed by the desktop app → device status confirmed.
   */
  _syncStatus() {
    if (this.mode === 'library') {
      return { text: `${this.library.view().total} 本のビデオ`, color: '#8b93ad' };
    }
    if (this.sync.connected) {
      const text = this.sync.devices.length
        ? `デバイス: ${this.sync.devices.map((d) => d.label).join(', ')}`
        : 'デバイスなし';
      return { text, color: '#7ed98a' };
    }
    if (this.player.wsConnected) {
      // Device status is relayed by the desktop FunSync app; playback works
      // standalone whether or not it is running.
      return { text: 'デスクトップ未接続（単独再生中）', color: '#ff9d6a' };
    }
    return { text: '同期接続中…（単独再生中）', color: '#ff9d6a' };
  }

  /** Redraw whichever panel the user is currently looking at. */
  _redrawActivePanel() {
    const panel = this.mode === 'player' ? this.playerPanel : this.libraryPanel;
    if (panel) panel.redraw();
  }

  /**
   * Refresh gate for the player panel: it carries everything the retired
   * head-attached OSD did (title, time, sync status, projection, toasts).
   */
  _playerSignature() {
    const v = this.player.info;
    return [
      v ? v.name : '',
      this.player.paused ? 'p' : 'r',
      formatTime(this.player.currentTime),
      formatTime(this.player.duration),
      this._syncStatus().text,
      this.sync.script || '-',
      this.slideshow ? 'ss' : '-',
      this.vrMode ? `${this.vrMode.projection}/${this.vrMode.stereo}` : '-',
      this.toast ? this.toast.text : '',
      this.player.lastError || '',
      this.player.muted ? 'muted' : 'sound',
      this._frameError || '',
    ].join('|');
  }
}

const app = new VrApp();
app.start().catch((err) => {
  const status = document.getElementById('overlay-status');
  if (status) status.textContent = `初期化に失敗しました: ${err && err.message ? err.message : err}`;
});
