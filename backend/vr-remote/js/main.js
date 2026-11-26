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
 * search / playlists / slideshow in Phases 2 & 4.
 */

import * as THREE from '../vendor/three/three.module.js';
import { UIPanel, drawPanelBackground, drawButton, ellipsize, roundRect } from './panel.js';
import { LibraryModel, fetchVideos } from './library.js';
import { VideoPlayer } from './player.js';
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
    this.toast = null; // { text, until }
    this._hover = null; // { controller, mesh, uv, distance }
    this._osdSig = '';
    this._raycaster = new THREE.Raycaster();
    this._tmpMatrix = new THREE.Matrix4();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
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
    this._refreshLibrary(true);

    this.renderer.setAnimationLoop(() => this._frame());
  }

  _exitSession() {
    this.renderer.setAnimationLoop(null);
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

    this.playerPanel = new UIPanel({ worldWidth: 2.2, pixelWidth: 1100, pixelHeight: 220 });
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
    this._updateHover();
    if (this.toast && Date.now() > this.toast.until) {
      this.toast = null;
      this.osdPanel.redraw();
    }
    const sig = this._osdSignature();
    if (sig !== this._osdSig) {
      this._osdSig = sig;
      this.osdPanel.redraw();
    }
    this.renderer.render(this.scene, this.camera);
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
    const hits = this._raycaster.intersectObjects(this._targets(), false);
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
    this.mode = 'player';
    this.libraryGroup.visible = false;
    this.playerGroup.visible = true;
    this.player.open(video);
    this.playerPanel.redraw();
    this.osdPanel.redraw();
  }

  _closePlayback(toastText) {
    this.player.close();
    this.mode = 'library';
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
    const bw = 190;
    const bh = 120;
    const gap = 18;
    const total = bw * 5 + gap * 4;
    const x0 = (W - total) / 2;
    const y0 = (H - bh) / 2;

    const mk = (i, id, label, onClick, disabled) => ({ x: x0 + i * (bw + gap), y: y0, w: bw, h: bh, id, label, onClick, disabled });
    const regions = [
      mk(0, 'back', '◀ ライブラリ', () => this._closePlayback()),
      mk(1, 'rew', '-10 秒', () => { this.player.seekBy(-10); this.playerPanel.redraw(); }),
      mk(2, 'playpause', playing ? '⏸ 一時停止' : '▶ 再生', () => { this.player.toggle(); this.playerPanel.redraw(); this.osdPanel.redraw(); }),
      mk(3, 'fwd', '+10 秒', () => { this.player.seekBy(10); this.playerPanel.redraw(); }),
      mk(4, 'mute', this.player.muted ? '🔇 ミュート' : '🔊 音声', () => { this.player.toggleMute(); this.playerPanel.redraw(); }),
    ];

    for (const r of regions) drawButton(ctx, r, this.playerPanel, { fontSize: 30 });
    this.playerPanel.setRegions(regions);
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

  _osdSignature() {
    const v = this.player.info;
    return [
      v ? v.name : '',
      this.mode,
      this.player.paused ? 'p' : 'r',
      formatTime(this.player.currentTime),
      formatTime(this.player.duration),
      this.sync.connected ? 'c' : '-',
      this.sync.script || '-',
      this.sync.devices.map((d) => d.label).join(','),
      this.toast ? this.toast.text : '',
      this.player.lastError || '',
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

    if (this.toast) {
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
      ctx.fillText(`${formatTime(this.player.currentTime)} / ${formatTime(this.player.duration)}`, 40, 170);
    }
    ctx.textAlign = 'right';
    let right = '';
    if (!this.sync.connected) right = 'デスクトップ未接続';
    else if (this.sync.devices.length) right = `デバイス: ${this.sync.devices.map((d) => d.label).join(', ')}`;
    else right = 'デバイスなし';
    if (this.sync.script) right = `${right} • ${this.sync.script}`;
    ctx.fillStyle = this.sync.connected ? '#7ed98a' : '#ff9d6a';
    ctx.fillText(ellipsize(ctx, right, W - 80), W - 40, 170);
  }
}

const app = new VrApp();
app.start().catch((err) => {
  const status = document.getElementById('overlay-status');
  if (status) status.textContent = `初期化に失敗しました: ${err && err.message ? err.message : err}`;
});
