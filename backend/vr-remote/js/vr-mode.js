/**
 * VR projection mode resolution — pure, DOM-free, importable from Node
 * tests. Consumes the `vrFormat` field the backend computes per video
 * (`/api/remote/videos` → `detect_vr_format_for_video`), so the studio-code
 * tables never get duplicated here.
 *
 * Backend screen vocab: 'flat' | 'dome' | 'sphere' | 'fisheye' | 'mkx200'
 * | 'mkx220' | 'rf52'. Stereo vocab: 'sbs' | 'tb' | 'off'.
 */

/** Override cycle for the in-headset projection button. */
export const OVERRIDE_CYCLE = ['auto', 'flat', 'eq-sbs', 'eq-tb', 'fe-sbs', 'fe-tb'];

export function nextOverride(current) {
  const i = OVERRIDE_CYCLE.indexOf(current);
  return OVERRIDE_CYCLE[(i + 1) % OVERRIDE_CYCLE.length];
}

/** Fisheye source fields of view in degrees, by backend screen type. */
export const FISHEYE_FOV = {
  fisheye: 200,
  mkx200: 200,
  mkx220: 220,
  rf52: 190,
};

/**
 * Resolve a video record + manual override into a render mode.
 *
 * @param {{vrFormat?: {screen: string, stereo: string, is3d: boolean}}} video
 * @param {string} override one of OVERRIDE_CYCLE; 'auto' trusts vrFormat.
 * @returns {{projection: 'flat'|'equirect180'|'equirect360'|'fisheye',
 *            stereo: 'mono'|'sbs'|'tb', fovDeg: number, source: string}}
 */
export function resolveVRMode(video, override = 'auto') {
  if (override && override !== 'auto') {
    switch (override) {
      case 'flat':
        return { projection: 'flat', stereo: 'mono', fovDeg: 0, source: 'override' };
      case 'eq-sbs':
        return { projection: 'equirect180', stereo: 'sbs', fovDeg: 180, source: 'override' };
      case 'eq-tb':
        return { projection: 'equirect180', stereo: 'tb', fovDeg: 180, source: 'override' };
      case 'fe-sbs':
        return { projection: 'fisheye', stereo: 'sbs', fovDeg: 200, source: 'override' };
      case 'fe-tb':
        return { projection: 'fisheye', stereo: 'tb', fovDeg: 200, source: 'override' };
      default:
        break; // unknown override → fall through to auto
    }
  }

  const f = video && video.vrFormat;
  if (!f || !f.screen || f.screen === 'flat') {
    return { projection: 'flat', stereo: 'mono', fovDeg: 0, source: 'auto' };
  }

  let projection = 'flat';
  let fovDeg = 0;
  switch (f.screen) {
    case 'dome':
      projection = 'equirect180';
      fovDeg = 180;
      break;
    case 'sphere':
      projection = 'equirect360';
      fovDeg = 360;
      break;
    case 'fisheye':
    case 'mkx200':
    case 'mkx220':
    case 'rf52':
      projection = 'fisheye';
      fovDeg = FISHEYE_FOV[f.screen] || 200;
      break;
    default:
      return { projection: 'flat', stereo: 'mono', fovDeg: 0, source: 'auto' };
  }

  // Stereo: trust 'sbs'/'tb'. 'off' normally means mono (e.g. `mono180`),
  // but the desktop player still applies SBS-half for tagged-3D nonplanar
  // formats whose token has no stereo suffix, so mirror that when is3d.
  let stereo = 'mono';
  if (f.stereo === 'sbs' || f.stereo === 'tb') {
    stereo = f.stereo;
  } else if (f.is3d) {
    stereo = 'sbs';
  }

  return { projection, stereo, fovDeg, source: 'auto' };
}

/** Short Japanese label for OSD/toasts, e.g. '魚眼200° SBS'. */
export function modeLabel(mode) {
  if (!mode || mode.projection === 'flat') return '平面';
  const proj = mode.projection === 'fisheye' ? `魚眼${mode.fovDeg}°`
    : mode.projection === 'equirect360' ? '等距円筒360°'
    : '等距円筒180°';
  const stereo = mode.stereo === 'sbs' ? ' SBS' : mode.stereo === 'tb' ? ' TB' : ' モノ';
  return proj + stereo;
}

/** Short label for the player control button (fits a small canvas cell).
 *  The resolved auto-mode is shown separately on the OSD / toast. */
export function overrideButtonLabel(override) {
  if (override === 'auto') return '投影: 自動';
  const idx = OVERRIDE_CYCLE.indexOf(override);
  const names = ['', '平面', 'EqSBS', 'EqTB', '魚眼SBS', '魚眼TB'];
  return `投影: ${names[idx] || override}`;
}
