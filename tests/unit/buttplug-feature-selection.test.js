/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Per-device feature selection.
//
// User report 2026-11: a Buttplug device exposing SEVERAL features
// (rotate + vibrate, e.g. JoyHub Mirage 3: Vibrate + Rotate + E-Stim)
// was driven on ALL of them from one FunScript source. The user wants
// "rotation only" / "vibration only" control.
//
// The gate lives in buttplug-sync.js: `_featureMap` (deviceIndex →
// {linear, vibrate, scalar, oscillate, rotate}; absent entry = all on)
// checked by `_featureOn()` in every funscript-driven send branch.
// Temperature/Spray are manual-only and never routed from a script,
// so they are not part of the feature set at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

function device(overrides = {}) {
  return {
    index: 0,
    name: 'Multi Feature Device',
    canLinear: false,
    canVibrate: false,
    canRotate: false,
    canScalar: false,
    canOscillate: false,
    ...overrides,
  };
}

function makeSync(devices) {
  const buttplug = {
    connected: true,
    devices,
    sendLinear: vi.fn(),
    sendVibrate: vi.fn(),
    sendRotate: vi.fn(),
    sendScalar: vi.fn(),
    sendOscillate: vi.fn(),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
  const sync = new ButtplugSync({
    buttplugManager: buttplug,
    videoPlayer: { video: { addEventListener: vi.fn(), removeEventListener: vi.fn() }, currentTime: 0, paused: true },
    funscriptEngine: { isLoaded: true, getActions: () => [] },
  });
  return { sync, buttplug };
}

/** Drive one dispatch tick directly, bypassing the scheduler. */
function tick(sync, { pos, prevPos, durationMs = 100 }) {
  sync._sendToDevices(pos, durationMs, prevPos, { sinceLastMs: durationMs });
}

describe('feature selection — vibrate + rotate device', () => {
  let sync, buttplug, devices;

  beforeEach(() => {
    devices = [device({ canVibrate: true, canRotate: true })];
    ({ sync, buttplug } = makeSync(devices));
  });

  it('drives every feature by default (the reported bug baseline)', () => {
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendVibrate).toHaveBeenCalled();
    expect(buttplug.sendRotate).toHaveBeenCalled();
  });

  it('rotate disabled → vibrate only', () => {
    sync.setFeatureEnabled(0, 'rotate', false);
    buttplug.sendRotate.mockClear(); // the toggle itself zeroes the running output
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendVibrate).toHaveBeenCalled();
    expect(buttplug.sendRotate).not.toHaveBeenCalled();
  });

  it('vibrate disabled → rotate only', () => {
    sync.setFeatureEnabled(0, 'vibrate', false);
    buttplug.sendVibrate.mockClear(); // the toggle itself zeroes the running output
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendRotate).toHaveBeenCalled();
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();
  });

  it('both disabled → device stays silent', () => {
    sync.setFeatureEnabled(0, 'vibrate', false);
    sync.setFeatureEnabled(0, 'rotate', false);
    buttplug.sendVibrate.mockClear(); // the toggles themselves zeroed the outputs
    buttplug.sendRotate.mockClear();
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();
    expect(buttplug.sendRotate).not.toHaveBeenCalled();
  });

  it('re-enabling restores the branch', () => {
    sync.setFeatureEnabled(0, 'rotate', false);
    sync.setFeatureEnabled(0, 'rotate', true);
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendRotate).toHaveBeenCalled();
  });

  it('feature flags are per-device, not global', () => {
    devices.push(device({ index: 1, name: 'Second Device', canVibrate: true, canRotate: true }));
    sync.setFeatureEnabled(0, 'rotate', false);
    buttplug.sendRotate.mockClear(); // the toggle itself zeroes device 0's rotate
    tick(sync, { pos: 50, prevPos: 30 });
    // Device 0: vibrate only. Device 1: untouched → both.
    expect(buttplug.sendRotate).toHaveBeenCalledTimes(1);
    expect(buttplug.sendRotate.mock.calls[0][0]).toBe(1);
    expect(buttplug.sendVibrate).toHaveBeenCalledTimes(2);
  });
});

describe('feature selection — linear + vibrate device', () => {
  let sync, buttplug, devices;

  beforeEach(() => {
    devices = [device({ name: 'Hybrid Stroker', canLinear: true, canVibrate: true })];
    ({ sync, buttplug } = makeSync(devices));
  });

  it('linear disabled → no LinearCmd from either linear path, vibrate still fires', () => {
    sync.setFeatureEnabled(0, 'linear', false);
    tick(sync, { pos: 50, prevPos: 30, durationMs: 100 });
    sync._sendLinearToDevices(50, 100, 30);
    expect(buttplug.sendLinear).not.toHaveBeenCalled();
    expect(buttplug.sendVibrate).toHaveBeenCalled();
  });

  it('linear enabled (default) → LinearCmd flows', () => {
    tick(sync, { pos: 50, prevPos: 30, durationMs: 100 });
    expect(buttplug.sendLinear).toHaveBeenCalled();
  });
});

describe('feature selection — oscillate precedence interaction', () => {
  it('vibrate+oscillate: oscillate wins by default; disabling oscillate hands the motor to vibrate', () => {
    const devices = [device({ name: 'Hismith Combo', canVibrate: true, canOscillate: true })];
    const { sync, buttplug } = makeSync(devices);
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendOscillate).toHaveBeenCalled();
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();

    sync.setFeatureEnabled(0, 'oscillate', false);
    buttplug.sendOscillate.mockClear(); // the toggle itself zeroes the running output
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendOscillate).not.toHaveBeenCalled();
    expect(buttplug.sendVibrate).toHaveBeenCalled();
  });
});

describe('feature selection — scalar (e-stim)', () => {
  it('vibrate+scalar: scalar disabled → vibrate only', () => {
    const devices = [device({ name: 'Gigamesh', canVibrate: true, canScalar: true })];
    const { sync, buttplug } = makeSync(devices);
    sync._rampUpMap.set(0, false); // avoid ramp factor ~0 masking the send
    tick(sync, { pos: 50, prevPos: 30 });
    expect(buttplug.sendScalar).toHaveBeenCalled();
    expect(buttplug.sendVibrate).toHaveBeenCalled();

    sync.setFeatureEnabled(0, 'scalar', false);
    buttplug.sendScalar.mockClear();
    tick(sync, { pos: 70, prevPos: 50 });
    expect(buttplug.sendScalar).not.toHaveBeenCalled();
    expect(buttplug.sendVibrate).toHaveBeenCalled();
  });
});

describe('feature selection — dedicated vib script path', () => {
  it('scalar disabled → vib script drives vibrate but never scalar', () => {
    const devices = [device({ name: 'Gigamesh', canVibrate: true, canScalar: true })];
    const { sync, buttplug } = makeSync(devices);
    sync._rampUpMap.set(0, false);
    sync.setVibrationActions([{ at: 0, pos: 50 }, { at: 1000, pos: 80 }]);
    sync.setFeatureEnabled(0, 'scalar', false);
    buttplug.sendScalar.mockClear(); // the toggle zeroed it
    buttplug.sendVibrate.mockClear();

    sync._lastVibSendTime = -100000;
    sync._lastVibSentIntensity = -1;
    sync._sendPendingVibActions();
    expect(buttplug.sendVibrate).toHaveBeenCalled();
    expect(buttplug.sendScalar).not.toHaveBeenCalled();
  });
});

describe('feature selection — API contract', () => {
  it('getFeatures returns all five keys, all true by default', () => {
    const { sync } = makeSync([device({ canVibrate: true })]);
    expect(sync.getFeatures(0)).toEqual({
      linear: true, vibrate: true, scalar: true, oscillate: true, rotate: true,
    });
  });

  it('unknown feature keys are rejected — no map entry, no command', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    sync.setFeatureEnabled(0, 'heat', false);
    sync.setFeatureEnabled(0, 'spray', false);
    expect(sync.getFeatures(0).vibrate).toBe(true);
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();
  });

  it('disabling a sustained feature zeroes it immediately', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true, canRotate: true, canOscillate: true, canScalar: true })]);
    sync.setFeatureEnabled(0, 'vibrate', false);
    expect(buttplug.sendVibrate).toHaveBeenCalledWith(0, 0);
    sync.setFeatureEnabled(0, 'rotate', false);
    expect(buttplug.sendRotate).toHaveBeenCalledWith(0, 0, true);
    sync.setFeatureEnabled(0, 'oscillate', false);
    expect(buttplug.sendOscillate).toHaveBeenCalledWith(0, 0);
    sync.setFeatureEnabled(0, 'scalar', false);
    expect(buttplug.sendScalar).toHaveBeenCalledWith(0, 0);
  });

  it('disabling linear sends NO zero command — position 0 would slam the stroker to the bottom', () => {
    const { sync, buttplug } = makeSync([device({ canLinear: true })]);
    sync.setFeatureEnabled(0, 'linear', false);
    expect(buttplug.sendLinear).not.toHaveBeenCalled();
    expect(sync.getFeatureEnabled(0, 'linear')).toBe(false);
  });

  it('no zero command while disconnected', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    buttplug.connected = false;
    sync.setFeatureEnabled(0, 'vibrate', false);
    expect(buttplug.sendVibrate).not.toHaveBeenCalled();
    expect(sync.getFeatureEnabled(0, 'vibrate')).toBe(false);
  });

  it('clearDeviceState drops feature selections — a recycled index starts all-on', () => {
    const { sync } = makeSync([device({ canVibrate: true, canRotate: true })]);
    sync.setFeatureEnabled(0, 'rotate', false);
    expect(sync.getFeatureEnabled(0, 'rotate')).toBe(false);
    sync.clearDeviceState(0);
    expect(sync.getFeatureEnabled(0, 'rotate')).toBe(true);
  });
});
