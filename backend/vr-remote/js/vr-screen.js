/**
 * VRScreen — owns the two ways a video can be shown in the headset:
 *
 *   flat   : the existing 16:9 screen quad (MeshBasicMaterial, VideoTexture)
 *   spatial: a BackSide sphere child of the XR camera, sampled through the
 *            equirect / angular-fisheye shaders with per-eye SBS/TB halves
 *
 * The sphere is parented to the camera, so it is always centered on the
 * head; the vertex shader's object-space `normalize(position)` is therefore
 * the gaze direction — no uniforms for head position needed. Per-eye half
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
   */
  constructor(texture) {
    this.texture = texture;

    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.8),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    this.quad.position.set(0, 1.65, -2.6);

    this.sphere = null;
    this.mode = { projection: 'flat', stereo: 'mono', fovDeg: 0 };
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
   * Apply a resolved VR mode ({projection, stereo, fovDeg}). 'flat' tears
   * down the sphere; anything else builds/updates it hidden inside the
   * given camera (head-locked, so its position never matters).
   */
  applyMode(camera, mode) {
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
      this._buildSphere(camera, frag);
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

  _buildSphere(camera, frag) {
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
    // Head-locked: parented to the camera, centered on the head, radius 8 m
    // (inside the 100 m far plane, outside every UI panel).
    this.sphere.position.set(0, 0, 0);
    camera.add(this.sphere);
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
