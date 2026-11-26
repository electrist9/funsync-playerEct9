/**
 * GLSL sources for VR projection on a world-anchored surround sphere — plain
 * strings only (no three import) so Node tests can lint/scan them. Used by
 * vr-screen.js.
 *
 * The sphere lives in world space: its position is re-centred on the viewer
 * every frame (so there is no parallax), but its orientation is FIXED — the
 * object-space vertex direction is therefore a world-fixed view direction.
 * Turning the head looks around the video instead of dragging it along, and
 * no head-position uniforms are needed.
 * Per-eye half selection (SBS/TB) uses `uEye`, set from `onBeforeRender` in
 * vr-screen.js (three renders ArrayCamera eyes one by one, calling the hook
 * with each sub-camera).
 *
 * Texture V convention: the VideoTexture uploads with three's default
 * flipY=true, so the TOP row of the source frame sits at v = 1 — the same
 * convention as the desktop equirect.frag (v = lat/π + 0.5), whose upload
 * also sets UNPACK_FLIP_Y_WEBGL.
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
 * outside maps to black behind the viewer). v grows with pitch so the
 * zenith samples the top of the source frame (v = 0.5 + pitch/π).
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
  float v = 0.5 + pitch / 3.141592653589793;
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    #include <colorspace_fragment>
    return;
  }

  if (uStereo > 1.5) {
    // TB: the source's TOP half belongs to the left eye — eye 0 samples
    // v ∈ [0.5, 1], eye 1 samples the bottom half.
    v = (v + (1.0 - uEye)) * 0.5;
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
  // +cos puts world-up on the TOP of the source frame (flipY upload).
  float u = 0.5 + 0.5 * r * sin(psi);
  float v = 0.5 + 0.5 * r * cos(psi);

  if (uStereo > 1.5) {
    // TB: top half of the frame is the left eye (eye 0).
    v = (v + (1.0 - uEye)) * 0.5;
  } else if (uStereo > 0.5) {
    u = (u + uEye) * 0.5;
  }

  gl_FragColor = texture2D(tDiffuse, vec2(u, v));
  #include <colorspace_fragment>
}
`;
