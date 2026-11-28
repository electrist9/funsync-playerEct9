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
import { LibraryModel, fetchVideos, fetchSources } from './library.js';
import { VideoPlayer } from './player.js';
import { SlideshowModel, SlideshowRenderer } from './slideshow.js';
import { VRScreen } from './vr-screen.js';
import { resolveVRMode, nextOverride, modeLabel, overrideButtonLabel } from './vr-mode.js';
import { parseSubtitles, activeCue } from './subtitles.js';
import { formatTime } from './util.js';

const FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif';
const SORT_LABELS = { name: '名前', recent: '追加日', duration: '長さ' };
const SORT_CYCLE = ['name', 'recent', 'duration'];
// Library display settings (folder ON/OFF, tile/list, sort) persist in the
// browser's localStorage so reopening the VR page keeps them.
const SETTINGS_KEY = 'funsync.vr.library-settings';
// Flat-screen placement (left-thumbstick distance + size) persists in the
// browser's localStorage so the next VR session opens where the user left it.
const PLAYER_SETTINGS_KEY = 'funsync.vr.player-settings';
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
// Folder-picker grid: 3 tile columns, 3 rows visible at rest — the right
// thumbstick scrolls whole rows (step FP_COLS) over a 12-tile window,
// exactly like the library grid. The error strip shifts the grid down
// by 36px, which only leaves room for three rows then.
const FP_COLS = 3;
const FP_VISIBLE_ROWS = 4;
const FP_ERROR_ROWS = 3;
const STICK_DEADZONE = 0.25;
// Left thumbstick click resets distance/size to the built-in defaults.
// Quest Browser reports it as gamepad button 3 (verified on-device; the
// xr-standard thumbstick index 2 never fires there).
const STICK_BUTTON = 3;
const DEFAULT_SCREEN_DIST = 2.6;
const DEFAULT_SCREEN_SCALE = 1;
const SCREEN_DIST_MIN = 0.5;
const SCREEN_DIST_MAX = 4.0;
const SCREEN_SCALE_MIN = 0.2;
const SCREEN_SCALE_MAX = 2.2;

/**
 * Word-break-free wrapping (works for space-less Japanese): greedily break
 * characters at maxWidth and ellipsize whatever overflows maxLines.
 */
function wrapLines(ctx, text, maxWidth, maxLines) {
  const all = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n') {
      all.push(line);
      line = '';
      continue;
    }
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxWidth) {
      all.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  all.push(line);
  if (all.length <= maxLines) return all;
  const kept = all.slice(0, maxLines - 1);
  kept.push(ellipsize(ctx, all.slice(maxLines - 1).join(''), maxWidth));
  return kept;
}

class VrApp {
  constructor() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controllers = [];

    this.mode = 'library';
    this.library = new LibraryModel();
    // Panel-fit window size: list rows paint from y=170 at 72 px each, so
    // 9 rows end at y=818 — clear of the toast strip at H-128 and the
    // scroll hint at H-52; the grid (3×3 tiles of 208 px) ends at 822.
    // (The model default of 12 overflowed the 960 px canvas.)
    this.library.pageSize = 9;
    this._loadLibrarySettings(); // restore folder/view/sort from localStorage
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
    // Funscript variants: the desktop owns switching and echoes every
    // change back as `variant-changed`; we mirror its active label here so
    // the 🎢 button can cycle labels and ask for the next one (see
    // _cycleVariant / _onSyncMessage).
    this._variants = []; // video.variants ([] or 1 entry → no 🎢 button)
    this._activeVariant = null; // label the desktop reports as active
    this._pendingVariant = null; // label sent, awaiting the echo (button locks)
    this._variantPendingUntil = 0; // pending-echo deadline (cleared in _frame)
    // Slideshow inputs kept live so a variant switch can rebuild the model.
    this._ssCfg = null; // corner/sizeDenom/imageOrder/transition/background/preset/presets
    this._ssImageUrls = null; // image URLs of the running slideshow
    // Modal slideshow-folder picker (built with the player rig).
    this.folderPanel = null;
    this._fp = null; // picker state { path, parent, dirs, scroll, scrollTarget, loading, busy, error, current } while open
    this.toast = null; // { text, until }
    this._hover = null; // { controller, mesh, uv, distance }
    this._playerSig = ''; // player-panel refresh gate (see _playerSignature)
    this._scrubT = null;  // last scrub seek time (throttle; see _seekToUv)
    this._screenDist = DEFAULT_SCREEN_DIST; // flat-screen placement (left thumbstick; see _updateScreenControls)
    this._screenScale = DEFAULT_SCREEN_SCALE;
    this._loadPlayerSettings(); // may override both from localStorage
    this._playerSaveTimer = null; // debounced placement save (see _schedulePlayerSave)
    this._panelActiveUntil = 0; // player-panel auto-hide deadline (see _updatePanelFade)
    this._libScrollAcc = 0; // fractional right-stick library scroll carry (see _updateLibraryScroll)
    this._thumbs = new Map(); // video.id → { img, state, attempts } (grid tiles)
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
      // Draw the grid BEFORE the other transparent objects. The player
      // panel keeps depthWrite off (so its opacity-0 ghost never punches
      // depth holes), and three sorts transparents by object-center
      // distance — the grid's center (origin) is nearest, so it would
      // otherwise paint its lines OVER the panel in flat mode ("the
      // panel is see-through, I can see the grid"). Forcing it first lets
      // the panel blend over it instead.
      this.grid.renderOrder = -1;
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
    this._flushPlayerSave();
    this.session = null;
    this.renderer.setAnimationLoop(null);
    this._disableSlideshow();
    this._closeFolderPicker();
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

    // Modal slideshow-folder picker: it REPLACES the control row while open
    // (playerPanel is hidden then — the control row rides the screen's z,
    // which the left thumbstick moves, while this panel stays put).
    // depthTest off + top renderOrder keep it over the screen quad at any
    // screen distance (0.5–4.0 m); opacity stays 1 (the _select ghost guard
    // would otherwise swallow presses, and _updatePanelFade ignores it).
    this.folderPanel = new UIPanel({ worldWidth: 1.7, pixelWidth: 1280, pixelHeight: 960 });
    this.folderPanel.mesh.position.set(0, 1.45, -2.2);
    this.folderPanel.mesh.material.depthWrite = false;
    this.folderPanel.mesh.material.depthTest = false;
    this.folderPanel.mesh.renderOrder = 4;
    this.folderPanel.setDraw(() => this._drawFolderPicker());
    this.folderPanel.mesh.visible = false;
    this.playerGroup.add(this.folderPanel.mesh);

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
      const ray = new THREE.Line(
        rayGeo,
        // transparent:true is ESSENTIAL: WebGL three.js renders the opaque
        // pass fully BEFORE any transparent object, and every panel material
        // is transparent — an opaque ray line could never render on top of a
        // panel no matter its renderOrder/depthTest (field report: the ray
        // vanished wherever it crossed the folder picker AND the library
        // list panel). In the transparent pass, renderOrder 10 sorts it after
        // all panels (max 4) so it stays visible everywhere.
        new THREE.LineBasicMaterial({
          color: 0xa8c4ff,
          transparent: true,
          depthTest: false,
        }),
      );
      ray.renderOrder = 10;
      ray.frustumCulled = false;
      ray.scale.z = 4;
      controller.add(ray);
      controller.userData.ray = ray;
      // Cursor dot at the exact hit point — the 1px ray alone is hard to
      // track over busy panels, and this directly answers "where does the
      // ray point". Child of the controller, parked along -z each frame.
      const cursor = new THREE.Mesh(
        new THREE.SphereGeometry(0.014, 16, 16),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
          depthTest: false,
        }),
      );
      cursor.renderOrder = 11;
      cursor.visible = false;
      controller.add(cursor);
      controller.userData.cursor = cursor;
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
      this._updateStickButtons();
      this._updateLibraryScroll();
      this._tickLibraryScroll();
      this._updateFolderScroll();
      this._tickFolderScroll();
      if (this.toast && Date.now() > this.toast.until) {
        this.toast = null;
        this._redrawActivePanel();
      }
      if (this._pendingVariant && Date.now() > this._variantPendingUntil) {
        // The desktop never echoed the switch back (e.g. it is on another
        // video): unlock the 🎢 button instead of hanging "切替中…" forever.
        this._pendingVariant = null;
        this.toast = { text: 'バリアント切替の確認ができませんでした', until: Date.now() + 3000 };
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
    this._applyScreenPlacement();
    this._schedulePlayerSave();
  }

  /**
   * Edge-detect the thumbstick click buttons each frame (there is no XR
   * event for them). Only the LEFT thumbstick has a binding; the press
   * state lives on the controller itself so either hand can trigger it.
   */
  _updateStickButtons() {
    for (const controller of this.controllers) {
      const src = controller.userData.inputSource;
      const gp = src && src.gamepad;
      const btn = gp && gp.buttons && gp.buttons[STICK_BUTTON];
      const pressed = !!(btn && btn.pressed);
      const was = controller.userData._stickBtn === true;
      controller.userData._stickBtn = pressed;
      if (!pressed || was) continue;
      if (src.handedness !== 'left') continue;
      // No flat quad to reset in the library or in surround-sphere modes.
      if (this.mode !== 'player' || !this.vrScreen || this.vrScreen.sphere) continue;
      this._resetScreenPlacement();
    }
  }

  _resetScreenPlacement() {
    this._screenDist = DEFAULT_SCREEN_DIST;
    this._screenScale = DEFAULT_SCREEN_SCALE;
    this._applyScreenPlacement();
    this._flushPlayerSave(); // a deliberate action: persist right away
    this.toast = { text: '距離・拡大率をデフォルトに戻しました', until: Date.now() + 2500 };
    this.playerPanel.redraw();
  }

  /**
   * Right-thumbstick scrolling in library mode (paging buttons are gone —
   * stick down advances the list, stick up rewinds). The stick drives the
   * model's scroll *target* in whole notches: grid mode steps one row (3
   * items) at a time (scrollStep), list mode one row. Fractional tilts
   * accumulate so slow tilts still register; the step rate scales with
   * tilt, normalized by 1/scrollStep() so both modes travel at roughly
   * the same pixels-per-second. The visible motion eases toward the
   * target in _tickLibraryScroll — smooth scrolling, not item jumps.
   */
  _updateLibraryScroll() {
    if (this.mode !== 'library') {
      this._libScrollAcc = 0;
      return;
    }
    let y = 0;
    for (const controller of this.controllers) {
      const src = controller.userData.inputSource;
      if (!src || src.handedness !== 'right') continue;
      const gp = src.gamepad;
      if (!gp || !gp.axes || gp.axes.length <= STICK_AXIS_Y) continue;
      const ay = gp.axes[STICK_AXIS_Y] || 0;
      if (Math.abs(ay) >= STICK_DEADZONE) y = ay; // gamepad Y: stick up = negative
      break;
    }
    if (!y) {
      this._libScrollAcc = 0;
      return;
    }
    const mag = (Math.abs(y) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    const step = this.library.scrollStep();
    this._libScrollAcc += Math.sign(y) * mag * (0.25 / step);
    let steps = 0;
    while (Math.abs(this._libScrollAcc) >= 1) {
      const dir = Math.sign(this._libScrollAcc);
      this._libScrollAcc -= dir;
      steps += dir;
    }
    if (steps) this.library.scrollBy(steps * step);
  }

  /**
   * Ease the library scroll toward its target (LibraryModel.tickScroll)
   * and repaint while it moves. Separate from the stick handler so the
   * animation still finishes after the stick returns to center.
   */
  _tickLibraryScroll() {
    if (this.mode !== 'library') return;
    if (this.library.tickScroll()) this._redrawLibrary();
  }

  /**
   * Right-thumbstick scrolling for the folder-picker grid — same feel as
   * the library: whole-row notches (FP_COLS items), fractional tilts
   * accumulate, and the visible position eases toward the target in
   * _tickFolderScroll. Only active while the picker is open.
   */
  _updateFolderScroll() {
    const st = this._fp;
    if (!st) {
      this._fpScrollAcc = 0;
      return;
    }
    let y = 0;
    for (const controller of this.controllers) {
      const src = controller.userData.inputSource;
      if (!src || src.handedness !== 'right') continue;
      const gp = src.gamepad;
      if (!gp || !gp.axes || gp.axes.length <= STICK_AXIS_Y) continue;
      const ay = gp.axes[STICK_AXIS_Y] || 0;
      if (Math.abs(ay) >= STICK_DEADZONE) y = ay; // gamepad Y: stick up = negative
      break;
    }
    if (!y) {
      this._fpScrollAcc = 0;
      return;
    }
    const mag = (Math.abs(y) - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    this._fpScrollAcc += Math.sign(y) * mag * (0.25 / FP_COLS);
    let steps = 0;
    while (Math.abs(this._fpScrollAcc) >= 1) {
      const dir = Math.sign(this._fpScrollAcc);
      this._fpScrollAcc -= dir;
      steps += dir;
    }
    if (!steps) return;
    // Clamp like LibraryModel.maxScroll in grid mode: the row-aligned
    // window still scrolls far enough to reveal the final partial row.
    // (An error strip shrinks the visible window to FP_ERROR_ROWS rows.)
    const total = (st.dirs ? st.dirs.length : 0) + (st.images ? st.images.length : 0);
    const rowsVisible = st.error ? FP_ERROR_ROWS : FP_VISIBLE_ROWS;
    const pageSize = FP_COLS * rowsVisible;
    const aligned = Math.ceil(total / FP_COLS) * FP_COLS - pageSize;
    const max = Math.max(0, Math.floor(aligned / FP_COLS) * FP_COLS);
    const next = Math.min(max, Math.max(0, st.scrollTarget + steps * FP_COLS));
    if (next !== st.scrollTarget) st.scrollTarget = next;
  }

  /** Ease the picker scroll toward its target; repaint while it moves. */
  _tickFolderScroll() {
    const st = this._fp;
    if (!st || !this.folderPanel) return;
    if (st.scroll === st.scrollTarget) return;
    const d = st.scrollTarget - st.scroll;
    st.scroll = Math.abs(d) < 0.02 ? st.scrollTarget : st.scroll + d * 0.25;
    this.folderPanel.redraw();
  }

  _targets() {
    if (this.mode === 'library') return [this.libraryPanel.mesh];
    // The folder picker is modal for raycasts too: it is always DRAWN in
    // front (depthTest off, renderOrder 4) but sits at a fixed 2.2 m, while
    // the video quad lives at the user's saved screen distance. Whenever the
    // screen is closer than that, the quad geometrically wins every press —
    // the picker looks tappable but never gets the hit. So while it is open,
    // ONLY the picker may be hit; the hidden control row and the screen/sphere
    // are swapped out entirely (raycasts hit invisible meshes too).
    if (this.folderPanel && this._fp) return [this.folderPanel.mesh];
    const targets = [this.screenMesh, this.playerPanel.mesh];
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
      const cursor = controller.userData.cursor;
      if (cursor) {
        if (hit) {
          cursor.visible = true;
          cursor.position.z = -controller.userData.ray.scale.z;
        } else {
          cursor.visible = false;
        }
      }
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
    if (this.folderPanel && this._fp) panels.push(this.folderPanel);
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

  /**
   * Restore folder/view/sort from localStorage. Every failure path (storage
   * blocked, corrupt JSON, unknown values) just keeps the built-in defaults,
   * so a bad entry can never break the frame loop.
   */
  _loadLibrarySettings() {
    let raw = null;
    try {
      raw = localStorage.getItem(SETTINGS_KEY);
    } catch {
      return; // storage unavailable (private mode / blocked cookies)
    }
    if (!raw) return;
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch {
      return;
    }
    if (!saved || typeof saved !== 'object') return;
    if (typeof saved.folderMode === 'boolean') this.library.setFolderMode(saved.folderMode);
    if (saved.viewMode === 'grid' || saved.viewMode === 'list') this.library.setViewMode(saved.viewMode);
    if (SORT_CYCLE.includes(saved.sort)) this.library.setSort(saved.sort);
  }

  _saveLibrarySettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        folderMode: this.library.folderMode,
        viewMode: this.library.viewMode,
        sort: this.library.sort,
      }));
    } catch {
      // Storage full/blocked: settings simply stay session-only.
    }
  }

  // Flat-screen placement persistence. Only _updateScreenControls changes
  // it (per-frame while the stick is held), so writes are debounced and
  // flushed on leaving playback / the session. Values are re-validated on
  // load so a tampered or stale entry can never place the screen outside
  // the thumbstick range.
  _loadPlayerSettings() {
    let raw = null;
    try {
      raw = localStorage.getItem(PLAYER_SETTINGS_KEY);
    } catch {
      return; // Storage blocked: defaults stay.
    }
    if (!raw) return;
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch {
      return;
    }
    if (!saved || typeof saved !== 'object') return;
    if (Number.isFinite(saved.screenDist)) {
      this._screenDist = Math.max(SCREEN_DIST_MIN, Math.min(SCREEN_DIST_MAX, saved.screenDist));
    }
    if (Number.isFinite(saved.screenScale)) {
      this._screenScale = Math.max(SCREEN_SCALE_MIN, Math.min(SCREEN_SCALE_MAX, saved.screenScale));
    }
  }

  _savePlayerSettings() {
    try {
      localStorage.setItem(PLAYER_SETTINGS_KEY, JSON.stringify({
        screenDist: this._screenDist,
        screenScale: this._screenScale,
      }));
    } catch {
      // Storage full/blocked: placement simply stays session-only.
    }
  }

  _schedulePlayerSave() {
    if (this._playerSaveTimer) clearTimeout(this._playerSaveTimer);
    this._playerSaveTimer = setTimeout(() => {
      this._playerSaveTimer = null;
      this._savePlayerSettings();
    }, 800);
  }

  _flushPlayerSave() {
    if (this._playerSaveTimer) {
      clearTimeout(this._playerSaveTimer);
      this._playerSaveTimer = null;
    }
    this._savePlayerSettings();
  }

  // Apply the stored/computed placement to the quad and the panels that
  // ride in its plane. Called on open (so a reloaded page restores it) and
  // from the thumbstick handler.
  _applyScreenPlacement() {
    const dist = this._screenDist;
    this.vrScreen.setPlacement(dist, this._screenScale);
    // Panel sits in the screen's own plane (no overlap: panel top edge
    // y 0.725 stays below the screen's pinned bottom edge y 0.75); the
    // subtitle hides just behind it so the panel still occludes captions.
    this.playerPanel.mesh.position.z = -dist;
    this.subtitlePanel.mesh.position.z = -dist - 0.1;
  }

  /**
   * Grid-tile thumbnail, mirroring the 2D remote's wireThumb ladder:
   * /api/media/thumb/<id> returns a 1x1 transparent PNG while ffmpeg is
   * still generating the frame (and 404s until the registry knows the
   * video), so a placeholder or error re-requests with a cache-buster on
   * a growing delay until the real JPEG lands or we give up. Entries are
   * keyed by video id and survive redraws/scrolling; the redraw on the
   * first real image repaints just that panel.
   */
  _thumbFor(video) {
    if (!video?.thumbUrl) return null;
    const cached = this._thumbs.get(video.id);
    if (cached) return cached;
    if (this._thumbs.size > 600) return null; // memory guard on huge libraries
    const entry = { img: new Image(), state: 'loading', attempts: 0 };
    this._thumbs.set(video.id, entry);
    entry.img.onload = () => {
      if (entry.img.naturalWidth > 1) {
        entry.state = 'ready';
        if (this.mode === 'library' && this.libraryPanel) this._redrawLibrary();
      } else {
        this._thumbRetry(entry, video); // placeholder: still generating
      }
    };
    entry.img.onerror = () => this._thumbRetry(entry, video);
    entry.img.src = video.thumbUrl;
    return entry;
  }

  _thumbRetry(entry, video) {
    if (entry.attempts >= 15) {
      entry.state = 'failed';
      return;
    }
    entry.attempts++;
    const delay = entry.attempts <= 10 ? Math.min(1000 * entry.attempts, 8000) : 30000;
    setTimeout(() => {
      const url = video.thumbUrl;
      entry.img.src = url + (url.includes('?') ? '&' : '?') + '_r=' + entry.attempts;
    }, delay);
  }

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
    // The folder tree mirrors the desktop 「フォルダを閲覧」 view, which is
    // rooted at the configured library sources. A sources fetch failure is
    // non-fatal: the flat list still works, folder view just comes up empty.
    try {
      this.library.setSources(await fetchSources());
    } catch {
      /* keep whatever sources we already had */
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

    // Funscript variants: only videos with more than one script show the 🎢
    // button. The desktop applies switches and echoes them as
    // variant-changed; on open it activates variants[0], so mirror that.
    this._variants = Array.isArray(video.variants) ? video.variants : [];
    this._activeVariant = this._variants.length > 1 && this._variants[0]
      ? this._variants[0].label
      : null;
    this._pendingVariant = null;
    this._closeFolderPicker();

    // Projection mode: reset the manual override, then trust the backend's
    // filename-derived vrFormat (see vr_api / vr-mode.js).
    this.vrOverride = 'auto';
    this.vrMode = resolveVRMode(video, this.vrOverride);
    this.vrScreen.applyMode(this.renderer, this.vrMode);
    this._updateGridVisibility();
    // Restore the persisted (or last-session) screen distance/size; the
    // quad's own defaults only match the built-in ones, not stored values.
    this._applyScreenPlacement();
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
    this._flushPlayerSave();
    this._disableSlideshow();
    this._closeFolderPicker();
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

    const lib = this.library;
    const view = lib.view();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8ecf8';
    // Short title: at 44px the full brand name ran underneath the header
    // button cluster on the right (reported overlapping on-device).
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText('VRライブラリ', 40, 64);

    // Header buttons (right to left): refresh, sort, view-mode, folder.
    const regions = [];
    ctx.font = `28px ${FONT}`;
    const btnRight = W - 40;
    const folderLabel = `フォルダ: ${lib.folderMode ? 'ON' : 'OFF'}`;
    const viewLabel = `表示: ${lib.viewMode === 'grid' ? 'タイル' : 'リスト'}`;
    const sortLabel = `ソート: ${SORT_LABELS[lib.sort]}`;
    const width = (text) => Math.max(140, ctx.measureText(text).width + 40);
    let bx = btnRight;
    regions.push({ x: (bx -= 140), y: 40, w: 140, h: 64, id: 'refresh', label: '更新',
      onClick: () => this._refreshLibrary() });
    bx -= 16;
    regions.push({ x: (bx -= width(sortLabel)), y: 40, w: width(sortLabel), h: 64, id: 'sort', label: sortLabel,
      onClick: () => {
        const i = SORT_CYCLE.indexOf(lib.sort);
        lib.setSort(SORT_CYCLE[(i + 1) % SORT_CYCLE.length]);
        this._saveLibrarySettings();
        this._redrawLibrary();
      } });
    bx -= 16;
    regions.push({ x: (bx -= width(viewLabel)), y: 40, w: width(viewLabel), h: 64, id: 'view', label: viewLabel,
      onClick: () => { lib.setViewMode(lib.viewMode === 'grid' ? 'list' : 'grid'); this._saveLibrarySettings(); this._redrawLibrary(); } });
    bx -= 16;
    regions.push({ x: (bx -= width(folderLabel)), y: 40, w: width(folderLabel), h: 64, id: 'foldermode', label: folderLabel,
      onClick: () => { lib.setFolderMode(!lib.folderMode); this._saveLibrarySettings(); this._redrawLibrary(); } });

    // Status line: totals + visible range (scroll position), plus a
    // breadcrumb and an "up" button while folder mode is on. Labels come
    // from the folder index (source name at a source root), like desktop.
    const inFolder = lib.folderMode && lib.folder !== null;
    ctx.font = `26px ${FONT}`;
    ctx.fillStyle = '#8b93ad';
    const crumb = inFolder ? ` • 📂 ${lib.folderLabel()}` : (lib.folderMode ? ' • 📂 ソース一覧' : '');
    const range = view.total ? ` • ${view.start + 1}–${view.end}` : '';
    let statusX = 40;
    if (inFolder) {
      // y 96 (was 92): keep clear of the title's descenders; statusX 214
      // (was 206): a real gap after the button, not a shared edge.
      regions.push({ x: 40, y: 96, w: 150, h: 52, id: 'up', label: '↑ 上位へ',
        onClick: () => { lib.setFolder(lib.folderParent()); this._redrawLibrary(); } });
      statusX = 214;
    }
    ctx.fillText(`${view.total} 本${range}${crumb}`, statusX, 124);

    const startY = 180;
    // The scrollable band is clipped so partial rows slide under the
    // header and stop above the VR終了 row while the smooth-scroll
    // easing animates — instead of items popping in per row.
    const bandTop = 156;
    const bandBottom = 856;
    ctx.save();
    ctx.beginPath();
    ctx.rect(24, bandTop, W - 48, bandBottom - bandTop);
    ctx.clip();
    if (lib.viewMode === 'grid') {
      // Tiles: 3×3 cards, names wrapped to two lines.
      const cols = 3;
      const gap = 16;
      const tileW = Math.floor((W - 64 - gap * (cols - 1)) / cols);
      const tileH = 208;
      const rowPitch = tileH + 14;
      view.items.forEach((item, i) => {
        // Global index placement: the slice can start mid-row while the
        // easing runs, and fractional lib.scroll shifts rows smoothly.
        const gi = view.start + i;
        const x = 32 + (gi % cols) * (tileW + gap);
        const y = startY + (Math.floor(gi / cols) - lib.scroll / cols) * rowPitch;
        if (y + tileH <= bandTop || y >= bandBottom) return; // fully outside the band
        const region = item.folder
          ? { x, y, w: tileW, h: tileH, id: `folder:${item.folder.path}`, label: '',
            onClick: () => { lib.setFolder(item.folder.path); this._redrawLibrary(); } }
          : { x, y, w: tileW, h: tileH, id: `video:${item.video.id}`, label: '',
            onClick: () => this._openVideo(item.video) };
        regions.push(region);

        const hovered = this.libraryPanel.hoverId === region.id;

        // Video tiles get the ffmpeg thumbnail (cover-cropped, full-bleed)
        // with a bottom scrim so the name/footer stay readable over any
        // frame. Until a thumbnail is ready the tile keeps its old flat
        // card look, so cold caches never look broken.
        const thumb = item.video ? this._thumbFor(item.video) : null;
        const hasThumb = !!thumb && thumb.state === 'ready';
        if (hasThumb) {
          ctx.save();
          roundRect(ctx, x, y, tileW, tileH, 10);
          ctx.clip();
          const img = thumb.img;
          const scale = Math.max(tileW / (img.naturalWidth || tileW), tileH / (img.naturalHeight || tileH));
          const dw = (img.naturalWidth || tileW) * scale;
          const dh = (img.naturalHeight || tileH) * scale;
          ctx.drawImage(img, x + (tileW - dw) / 2, y + (tileH - dh) / 2, dw, dh);
          if (hovered) {
            ctx.fillStyle = 'rgba(126,162,255,0.16)';
            ctx.fillRect(x, y, tileW, tileH);
          }
          const grad = ctx.createLinearGradient(0, y + tileH - 120, 0, y + tileH);
          grad.addColorStop(0, 'rgba(12,16,28,0)');
          grad.addColorStop(1, 'rgba(12,16,28,0.94)');
          ctx.fillStyle = grad;
          ctx.fillRect(x, y + tileH - 120, tileW, 120);
          ctx.restore();
          roundRect(ctx, x, y, tileW, tileH, 10);
          ctx.strokeStyle = 'rgba(201,210,232,0.16)';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          roundRect(ctx, x, y, tileW, tileH, 10);
          ctx.fillStyle = hovered ? '#232a44' : '#151a2c';
          ctx.fill();
        }

        const text = hovered ? '#ffffff' : '#c9d2e8';
        ctx.fillStyle = text;
        ctx.font = `30px ${FONT}`;
        const name = item.folder ? item.folder.name : String(item.video.name || '');
        const lines = wrapLines(ctx, name, tileW - 36, 2);
        // With a thumbnail the name sits on the scrim above the footer;
        // without one it keeps its original top-aligned position.
        const nameBase = hasThumb ? y + tileH - 58 - (lines.length - 1) * 38 : y + 36;
        lines.forEach((line, li) => ctx.fillText(line, x + 18, nameBase + li * 38));
        ctx.font = `24px ${FONT}`;
        ctx.fillStyle = '#8b93ad';
        if (item.folder) {
          ctx.fillText(`📁 ${item.folder.count} 本`, x + 18, y + tileH - 26);
        } else {
          const badges = [];
          if (item.video.hasFunscript) badges.push('F');
          if (item.video.hasSubtitle) badges.push('S');
          if (item.video.manualVRType === 'vr') badges.push('VR');
          if (badges.length) {
            ctx.fillStyle = '#7ea2ff';
            ctx.fillText(`[${badges.join('')}]`, x + 18, y + tileH - 26);
          }
          ctx.fillStyle = '#8b93ad';
          ctx.textAlign = 'right';
          ctx.fillText(formatTime(item.video.duration), x + tileW - 18, y + tileH - 26);
          ctx.textAlign = 'left';
        }
      });
    } else {
      // List: full-width rows (folders first when folder mode is on).
      const rowH = 72;
      view.items.forEach((item, i) => {
        const gi = view.start + i;
        const y = startY + (gi - lib.scroll) * rowH;
        if (y + rowH <= bandTop || y >= bandBottom) return; // fully outside the band
        const region = item.folder
          ? { x: 32, y, w: W - 64, h: rowH - 10, id: `folder:${item.folder.path}`, label: '',
            onClick: () => { lib.setFolder(item.folder.path); this._redrawLibrary(); } }
          : { x: 32, y, w: W - 64, h: rowH - 10, id: `video:${item.video.id}`, label: '',
            onClick: () => this._openVideo(item.video) };
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
        if (item.folder) {
          ctx.fillText('📁', nameX, y + region.h / 2);
          nameX += ctx.measureText('📁 ').width;
          ctx.fillText(ellipsize(ctx, item.folder.name, W - nameX - 220), nameX, y + region.h / 2);
          ctx.textAlign = 'right';
          ctx.fillStyle = '#8b93ad';
          ctx.font = `26px ${FONT}`;
          ctx.fillText(`${item.folder.count} 本`, W - 56, y + region.h / 2);
          ctx.textAlign = 'left';
          return;
        }
        const video = item.video;
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
    }
    ctx.restore();

    if (!view.items.length) {
      ctx.fillStyle = '#8b93ad';
      ctx.font = `30px ${FONT}`;
      ctx.fillText(lib.folderMode
        ? (lib.folder === null
          ? '表示できるソースがありません。デスクトップのソース設定とスキャンを確認してください。'
          : 'このフォルダにビデオはありません。')
        : 'ビデオが見つかりません。デスクトップでライブラリをスキャンしてください。', 56, startY + 40);
    }

    // Scrolling hint (paging buttons were replaced by the right stick).
    // Bottom-left corner: centered here it sat directly under the VR終了
    // button, so the button covered the text (reported on-device).
    ctx.fillStyle = '#5b6380';
    ctx.font = `24px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('右スティック上下でスクロール', 40, H - 40);

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

    // Exit VR bottom-center: always visible in library mode.
    regions.push({ x: W / 2 - 80, y: H - 96, w: 160, h: 64, id: 'vr', label: 'VR終了',
      onClick: () => this._endVrSession() });

    for (const r of regions) {
      if (r.id.startsWith('video:') || r.id.startsWith('folder:')) continue; // items paint themselves
      if (r.id === 'vr') {
        drawButton(ctx, r, this.libraryPanel, { fontSize: 28, base: '#5a2438', hover: '#8a3a52', text: '#ffdfe3' });
        continue;
      }
      if (r.id === 'up') {
        drawButton(ctx, r, this.libraryPanel, { fontSize: 24 });
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
    // Button row: 8 base columns, +1 for the 🎢 variant picker when the
    // video has more than one funscript. Columns split the width evenly;
    // drawButton shrinks long labels automatically.
    const hasVariant = this._variants.length > 1;
    const bh = 96;
    const gap = 10;
    const cols = hasVariant ? 9 : 8;
    const bw = Math.floor((W - 2 * SEEK_SIDE - gap * (cols - 1)) / cols);
    const total = bw * cols + gap * (cols - 1);
    const x0 = (W - total) / 2;
    const y0 = 152;

    const mk = (id, label, onClick, disabled) => ({ x: 0, y: y0, w: bw, h: bh, id, label, onClick, disabled });
    const buttons = [
      mk('back', '◀ ライブラリ', () => this._closePlayback()),
      mk('rew', '-10 秒', () => { this.player.seekBy(-10); this.playerPanel.redraw(); }),
      mk('playpause', playing ? '⏸ 一時停止' : '▶ 再生', () => { this.player.toggle(); this.playerPanel.redraw(); }),
      mk('fwd', '+10 秒', () => { this.player.seekBy(10); this.playerPanel.redraw(); }),
      mk('mute', this.player.muted ? '🔇 ミュート' : '🔊 音声', () => { this.player.toggleMute(); this.playerPanel.redraw(); }),
      mk('slideshow', this.slideshow ? 'SS 停止' : 'SS 開始',
        () => this._toggleSlideshow(),
        !this._canSlideshow()),
      // Slideshow folder picker (the folder is global; the picker restarts
      // a running slideshow after a change).
      mk('folder', '📷フォルダ', () => this._openFolderPicker(),
        !(this.slideshow || this._canSlideshow())),
    ];
    if (hasVariant) {
      const variantLabel = this._pendingVariant
        ? '🎢 切替中…'
        : `🎢 ${this._activeVariant || ''}`.replace(/\s+$/, '');
      buttons.push(mk('variant', variantLabel, () => this._cycleVariant(), !!this._pendingVariant));
    }
    // Projection override stays at the right edge, matching the header label.
    buttons.push(mk('projection', overrideButtonLabel(this.vrOverride),
      () => this._cycleProjectionOverride()));
    buttons.forEach((r, i) => { r.x = x0 + i * (bw + gap); });

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
        this.toast = { text: 'スライドショーフォルダが未設定です。📷フォルダ かデスクトップで設定してください。', until: Date.now() + 5000 };
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
      const actions = await this._fetchActions(this._activeScriptUrl());
      if (!actions.length) {
        this.toast = { text: 'FunScript にアクションがありません。', until: Date.now() + 5000 };
        this.playerPanel.redraw();
        return;
      }

      const imageUrls = listing.images.map((im) => im.url);
      // Keep the inputs live so _rebuildSlideshowScript can swap in a new
      // variant's actions without re-fetching config/images.
      this._ssCfg = {
        corner: cfg.corner,
        sizeDenom: cfg.sizeDenom,
        imageOrder: cfg.imageOrder,
        transition: cfg.transition,
        background: cfg.background,
        preset: cfg.preset,
        presets: cfg.presets,
      };
      this._ssImageUrls = imageUrls;
      const model = new SlideshowModel({
        canvasW: 1280,
        canvasH: 720,
        ...this._ssCfg,
        imageUrls,
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

  /**
   * Script URL for the active funscript variant. Videos with a single
   * script always use the plain scriptUrl; variant URLs come from the
   * video listing (?variant=<label>) and the _fetchActions cache keys them
   * separately.
   */
  _activeScriptUrl() {
    const v = this.player.info;
    if (!v) return '';
    if (this._variants.length > 1 && this._activeVariant) {
      const hit = this._variants.find((x) => x && x.label === this._activeVariant);
      if (hit && hit.scriptUrl) return hit.scriptUrl;
    }
    return v.scriptUrl || '';
  }

  /**
   * Cycle the funscript variant (🎢 button), mirroring the desktop's chip:
   * send switch-variant over the sync socket, then confirm via the
   * variant-changed echo the desktop broadcasts to every client. Standalone
   * (no desktop), only the slideshow's script can be switched locally — the
   * funscript devices belong to the desktop.
   */
  _cycleVariant() {
    const variants = this._variants;
    if (variants.length < 2 || this._pendingVariant) return;
    const labels = variants.map((x) => x && x.label).filter((s) => typeof s === 'string' && s);
    if (labels.length < 2) return;
    const at = labels.indexOf(this._activeVariant);
    const next = labels[(at + 1) % labels.length];
    if (this.player.sync && this.player.sync.switchVariant && this.player.wsConnected) {
      this.player.sync.switchVariant(next);
      this._pendingVariant = next;
      this._variantPendingUntil = Date.now() + 5000;
      this.toast = { text: `バリアント切替中… ${next}`, until: Date.now() + 3000 };
    } else {
      this._activeVariant = next;
      this.toast = { text: `デスクトップ未接続 — スライドショーのみに適用: ${next}`, until: Date.now() + 4000 };
      if (this.slideshow) this._rebuildSlideshowScript();
    }
    this.playerPanel.redraw();
  }

  /**
   * A variant switch landed while the slideshow runs: the photo schedule
   * belongs to the old script, so rebuild the model from the new variant's
   * actions. Images and layout settings carry over from the live inputs.
   */
  async _rebuildSlideshowScript() {
    const ss = this.slideshow;
    if (!ss || !this._ssCfg || !this._ssImageUrls) return;
    try {
      const actions = await this._fetchActions(this._activeScriptUrl());
      if (this.slideshow !== ss) return; // user toggled SS off meanwhile
      if (!actions.length) {
        this.toast = { text: '新しいバリアントにアクションがなく、スライドショーを停止しました。', until: Date.now() + 5000 };
        this._disableSlideshow();
        this._redrawActivePanel();
        return;
      }
      const model = new SlideshowModel({
        canvasW: 1280,
        canvasH: 720,
        ...this._ssCfg,
        imageUrls: this._ssImageUrls,
        actions,
      });
      if (this.slideshow !== ss) return;
      if (!model.switchTimes.length) {
        this.toast = { text: '新しいバリアントから切替ポイントを作成できず、スライドショーを停止しました。', until: Date.now() + 5000 };
        this._disableSlideshow();
        this._redrawActivePanel();
        return;
      }
      // Same renderer + screen texture: only the schedule changes. Warm the
      // photos around the current playhead before the next tick composites.
      ss.model = model;
      const st = model.frame(this.player.currentTime);
      ss.renderer.loadImage(model.images, st.photoIndex);
      ss.renderer.loadImage(model.images, st.toIndex >= 0 ? st.toIndex : st.photoIndex);
      this.toast = { text: `スライドショーをバリアントに再同期（${model.switchTimes.length} 切替）`, until: Date.now() + 3500 };
      this._redrawActivePanel();
    } catch {
      if (this.slideshow !== ss) return;
      this.toast = { text: 'スライドショーの新バリアント再同期に失敗しました。', until: Date.now() + 5000 };
      this._disableSlideshow();
      this._redrawActivePanel();
    }
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
  // Slideshow folder picker (modal panel over the player controls)
  // -------------------------------------------------------------------------

  /**
   * The picker replaces the control row while open (the controls drift with
   * the screen distance and would fight the modal for rays). Content is a
   * server-side browse confined to media-source roots and real drives.
   */
  _openFolderPicker() {
    if (!this.folderPanel || this._fp) return;
    const st = this._fp = { path: '', parent: null, dirs: [], images: [], scroll: 0, scrollTarget: 0, loading: true, busy: false, error: null, current: null };
    this._fpScrollAcc = 0;
    if (this.playerPanel) this.playerPanel.mesh.visible = false;
    this.folderPanel.clearHover();
    this.folderPanel.mesh.visible = true;
    this._fpOpen(st);
  }

  // Open the picker AT the currently configured slideshow folder (field
  // request), falling back to the root list when unset, missing or not
  // browsable. The backend only reveals cfg.folder for folders inside a
  // registered source root, so a stale/closed picker never dereferences it.
  async _fpOpen(st) {
    let start = null;
    try {
      const res = await fetch('/api/remote/slideshow/config', { cache: 'no-store' });
      const cfg = res.ok ? await res.json() : null;
      if (this._fp !== st) return; // closed meanwhile
      if (cfg && typeof cfg.folder === 'string') {
        st.current = cfg.folder;
        if (cfg.configured && cfg.folderExists) start = cfg.folder;
      }
    } catch (err) {
      // No config — just start at the root list below.
    }
    if (this._fp !== st) return;
    await this._fpLoad(start);
    if (this._fp !== st) return;
    if (start && st.error) {
      // The configured folder went un-browsable between the config fetch
      // and the browse: show the root list instead of a dead end.
      st.error = null;
      await this._fpLoad(null);
    }
  }

  /** Safe to call even when the picker was never built/opened. */
  _closeFolderPicker() {
    this._fp = null;
    if (this.folderPanel) {
      this.folderPanel.clearHover();
      this.folderPanel.mesh.visible = false;
    }
    if (this.playerPanel) this.playerPanel.mesh.visible = true;
  }

  /** Load one browse level (null path = root list). */
  async _fpLoad(path) {
    const st = this._fp;
    if (!st || st.busy) return;
    st.loading = true;
    st.error = null;
    this.folderPanel.redraw();
    try {
      const url = '/api/remote/slideshow/browse' + (path ? `?path=${encodeURIComponent(path)}` : '');
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 403) throw new Error('この場所は参照できません。');
      if (!res.ok) throw new Error(`browse ${res.status}`);
      const data = await res.json();
      if (this._fp !== st) return; // picker closed or reloaded meanwhile
      st.path = typeof data.path === 'string' ? data.path : '';
      st.parent = typeof data.parent === 'string' ? data.parent : null;
      st.dirs = Array.isArray(data.dirs) ? data.dirs.filter((d) => d && typeof d.path === 'string') : [];
      // Photos living directly in this folder — drawn as non-selectable
      // cover tiles after the sub-folders (desktop browser parity).
      st.images = Array.isArray(data.images) ? data.images.filter((p) => p && typeof p.path === 'string') : [];
      st.scroll = 0; st.scrollTarget = 0; this._fpScrollAcc = 0;
      st.loading = false;
      this.folderPanel.redraw();
    } catch (err) {
      console.error('[FunSync VR] folder browse failed', err);
      if (this._fp !== st) return;
      st.loading = false;
      st.error = err && err.message && err.message.includes('参照') ? err.message : 'フォルダを読み込めませんでした。';
      this.folderPanel.redraw();
    }
  }

  /** Move the browse view up one level. */
  _fpSetUp() {
    const st = this._fp;
    if (st && st.parent && !st.loading && !st.busy) this._fpLoad(st.parent);
  }

  /** Persist the selected folder as the slideshow folder (desktop is notified server-side). */
  async _fpApplyFolder() {
    const st = this._fp;
    if (!st || !st.path || st.busy) return;
    st.busy = true;
    st.error = null;
    this.folderPanel.redraw();
    const chosen = st.path;
    try {
      const res = await fetch('/api/remote/slideshow/folder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: chosen }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const data = await res.json();
          if (data && data.detail) detail = String(data.detail);
        } catch { /* non-JSON error body */ }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      if (this.slideshow) {
        // The running slideshow is showing the old folder's photos.
        this._disableSlideshow();
        await this._enableSlideshow();
      }
      this._closeFolderPicker();
      this.toast = { text: `スライドショーフォルダを設定: ${chosen}`, until: Date.now() + 5000 };
      this._redrawActivePanel();
    } catch (err) {
      const msg = `設定できませんでした: ${err && err.message ? err.message : err}`;
      if (this._fp === st) {
        st.busy = false;
        st.error = msg;
        this.folderPanel.redraw();
      } else {
        this.toast = { text: msg, until: Date.now() + 5000 };
        this._redrawActivePanel();
      }
    }
  }

  /**
   * Lazy cover/photo thumbnail for a picker tile — the folder-browser
   * analogue of the library's _thumbFor, keyed by ABSOLUTE PATH (browse
   * paths are unique) instead of video id. No retry ladder: the backend
   * generates photo thumbnails synchronously, so a failure (unsupported
   * format, no ffmpeg) is permanent and the tile just keeps its glyph.
   */
  _fpThumbFor(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    if (!this._fpThumbs) this._fpThumbs = new Map();
    let entry = this._fpThumbs.get(filePath);
    if (!entry) {
      if (this._fpThumbs.size > 400) this._fpThumbs.clear(); // bound the Image set
      entry = { img: new Image(), state: 'loading' };
      entry.img.onload = () => {
        entry.state = entry.img.naturalWidth > 1 ? 'ready' : 'failed';
        if (this._fp && this.folderPanel) this.folderPanel.redraw();
      };
      entry.img.onerror = () => {
        entry.state = 'failed';
        if (this._fp && this.folderPanel) this.folderPanel.redraw();
      };
      entry.img.src = `/api/media/slideshow/thumb?path=${encodeURIComponent(filePath)}&w=384`;
      this._fpThumbs.set(filePath, entry);
    }
    return entry;
  }

  _drawFolderPicker() {
    const panel = this.folderPanel;
    if (!panel) return;
    const { ctx } = panel;
    const W = panel.pixelWidth;
    const H = panel.pixelHeight;
    const st = this._fp;

    drawPanelBackground(ctx, W, H, { fill: '#0e101a' });
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8ecf8';
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText('📷 スライドショーフォルダ', 40, 64);

    // Action buttons, right to left: set / up / close.
    ctx.font = `600 28px ${FONT}`;
    const setLabel = st && st.busy ? '設定中…' : '✅ このフォルダを設定';
    const setW = Math.max(180, ctx.measureText(setLabel).width + 40);
    const setX = W - 40 - setW;
    const upW = Math.max(130, ctx.measureText('◀ 上へ').width + 40);
    const upX = setX - 14 - upW;
    const closeW = Math.max(130, ctx.measureText('✕ とじる').width + 40);
    const closeX = upX - 14 - closeW;
    const actions = [
      {
        x: closeX, y: 34, w: closeW, h: 60, id: 'close', label: '✕ とじる',
        onClick: () => this._closeFolderPicker(), disabled: !!(st && st.busy),
      },
      {
        x: upX, y: 34, w: upW, h: 60, id: 'up', label: '◀ 上へ',
        onClick: () => this._fpSetUp(),
        disabled: !(st && st.parent) || !!(st && (st.loading || st.busy)),
      },
      {
        x: setX, y: 34, w: setW, h: 60, id: 'set', label: setLabel,
        onClick: () => this._fpApplyFolder(),
        disabled: !(st && st.path) || !!(st && (st.loading || st.busy)),
      },
    ];
    for (const r of actions) drawButton(ctx, r, panel, { fontSize: 28 });
    // drawButton leaves textAlign='center' behind — reset before any
    // left-aligned text (path line, error, list rows).
    ctx.textAlign = 'left';
    const regions = actions.map((r) => ({ ...r }));

    // Path line: what would be set right now, else what is configured.
    ctx.font = `600 26px ${FONT}`;
    ctx.fillStyle = '#c9d2e8';
    const pathLine = st && st.path ? `選択中: ${st.path}`
      : (st && st.current ? `現在: ${st.current}` : '現在: (未設定)');
    ctx.fillText(ellipsize(ctx, pathLine, W - 80), 40, 124);

    if (st && st.error) {
      ctx.fillStyle = '#ff5d5d';
      ctx.font = `600 24px ${FONT}`;
      let ey = 164;
      for (const ln of wrapLines(ctx, st.error, W - 80, 2)) {
        ctx.fillText(ln, 40, ey);
        ey += 30;
      }
    }

    // Directory tiles: a 3-column folder grid scrolled smoothly with the
    // right thumbstick (paging is gone) — same feel as the library grid.
    const cols = FP_COLS;
    const rows = st && st.error ? FP_ERROR_ROWS : FP_VISIBLE_ROWS;
    const gridTop = st && st.error ? 196 : 160;
    const gap = 16;
    const tileW = Math.floor((W - 64 - gap * (cols - 1)) / cols);
    const tileH = 166;
    const rowPitch = tileH + 14;
    const bandBottom = gridTop + rows * rowPitch;
    const dirs = st && !st.loading ? st.dirs : [];
    // Photos living directly in this folder: drawn after the sub-folders
    // as non-selectable cover tiles (desktop browser parity).
    const photos = st && !st.loading ? (st.images || []) : [];
    const items = dirs.map((d) => ({ kind: 'd', d }));
    for (const p of photos) items.push({ kind: 'p', p });
    const scroll = st ? st.scroll : 0;
    // Path equality for the "configured" highlight: separators and drive
    // letter case may differ between config and browse responses.
    const samePath = (a, b) => {
      const n = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
      return n(a) === n(b);
    };
    // Cover-crop a loaded thumbnail inside a rounded box (same geometry
    // as the library grid); the flat placeholder stays if drawing fails.
    const drawCover = (img, bx, by, bw, bh, radius) => {
      ctx.save();
      roundRect(ctx, bx, by, bw, bh, radius);
      ctx.clip();
      try {
        const scale = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        ctx.drawImage(img, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
      } catch (err) { /* decoding hiccup: keep the placeholder underneath */ }
      ctx.restore();
    };
    const coverFor = (filePath) => {
      const entry = this._fpThumbFor(filePath);
      return entry && entry.state === 'ready' ? entry.img : null;
    };
    if (st && st.loading) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#8b93ad';
      ctx.font = `600 30px ${FONT}`;
      ctx.fillText('読み込み中…', W / 2, gridTop + (rows * rowPitch) / 2);
      ctx.textAlign = 'left';
    } else if (!items.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#8b93ad';
      ctx.font = `600 30px ${FONT}`;
      ctx.fillText(
        st && st.path ? '下位にフォルダはありません — 現在地を設定できます' : '参照できるフォルダがありません（メディアソース／ドライブ）',
        W / 2, gridTop + (rows * rowPitch) / 2,
      );
      ctx.textAlign = 'left';
    } else {
      // Clip the scroll band so rows slide under its edges while the
      // fractional scroll eases toward its target (like the library).
      ctx.save();
      ctx.beginPath();
      ctx.rect(24, gridTop, W - 48, bandBottom - gridTop);
      ctx.clip();
      const start = Math.max(0, Math.floor(scroll));
      for (let gi = start; gi < items.length; gi++) {
        const item = items[gi];
        const x = 32 + (gi % cols) * (tileW + gap);
        const y = gridTop + (Math.floor(gi / cols) - scroll / cols) * rowPitch;
        if (y >= bandBottom) break; // later rows are even lower
        if (y + tileH <= gridTop) continue; // row sliding out the top
        const cx = x + tileW / 2;
        if (item.kind === 'p') {
          // Photo tile: the cover fills the whole tile and there is NO
          // hover region — the picker navigates folders, never into a photo.
          roundRect(ctx, x, y, tileW, tileH, 12);
          ctx.fillStyle = '#1a2136';
          ctx.fill();
          const img = coverFor(item.p.path);
          if (img) {
            drawCover(img, x, y, tileW, tileH, 12);
          } else {
            ctx.textAlign = 'center';
            ctx.fillStyle = '#5c6584';
            ctx.font = `600 44px ${FONT}`;
            ctx.fillText('📷', cx, y + tileH / 2 + 14);
            ctx.textAlign = 'left';
          }
          ctx.strokeStyle = 'rgba(255,255,255,0.10)';
          ctx.lineWidth = 1;
          roundRect(ctx, x + 0.5, y + 0.5, tileW - 1, tileH - 1, 12);
          ctx.stroke();
          continue;
        }
        const d = item.d;
        const hovered = panel.hoverId === `dir${gi}`;
        roundRect(ctx, x, y, tileW, tileH, 12);
        ctx.fillStyle = hovered ? '#3d4a7a' : '#232a40';
        ctx.fill();
        // The folder that is currently configured gets a gold frame so the
        // picker (which now opens right on top of it) makes that obvious.
        const isCurrent = !!(st && st.current && d.path && samePath(d.path, st.current));
        if (isCurrent) {
          ctx.strokeStyle = '#ffd76a';
          ctx.lineWidth = 3;
          roundRect(ctx, x + 1.5, y + 1.5, tileW - 3, tileH - 3, 11);
          ctx.stroke();
        }
        // Cover band with the folder's first photo (desktop parity); the
        // folder glyph stands in while it loads or when there is no cover.
        const bandX = x + 10, bandY = y + 10, bandW = tileW - 20, bandH = 82;
        roundRect(ctx, bandX, bandY, bandW, bandH, 8);
        ctx.fillStyle = '#1a2136';
        ctx.fill();
        const cover = d.coverPath ? coverFor(d.coverPath) : null;
        if (cover) {
          drawCover(cover, bandX, bandY, bandW, bandH, 8);
        } else {
          ctx.textAlign = 'center';
          ctx.fillStyle = '#8b93ad';
          ctx.font = `600 44px ${FONT}`;
          ctx.fillText('📁', cx, bandY + bandH / 2 + 15);
        }
        // Name + photo-count line (「N 枚」, 「N+ 枚」 once capped); the
        // gold 「設定済み」 badge folds into that same line.
        let bottom = '';
        if (typeof d.photoCount === 'number') {
          bottom = d.capped ? `${d.photoCount}+ 枚` : `${d.photoCount} 枚`;
        }
        if (isCurrent) bottom = bottom ? `設定済み · ${bottom}` : '設定済み';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#e8ecf8';
        ctx.font = `600 26px ${FONT}`;
        ctx.fillText(ellipsize(ctx, d.name || d.path, tileW - 24), cx, bottom ? y + 122 : y + 134);
        if (bottom) {
          ctx.fillStyle = isCurrent ? '#ffd76a' : '#8b93ad';
          ctx.font = `600 20px ${FONT}`;
          ctx.fillText(ellipsize(ctx, bottom, tileW - 24), cx, y + 150);
        }
        ctx.textAlign = 'left';
        regions.push({
          x, y, w: tileW, h: tileH, id: `dir${gi}`, label: '',
          disabled: !!(st && (st.loading || st.busy)),
          onClick: () => this._fpLoad(d.path),
        });
      }
      ctx.restore();
      // Scroll-position hint where the pager used to sit: visible range
      // out of the folder total, so deep lists still convey their size.
      if (items.length > cols * rows) {
        const first = start + 1;
        const last = Math.min(items.length, start + cols * rows);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#8b93ad';
        ctx.font = `600 24px ${FONT}`;
        ctx.fillText(`${first}–${last} / ${items.length} 件`, W / 2, bandBottom + 24);
        ctx.textAlign = 'left';
      }
    }

    // Toast strip, same as the player panel.
    if (this.toast) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd76a';
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText(ellipsize(ctx, this.toast.text, W - 120), W / 2, H - 30);
      ctx.textAlign = 'left';
    }

    ctx.restore();
    panel.setRegions(regions);
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
      case 'variant-changed':
        // The desktop applied (or initially chose) a funscript variant;
        // mirror it so the 🎢 button cycles from the right label again.
        if (typeof msg.label === 'string') {
          this._activeVariant = msg.label;
          this._pendingVariant = null;
          if (this.slideshow) this._rebuildSlideshowScript();
        }
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
    if (this._fp && this.folderPanel) {
      // Folder picker is modal: everything (toasts, sync echoes) paints
      // onto it while it is open, never the hidden control row.
      this.folderPanel.redraw();
      return;
    }
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
      this._activeVariant || '-',
      this._pendingVariant || '-',
      this._frameError || '',
    ].join('|');
  }
}

const app = new VrApp();
app.start().catch((err) => {
  const status = document.getElementById('overlay-status');
  if (status) status.textContent = `初期化に失敗しました: ${err && err.message ? err.message : err}`;
});
