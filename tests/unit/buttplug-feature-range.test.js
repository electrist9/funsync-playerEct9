/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Per-feature output bounds (lower/upper clamp) for Buttplug devices.
//
// Follow-up to the feature-selection work: a device with several features
// (rotate + vibrate, e.g.) now also gets per-feature min/max. Semantics
// are CUTOFF-style hard clamps on the final per-feature value — out-of-
// band values are pinned to the boundary, in-band values pass through
// untouched (NOT a rescale like setDeviceRange).
//
// The clamp lives in buttplug-sync.js: `_featureRangeMap` (deviceIndex →
// {feature: {min,max}}; absent entry = {min:0,max:100} = no-op) applied
// by `_featureClamp()` AFTER the device-level stack (range/cutoff) and
// BEFORE `_applyScalarSafety`, so the Max intensity cap stays absolute.
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

describe('feature bounds — API semantics', () => {
  let sync;

  beforeEach(() => {
    ({ sync } = makeSync([device({ canVibrate: true, canRotate: true })]));
  });

  it('defaults to {min:0, max:100} (no-op) for every feature', () => {
    for (const key of ['linear', 'vibrate', 'scalar', 'oscillate', 'rotate']) {
      expect(sync.getFeatureRange(0, key)).toEqual({ min: 0, max: 100 });
    }
  });

  it('stores and returns per-feature bounds', () => {
    sync.setFeatureRange(0, 'rotate', 10, 40);
    expect(sync.getFeatureRange(0, 'rotate')).toEqual({ min: 10, max: 40 });
    // Other features stay at the no-op default.
    expect(sync.getFeatureRange(0, 'vibrate')).toEqual({ min: 0, max: 100 });
  });

  it('setting the default clears the stored entry', () => {
    sync.setFeatureRange(0, 'rotate', 10, 40);
    sync.setFeatureRange(0, 'rotate', 0, 100);
    expect(sync.getFeatureRange(0, 'rotate')).toEqual({ min: 0, max: 100 });
    expect(sync._featureRangeMap.has(0)).toBe(false);
  });

  it('unknown feature keys are ignored', () => {
    sync.setFeatureRange(0, 'bogus', 10, 40);
    expect(sync._featureRangeMap.size).toBe(0);
    expect(sync.getFeatureRange(0, 'bogus')).toEqual({ min: 0, max: 100 });
  });

  it('clearDeviceState drops stored bounds', () => {
    sync.setFeatureRange(0, 'vibrate', 10, 40);
    sync.clearDeviceState(0);
    expect(sync.getFeatureRange(0, 'vibrate')).toEqual({ min: 0, max: 100 });
  });
});

describe('feature bounds — clamp at send time (_sendToDevices)', () => {
  it('vibrate max caps a hot speed-mode tick', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    // speed mode (default): pos 0→100 in 100ms → 1000 units/s → intensity 100.
    sync.setFeatureRange(0, 'vibrate', 0, 60);
    tick(sync, { pos: 100, prevPos: 0 });
    expect(buttplug.sendVibrate).toHaveBeenCalledWith(0, 60);
  });

  it('vibrate min lifts a cold tick off zero', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    // pos unchanged → speed-mode intensity 0 → pinned up to the floor.
    sync.setFeatureRange(0, 'vibrate', 20, 100);
    tick(sync, { pos: 10, prevPos: 10 });
    expect(buttplug.sendVibrate).toHaveBeenCalledWith(0, 20);
  });

  it('rotate max caps speed-mode intensity and keeps direction', () => {
    const { sync, buttplug } = makeSync([device({ canRotate: true })]);
    sync.setFeatureRange(0, 'rotate', 0, 40);
    tick(sync, { pos: 100, prevPos: 0 });
    expect(buttplug.sendRotate).toHaveBeenCalledWith(0, 40, true);
  });

  it('oscillate max caps speed-mode intensity', () => {
    const { sync, buttplug } = makeSync([device({ canOscillate: true })]);
    // Oscillate devices run the safety chain; neutralize ramp + cap so
    // the assertion isolates the feature bound.
    sync.setRampUp(0, false);
    sync.setMaxIntensity(0, 100);
    sync.setFeatureRange(0, 'oscillate', 0, 50);
    tick(sync, { pos: 100, prevPos: 0 });
    expect(buttplug.sendOscillate).toHaveBeenCalledWith(0, 50);
  });

  it('scalar floor lifts a position-mode value; the safety cap still wins above it', () => {
    const { sync, buttplug } = makeSync([device({ canScalar: true })]);
    sync.setRampUp(0, false); // ramp starts at construction; disable for determinism
    // scalar mode (default 'position'): intensity = pos.
    sync.setFeatureRange(0, 'scalar', 30, 90);
    tick(sync, { pos: 10, prevPos: 10 });
    expect(buttplug.sendScalar).toHaveBeenCalledWith(0, 30);
    // The Max intensity cap (default 70) is applied AFTER the feature
    // floor, so a floor above the cap can never bypass the safety ceiling.
    sync.setFeatureRange(0, 'scalar', 80, 95);
    tick(sync, { pos: 90, prevPos: 90 });
    expect(buttplug.sendScalar).toHaveBeenLastCalledWith(0, 70);
  });

  it('linear bounds clamp the position in the default path', () => {
    const { sync, buttplug } = makeSync([device({ canLinear: true })]);
    sync.setFeatureRange(0, 'linear', 20, 80);
    tick(sync, { pos: 10, prevPos: 10 });
    expect(buttplug.sendLinear).toHaveBeenLastCalledWith(0, 20, 100);
    tick(sync, { pos: 90, prevPos: 90 });
    expect(buttplug.sendLinear).toHaveBeenLastCalledWith(0, 80, 100);
    tick(sync, { pos: 50, prevPos: 50 });
    expect(buttplug.sendLinear).toHaveBeenLastCalledWith(0, 50, 100);
  });

  it('degenerate bounds (min >= max) are a no-op', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    sync.setFeatureRange(0, 'vibrate', 60, 60);
    tick(sync, { pos: 100, prevPos: 0 });
    expect(buttplug.sendVibrate).toHaveBeenCalledWith(0, 100);
    sync.setFeatureRange(0, 'vibrate', 80, 20);
    tick(sync, { pos: 50, prevPos: 0 });
    expect(buttplug.sendVibrate).toHaveBeenLastCalledWith(0, 100);
  });

  it('bounds apply after the device-level cutoff clamp', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    // Device cutoff pins everything into [40,60]; the feature bound then
    // narrows the ceiling further to 50.
    sync.setDeviceCutoff(0, 40, 60);
    sync.setFeatureRange(0, 'vibrate', 0, 50);
    tick(sync, { pos: 100, prevPos: 0 }); // raw intensity 100
    expect(buttplug.sendVibrate).toHaveBeenCalledWith(0, 50);
  });
});

describe('feature bounds — dedicated vib script path', () => {
  it('vib script intensity is pinned up by the vibrate floor', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    sync.setFeatureRange(0, 'vibrate', 20, 80);
    sync._vibActions = [{ at: 0, pos: 10 }, { at: 100, pos: 90 }];
    sync._vibActionIndex = 0;
    sync._lastVibSentIntensity = -1;
    sync._lastVibSendTime = -100000;
    sync._sendPendingVibActions();
    expect(buttplug.sendVibrate).toHaveBeenCalledWith(0, 20);
  });

  it('vib script intensity is capped by the vibrate ceiling', () => {
    const { sync, buttplug } = makeSync([device({ canVibrate: true })]);
    sync.setFeatureRange(0, 'vibrate', 0, 80);
    sync._vibActions = [{ at: 0, pos: 90 }, { at: 100, pos: 10 }];
    sync._vibActionIndex = 0;
    sync._lastVibSentIntensity = -1;
    sync._lastVibSendTime = -100000;
    sync._sendPendingVibActions();
    expect(buttplug.sendVibrate).toHaveBeenCalledWith(0, 80);
  });
});
