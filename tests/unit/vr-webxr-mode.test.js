/**
 * Unit tests for the VR projection-mode resolver
 * (backend/vr-remote/js/vr-mode.js). Pure/DOM-free by design.
 */

import { describe, expect, it } from 'vitest';
import {
  OVERRIDE_CYCLE,
  nextOverride,
  FISHEYE_FOV,
  resolveVRMode,
  modeLabel,
  overrideButtonLabel,
} from '../../backend/vr-remote/js/vr-mode.js';

const fmt = (screen, stereo, is3d = true) => ({ vrFormat: { screen, stereo, is3d } });

describe('resolveVRMode (auto)', () => {
  it('defaults to flat when the record has no vrFormat', () => {
    expect(resolveVRMode({})).toEqual({ projection: 'flat', stereo: 'mono', fovDeg: 0, source: 'auto' });
    expect(resolveVRMode(fmt('flat', 'off', false)))
      .toEqual({ projection: 'flat', stereo: 'mono', fovDeg: 0, source: 'auto' });
  });

  it('maps dome → equirect180 and sphere → equirect360', () => {
    expect(resolveVRMode(fmt('dome', 'sbs')))
      .toEqual({ projection: 'equirect180', stereo: 'sbs', fovDeg: 180, source: 'auto' });
    expect(resolveVRMode(fmt('sphere', 'sbs')))
      .toEqual({ projection: 'equirect360', stereo: 'sbs', fovDeg: 360, source: 'auto' });
  });

  it('maps the fisheye family to angular fov degrees', () => {
    for (const [screen, fov] of Object.entries(FISHEYE_FOV)) {
      expect(resolveVRMode(fmt(screen, 'sbs')).projection).toBe('fisheye');
      expect(resolveVRMode(fmt(screen, 'sbs')).fovDeg).toBe(fov);
    }
    expect(resolveVRMode(fmt('mkx220', 'tb'))).toEqual({ projection: 'fisheye', stereo: 'tb', fovDeg: 220, source: 'auto' });
  });

  it('keeps mono180-style tagged mono as mono', () => {
    const mode = resolveVRMode(fmt('dome', 'off', false));
    expect(mode.stereo).toBe('mono');
    expect(mode.projection).toBe('equirect180');
  });

  it('promotes off + is3d to sbs (mirrors desktop SBS-half for nonplanar 3D)', () => {
    const mode = resolveVRMode(fmt('mkx200', 'off', true));
    expect(mode.stereo).toBe('sbs');
  });

  it('treats an unknown screen type as flat', () => {
    expect(resolveVRMode(fmt('pyramid', 'sbs')))
      .toEqual({ projection: 'flat', stereo: 'mono', fovDeg: 0, source: 'auto' });
  });
});

describe('resolveVRMode (manual override)', () => {
  it('forces each override regardless of vrFormat', () => {
    const flat = fmt('flat', 'off', false);
    expect(resolveVRMode(flat, 'eq-sbs')).toEqual({ projection: 'equirect180', stereo: 'sbs', fovDeg: 180, source: 'override' });
    expect(resolveVRMode(flat, 'eq-tb').stereo).toBe('tb');
    expect(resolveVRMode(flat, 'fe-tb')).toEqual({ projection: 'fisheye', stereo: 'tb', fovDeg: 200, source: 'override' });
    const vr = fmt('dome', 'sbs');
    expect(resolveVRMode(vr, 'flat')).toEqual({ projection: 'flat', stereo: 'mono', fovDeg: 0, source: 'override' });
  });

  it('falls through to auto for an unknown override string', () => {
    expect(resolveVRMode(fmt('dome', 'tb'), 'nonsense').source).toBe('auto');
  });
});

describe('nextOverride', () => {
  it('walks the full cycle and wraps around', () => {
    let o = 'auto';
    const seen = [];
    for (let i = 0; i < OVERRIDE_CYCLE.length; i++) {
      o = nextOverride(o);
      seen.push(o);
    }
    expect(seen).toEqual(['flat', 'eq-sbs', 'eq-tb', 'fe-sbs', 'fe-tb', 'auto']);
  });

  it('restarts at auto for an unknown value', () => {
    expect(nextOverride('???')).toBe('auto');
  });
});

describe('labels', () => {
  it('modeLabel renders Japanese projection names with stereo suffix', () => {
    expect(modeLabel({ projection: 'flat' })).toBe('平面');
    expect(modeLabel({ projection: 'fisheye', fovDeg: 200, stereo: 'sbs' })).toBe('魚眼200° SBS');
    expect(modeLabel({ projection: 'equirect180', stereo: 'tb' })).toBe('等距円筒180° TB');
    expect(modeLabel({ projection: 'equirect360', stereo: 'mono' })).toBe('等距円筒360° モノ');
  });

  it('overrideButtonLabel stays short', () => {
    expect(overrideButtonLabel('auto')).toBe('投影: 自動');
    expect(overrideButtonLabel('fe-sbs')).toBe('投影: 魚眼SBS');
  });
});
