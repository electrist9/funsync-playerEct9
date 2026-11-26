/**
 * VRScreen — owns the two ways a video can be shown in the headset:
 *
 *   flat   : the existing 16:9 screen quad (MeshBasicMaterial, VideoTexture)
 *   spatial: a BackSide sphere anchored in WORLD space, sampled through the
 *            equirect / angular-fisheye shaders with per-eye SBS/TB halves
 *
 * The sphere is parented to the (world-fixed) playback group — NOT to the
 * camera — so its orientation never follows the head: turning to look left
 * reveals the left part of the video, exactly like standing inside the
 * scene. Its position is re-centred on the viewer every frame via
 * `recenter()` (kills parallax without reintroducing head-drag). The
 * video's "front" is aligned with the viewer's heading when a mode is
 * applied, so playback always starts facing the action. Per-eye half
 * selection rides on `onBeforeRender`: while rendering an immersive frame
 * three iterates `renderer.xr.getCamera().cameras` and calls the hook with
 * each sub-camera, which we compare by identity.
 *
 * Three.js is imported here (not in vr-shaders.js), keeping shader strings
 * Node-importable.
 */

import * as THREE from '../vendor/three/three.module.js';
import { SPHERE_VERT, EQUIRECT_FRAG, FISHEYE_FRAG } from './vr-shaders.js';

const STEREO_CODE = { mono: 0, sbs: 1, tb: 2 };

export class VRScreen {
  /**
   * @param {THREE.Texture} texture the VideoTexture / CanvasTexture to show
   * @param {THREE.Object3D} parent world-fixed group the surround sphere is
   *   attached to (identity transform — the playback rig's group)
   */
  constructor(texture, parent) {
    this.texture = texture;
    this.parent = parent;

    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.8),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    this.quad.position.set(0, 1.65, -2.6);

    this.sphere = null;
    this.mode = { projection: 'flat', stereo: 'mono', fovDeg: 0 };
    this._tmp = new THREE.Vector3();
  }

  /** Set the shared source texture (video frame or slideshow canvas). */
  setTexture(texture) {
    this.texture = texture;
    this.quad.material.map = texture;
    this.quad.material.needsUpdate = true;
    if (this.sphere) {
      this.sphere.material.uniforms.tDiffuse.value = texture;
    }
  }

  /**
   * Fit the flat quad to a source's aspect ratio (only matters in flat
   * mode; the surround sphere always wraps the full frame). The quad is
   * built 3.2 × 1.8 m (16:9), so a source of any other ratio would be
   * stretched — scale it down one axis instead, centred, keeping the same
   * mid-height position. Called from the video's loadedmetadata event and
   * when the slideshow swaps in its 16:9 canvas.
   */
  setAspect(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0) || !(h > 0)) return;
    const MAX_W = 3.2;
    const MAX_H = 1.8;
    const a = w / h;
    let sw = MAX_W;
    let sh = MAX_W / a;
    if (sh > MAX_H) {
      sh = MAX_H;
      sw = MAX_H * a;
    }
    this.quad.scale.set(sw / MAX_W, sh / MAX_H, 1);
  }

  /**
   * Apply a resolved VR mode ({projection, stereo, fovDeg}). 'flat' tears
   * down the sphere; anything else builds/updates the world-anchored sphere
   * and aligns the video's front with the viewer's current heading (yaw
   * only) so playback always starts facing the action.
   */
  applyMode(renderer, mode) {
    this.mode = mode || { projection: 'flat', stereo: 'mono', fovDeg: 0 };
    const flat = !this.mode.projection || this.mode.projection === 'flat';

    if (flat) {
      this._destroySphere();
      this.quad.visible = true;
      return;
    }

    const equirect = this.mode.projection === 'equirect180' || this.mode.projection === 'equirect360';
    const frag = equirect ? EQUIRECT_FRAG : FISHEYE_FRAG;

    if (this.sphere && this._sphereFrag !== frag) {
      this._destroySphere();
    }
    if (!this.sphere) {
      this._buildSphere(frag);
      this.sphere.rotation.y = this._headYaw(renderer);
    }

    const u = this.sphere.material.uniforms;
    u.tDiffuse.value = this.texture;
    u.uStereo.value = STEREO_CODE[this.mode.stereo] ?? 0;
    if (equirect) {
      u.uLonRange.value = this.mode.projection === 'equirect360' ? Math.PI * 2 : Math.PI;
    } else {
      u.uHalfFov.value = THREE.MathUtils.degToRad((this.mode.fovDeg || 200) / 2);
    }
    this.quad.visible = false;
    this.sphere.visible = true;
  }

  /**
   * Keep the surround sphere centred on the viewer (position only — the
   * orientation stays fixed in the world, so looking around never drags
   * the video along). Call once per frame while an XR session presents.
   */
  recenter(renderer) {
    if (!this.sphere) return;
    try {
      const xrCam = renderer && renderer.xr && renderer.xr.isPresenting
        ? renderer.xr.getCamera()
        : null;
      if (!xrCam) return;
      xrCam.getWorldPosition(this._tmp);
      this.sphere.position.copy(this._tmp);
    } catch {
      // Frame-loop safety: a pose hiccup must never freeze the XR loop.
    }
  }

  /** Viewer's yaw (radians around world Y) from the presenting XR camera. */
  _headYaw(renderer) {
    try {
      const xrCam = renderer && renderer.xr && renderer.xr.isPresenting
        ? renderer.xr.getCamera()
        : null;
      if (!xrCam) return 0;
      const f = xrCam.getWorldDirection(this._tmp);
      const yaw = Math.atan2(-f.x, -f.z);
      return Number.isFinite(yaw) ? yaw : 0;
    } catch {
      return 0;
    }
  }

  _buildSphere(frag) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.texture },
        uStereo: { value: 0 },
        uEye: { value: 0 },
        uLonRange: { value: Math.PI * 2 },
        uHalfFov: { value: THREE.MathUtils.degToRad(100) },
      },
      vertexShader: SPHERE_VERT,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });

    // Per-eye half selection. renderer.xr.getCamera() returns the
    // ArrayCamera; during per-eye rendering the `camera` argument is that
    // eye's sub-camera — identity against cameras[1] means "right/bottom".
    material.onBeforeRender = (renderer, scene, cam) => {
      try {
        const xrCam = renderer.xr.getCamera();
        const sub = xrCam && xrCam.cameras;
        material.uniforms.uEye.value = sub && sub.length >= 2 && cam === sub[1] ? 1 : 0;
      } catch {
        material.uniforms.uEye.value = 0;
      }
    };

    // Coarse tessellation on purpose: the shader maps per-fragment, and the
    // sphere doubles as a raycast target for tap-to-toggle — fewer triangles
    // keep the per-frame raycasts cheap.
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), material);
    this._sphereFrag = frag;
    // World-anchored: parented to the world-fixed playback group, radius
    // 8 m (inside the 100 m far plane, outside every UI panel). Position is
    // a placeholder until the first recenter(); rotation stays fixed after
    // applyMode sets the opening yaw.
    this.sphere.position.set(0, 1.6, 0);
    this.parent.add(this.sphere);
  }

  _destroySphere() {
    if (!this.sphere) return;
    this.sphere.parent?.remove(this.sphere);
    this.sphere.geometry.dispose();
    this.sphere.material.dispose();
    this.sphere = null;
    this._sphereFrag = null;
  }

  dispose() {
    this._destroySphere();
    this.quad.geometry.dispose();
    this.quad.material.dispose();
  }
}
