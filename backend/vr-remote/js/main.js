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
 * Projection modes (equirect/fisheye/SBS) arrive in Phase 3; in-scene
 * search / playlists in Phase 4. Flat videos support the photo slideshow
 * (Phase 2) using the desktop-configured folder and the shared
 * /shared-js/slideshow-timing.js + slideshow-color.js logic.
 */

import * as THREE from '../vendor/three/three.module.js';
import { UIPanel, drawPanelBackground, drawButton, ellipsize, roundRect } from './panel.js';
import { LibraryModel, fetchVideos } from './library.js';
import { VideoPlayer } from './player.js';
import { SlideshowModel, SlideshowRenderer } from './slideshow.js';
import { formatTime } from './util.js';

const FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif';
const SORT_LABELS = { name: '名前', recent: '追加日', duration: '長さ' };
const SORT_CYCLE = ['name', 'recent', 'duration'];

class VrApp {
  constructor() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controllers = [];

    this.mode = 'library';
    this.library = new LibraryModel();
    this.libraryPanel = null;
    this.playerPanel = null;
    this.osdPanel = null;
    this.screenMesh = null;
    this.libraryGroup = null;
    this.playerGroup = null;

    this.player = new VideoPlayer({
      onServerMessage: (msg) => this._onSyncMessage(msg),
      onKicked: () => {
        this._closePlayback('他のデバイスがこのセッションを引き継ぎました');
      },
    });

    this.sync = { connected: false, script: null, devices: [] };
    this.slideshow = null; // { model, renderer, texture } while SS is on
    this._ssScriptCache = new Map(); // scriptUrl → actions[]
    this.toast = null; // { text, until }
    this._hover = null; // { controller, mesh, uv, distance }
    this._osdSig = '';
    this._raycaster = new THREE.Raycaster();
    this._tmpMatrix = new THREE.Matrix4();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._frameError = null; // first frame-loop exception, surfaced on the OSD
    this._osdShown = true; // head-attached OSD visibility gate (see _updateOsdVisibility)
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

      session.addEventListener('end', () => this._exitSession());

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0a0c14);
      this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
      this.scene.add(this.camera);

      // Soft floor grid for spatial grounding.
      const grid = new THREE.GridHelper(12, 24, 0x2a3050, 0x171c2c);
      grid.material.transparent = true;
      grid.material.opacity = 0.5;
      this.scene.add(grid);

      this._buildLibraryPanel();
      this._buildPlayerRig();
      this._buildOsd();
      this._buildControllers();

      this.mode = 'library';
      this._frameError = null;
      this._osdShown = true; // fresh mesh defaults visible; toast keeps it up, loop hides it later
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
    this.renderer.setAnimationLoop(null);
    this._disableSlideshow();
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

    // 16:9 screen quad fed by the VideoTexture.
    const geo = new THREE.PlaneGeometry(3.2, 1.8);
    const mat = new THREE.MeshBasicMaterial({ map: this.player.texture, toneMapped: false });
    this.screenMesh = new THREE.Mesh(geo, mat);
    this.screenMesh.position.set(0, 1.65, -2.6);
    this.playerGroup.add(this.screenMesh);

    this.playerPanel = new UIPanel({ worldWidth: 2.2, pixelWidth: 1200, pixelHeight: 220 });
    this.playerPanel.mesh.position.set(0, 0.72, -2.35);
    this.playerPanel.mesh.rotation.x = 0.25; // tilt up toward the hands
    this.playerPanel.setDraw(() => this._drawPlayerControls());
    this.playerGroup.add(this.playerPanel.mesh);

    this.playerGroup.visible = false;
    this.scene.add(this.playerGroup);
  }

  _buildOsd() {
    // Head-attached: parented to the camera, so it drifts with the gaze.
    this.osdPanel = new UIPanel({ worldWidth: 0.62, pixelWidth: 1024, pixelHeight: 256 });
    this.osdPanel.mesh.position.set(0, -0.22, -0.8);
    this.osdPanel.setDraw(() => this._drawOsd());
    this.camera.add(this.osdPanel.mesh);
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
      controller.addEventListener('selectstart', () => this._select(controller));
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
  // Frame loop: hover raycast + OSD refresh
  // -------------------------------------------------------------------------

  _frame() {
    try {
      this._updateHover();
      if (this.slideshow) this._slideshowTick();
      if (this.toast && Date.now() > this.toast.until) {
        this.toast = null;
        if (this._osdShown) this.osdPanel.redraw();
      }
      this._updateOsdVisibility();
      if (this._osdShown) {
        const sig = this._osdSignature();
        if (sig !== this._osdSig) {
          this._osdSig = sig;
          this.osdPanel.redraw();
        }
      }
    } catch (err) {
      // An exception inside the XR loop otherwise freezes the headset view
      // with zero diagnostics (the last submitted frame just persists).
      // Keep the loop alive and surface the first failure on the OSD.
      if (!this._frameError) {
        this._frameError = `内部エラー: ${err && err.message ? err.message : err}`;
        console.error('[FunSync VR] frame error', err);
      }
    }
    try {
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      if (!this._frameError) {
        this._frameError = `描画エラー: ${err && err.message ? err.message : err}`;
        console.error('[FunSync VR] render error', err);
      }
    }
  }

  _rayFrom(controller) {
    this._tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this._origin.setFromMatrixPosition(controller.matrixWorld);
    this._dir.set(0, 0, -1).applyMatrix4(this._tmpMatrix);
    this._raycaster.ray.origin.copy(this._origin);
    this._raycaster.ray.direction.copy(this._dir);
  }

  _targets() {
    if (this.mode === 'library') return [this.libraryPanel.mesh];
    return [this.playerPanel.mesh, this.screenMesh];
  }

  _updateHover() {
    let best = null;
    for (const controller of this.controllers) {
      this._rayFrom(controller);
      const hits = this._raycaster.intersectObjects(this._targets(), false);
      const hit = hits.length ? hits[0] : null;
      controller.userData.ray.scale.z = hit ? hit.distance : 4;
      if (hit && (!best || hit.distance < best.distance)) {
        best = { controller, mesh: hit.object, uv: hit.uv, distance: hit.distance };
      }
    }

    // Gaze fallback: when no controller ray lands on a target, aim from the
    // head so the UI stays operable even if controller poses are missing or
    // mis-tracked (a real-device failure mode we cannot reproduce locally).
    if (!best && this.camera) {
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
  }

  _select(controller) {
    this._rayFrom(controller);
    let hits = this._raycaster.intersectObjects(this._targets(), false);
    if (!hits.length && this.camera) {
      // Same gaze fallback as hover: if the controller ray missed, select
      // whatever the user is looking at.
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
      panel.activate(hit.uv);
    } else if (hit.object === this.screenMesh) {
      this.player.toggle();
      this.playerPanel.redraw();
      this.osdPanel.redraw();
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
    this.player.open(video);
    this.playerPanel.redraw();
    this.osdPanel.redraw();
  }

  _closePlayback(toastText) {
    this._disableSlideshow();
    this.player.close();
    this.mode = 'library';
    this.sync = { connected: false, script: null, devices: [] };
    this.playerGroup.visible = false;
    this.libraryGroup.visible = true;
    if (toastText) this.toast = { text: toastText, until: Date.now() + 5000 };
    this._redrawLibrary();
    this.osdPanel.redraw();
  }

  _drawLibrary() {
    const { ctx } = this.libraryPanel;
    const W = this.libraryPanel.pixelWidth;
    const H = this.libraryPanel.pixelHeight;
    drawPanelBackground(ctx, W, H);

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

    // Paging buttons last so they paint over rows and win overlapping hits.
    regions.push({ x: 32, y: H - 96, w: 140, h: 64, id: 'prev', label: '◀ 前',
      disabled: view.page === 0,
      onClick: () => { this.library.prevPage(); this._redrawLibrary(); } });
    regions.push({ x: W - 172, y: H - 96, w: 140, h: 64, id: 'next', label: '次 ▶',
      disabled: view.page + 1 >= view.pages,
      onClick: () => { this.library.nextPage(); this._redrawLibrary(); } });

    for (const r of regions) {
      if (r.id.startsWith('video:')) continue; // rows have their own painting
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
    drawPanelBackground(ctx, W, H);

    const playing = !this.player.paused;
    const bw = 178;
    const bh = 120;
    const gap = 16;
    const total = bw * 6 + gap * 5;
    const x0 = (W - total) / 2;
    const y0 = (H - bh) / 2;

    const mk = (i, id, label, onClick, disabled) => ({ x: x0 + i * (bw + gap), y: y0, w: bw, h: bh, id, label, onClick, disabled });
    const regions = [
      mk(0, 'back', '◀ ライブラリ', () => this._closePlayback()),
      mk(1, 'rew', '-10 秒', () => { this.player.seekBy(-10); this.playerPanel.redraw(); }),
      mk(2, 'playpause', playing ? '⏸ 一時停止' : '▶ 再生', () => { this.player.toggle(); this.playerPanel.redraw(); this.osdPanel.redraw(); }),
      mk(3, 'fwd', '+10 秒', () => { this.player.seekBy(10); this.playerPanel.redraw(); }),
      mk(4, 'mute', this.player.muted ? '🔇 ミュート' : '🔊 音声', () => { this.player.toggleMute(); this.playerPanel.redraw(); }),
      mk(5, 'slideshow', this.slideshow ? 'SS 停止' : 'SS 開始',
        () => this._toggleSlideshow(),
        !this._canSlideshow()),
    ];

    for (const r of regions) drawButton(ctx, r, this.playerPanel, { fontSize: 30 });
    this.playerPanel.setRegions(regions);
  }

  // -------------------------------------------------------------------------
  // Slideshow (flat videos, Phase 2)
  // -------------------------------------------------------------------------

  /** SS needs a funscript (switch points) and is a flat-video feature only. */
  _canSlideshow() {
    const v = this.player.info;
    return !!(v && v.hasFunscript && v.manualVRType !== 'vr');
  }

  async _toggleSlideshow() {
    if (this.slideshow) {
      this._disableSlideshow();
      this.playerPanel.redraw();
      this.osdPanel.redraw();
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
        this.osdPanel.redraw();
        return;
      }
      if (!cfg.folderExists) {
        this.toast = { text: 'スライドショーフォルダが見つかりません。', until: Date.now() + 5000 };
        this.osdPanel.redraw();
        return;
      }
      const imgRes = await fetch('/api/remote/slideshow/images', { cache: 'no-store' });
      if (!imgRes.ok) throw new Error(`images ${imgRes.status}`);
      const listing = await imgRes.json();
      if (!Array.isArray(listing.images) || !listing.images.length) {
        this.toast = { text: 'スライドショーフォルダに画像がありません。', until: Date.now() + 5000 };
        this.osdPanel.redraw();
        return;
      }
      const actions = await this._fetchActions(v.scriptUrl);
      if (!actions.length) {
        this.toast = { text: 'FunScript にアクションがありません。', until: Date.now() + 5000 };
        this.osdPanel.redraw();
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
        this.osdPanel.redraw();
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
      this.playerPanel.redraw();
      this.toast = { text: `スライドショー開始（${model.switchTimes.length} 切替・${model.images.length} 枚）`, until: Date.now() + 3500 };
      this.osdPanel.redraw();
    } catch {
      this.toast = { text: 'スライドショーを開始できませんでした。', until: Date.now() + 5000 };
      this.osdPanel.redraw();
    }
  }

  _disableSlideshow() {
    if (!this.slideshow) return;
    this.slideshow.texture.dispose();
    this.slideshow = null;
    if (this.screenMesh) {
      this.screenMesh.material.map = this.player.texture;
      this.screenMesh.material.needsUpdate = true;
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
  // OSD (head-attached status)
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
    this.osdPanel.redraw();
  }

  /**
   * Right-hand OSD status, contextual per mode. In library mode there is no
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

  /**
   * The OSD is head-attached, so leaving it up in library mode is a panel
   * permanently floating in the user's face — the library panel itself
   * already shows count/pagination. Keep it hidden there unless it has
   * something to say (a toast or a frame error); in player mode it carries
   * playback info, so it stays.
   */
  _updateOsdVisibility() {
    const show = this.mode === 'player' || !!this._frameError || !!this.toast;
    if (show === this._osdShown) return;
    this._osdShown = show;
    this.osdPanel.mesh.visible = show;
    if (show) {
      this._osdSig = this._osdSignature();
      this.osdPanel.redraw();
    }
  }

  _osdSignature() {
    const v = this.player.info;
    return [
      v ? v.name : '',
      this.mode,
      this.player.paused ? 'p' : 'r',
      formatTime(this.player.currentTime),
      formatTime(this.player.duration),
      this._syncStatus().text,
      this.sync.script || '-',
      this.slideshow ? 'ss' : '-',
      this.toast ? this.toast.text : '',
      this.player.lastError || '',
      this._frameError || '',
    ].join('|');
  }

  _drawOsd() {
    const { ctx } = this.osdPanel;
    const W = this.osdPanel.pixelWidth;
    const H = this.osdPanel.pixelHeight;
    drawPanelBackground(ctx, W, H, { fill: 'rgba(10, 12, 20, 0.78)' });

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const v = this.player.info;

    if (this._frameError) {
      ctx.fillStyle = '#ff5d5d';
      ctx.font = `600 34px ${FONT}`;
      ctx.fillText(ellipsize(ctx, this._frameError, W - 80), 40, 70);
    } else if (this.toast) {
      ctx.fillStyle = '#ffd76a';
      ctx.font = `600 34px ${FONT}`;
      ctx.fillText(ellipsize(ctx, this.toast.text, W - 80), 40, 70);
    } else if (this.player.lastError) {
      ctx.fillStyle = '#ff7a7a';
      ctx.font = `600 34px ${FONT}`;
      ctx.fillText(ellipsize(ctx, this.player.lastError, W - 80), 40, 70);
    } else if (v) {
      ctx.fillStyle = '#e8ecf8';
      ctx.font = `600 34px ${FONT}`;
      ctx.fillText(ellipsize(ctx, String(v.name || ''), W - 80), 40, 60);
    } else {
      ctx.fillStyle = '#8b93ad';
      ctx.font = `600 34px ${FONT}`;
      ctx.fillText('FunSync VR', 40, 60);
    }

    // Bottom row: time + sync status.
    ctx.font = `28px ${FONT}`;
    if (v) {
      ctx.fillStyle = '#c9d2e8';
      const timeText = `${formatTime(this.player.currentTime)} / ${formatTime(this.player.duration)}`;
      ctx.fillText(timeText, 40, 170);
      if (this.slideshow) {
        ctx.fillStyle = '#7ea2ff';
        ctx.fillText('📷 スライドショー', 40 + ctx.measureText(timeText).width + 24, 170);
      }
    }
    ctx.textAlign = 'right';
    const st = this._syncStatus();
    let right = st.text;
    if (this.sync.script) right = `${right} • ${this.sync.script}`;
    ctx.fillStyle = st.color;
    ctx.fillText(ellipsize(ctx, right, W - 80), W - 40, 170);
  }
}

const app = new VrApp();
app.start().catch((err) => {
  const status = document.getElementById('overlay-status');
  if (status) status.textContent = `初期化に失敗しました: ${err && err.message ? err.message : err}`;
});
