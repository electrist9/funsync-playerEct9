/**
 * GLSL sources for VR projection on a head-centered sphere — plain strings
 * only (no three import) so Node tests can lint/scan them. Used by
 * vr-screen.js.
 *
 * The sphere mesh is a child of the XR camera with constant radius, so the
 * object-space vertex position IS the view direction: `vDir` needs no
 * uniform. Per-eye half selection (SBS/TB) uses `uEye`, set from
 * `onBeforeRender` in vr-screen.js (three renders ArrayCamera eyes one by
 * one, calling onBeforeRender with each sub-camera).
 */

/** Sphere vertex: pass the normalized look direction through. */
export const SPHERE_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Stereo codes shared with vr-mode.js consumers:
//   uStereo: 0 = mono, 1 = side-by-side, 2 = top-bottom
//   uEye:    0 = left/top half, 1 = right/bottom half

/**
 * Equirectangular: yaw from atan2(x, -z), pitch from asin(y).
 * uLonRange = 2π for 360°, π for 180° (front hemisphere only; anything
 * outside maps to black behind the viewer).
 */
export const EQUIRECT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uStereo;
uniform float uEye;
uniform float uLonRange;

varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float yaw = atan(d.x, -d.z);
  float pitch = asin(clamp(d.y, -1.0, 1.0));

  float u = 0.5 + yaw / uLonRange;
  float v = 0.5 - pitch / 3.141592653589793;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    #include <colorspace_fragment>
    return;
  }

  if (uStereo > 1.5) {
    // TB: each eye owns the top (eye 0) or bottom (eye 1) half.
    v = (v + uEye) * 0.5;
  } else if (uStereo > 0.5) {
    // SBS: each eye owns the left (eye 0) or right (eye 1) half.
    u = (u + uEye) * 0.5;
  }

  gl_FragColor = texture2D(tDiffuse, vec2(u, v));
  #include <colorspace_fragment>
}
`;

/**
 * Angular fisheye (MKX200/MKX220/RF52): polar around the lens forward axis
 * F = (0, 0, -1). θ = acos(dot(d, F)) maps [0, halfFov] onto the inscribed
 * circle of the eye half; ψ = atan2(x, y) is the image-space angle with +y
 * treated as image-up.
 */
export const FISHEYE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uStereo;
uniform float uEye;
uniform float uHalfFov;

varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float cosTheta = clamp(dot(d, vec3(0.0, 0.0, -1.0)), -1.0, 1.0);
  float theta = acos(cosTheta);
  if (theta > uHalfFov) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    #include <colorspace_fragment>
    return;
  }

  float psi = atan(d.x, d.y);
  float r = theta / uHalfFov;

  // Sample inside a unit square first, then squash into the eye's half.
  float u = 0.5 + 0.5 * r * sin(psi);
  float v = 0.5 - 0.5 * r * cos(psi);

  if (uStereo > 1.5) {
    v = (v + uEye) * 0.5;
  } else if (uStereo > 0.5) {
    u = (u + uEye) * 0.5;
  }

  gl_FragColor = texture2D(tDiffuse, vec2(u, v));
  #include <colorspace_fragment>
}
`;
