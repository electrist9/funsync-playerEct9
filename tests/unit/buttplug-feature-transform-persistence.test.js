/**
 * @vitest-environment node
 * No DOM required — mirrors the persistence blocks of connection-panel.js
 * against a real ButtplugSync instance (same pattern as
 * custom-routing.test.js's loader mirror).
 */
// Regression for the "range-only feature transform reloads as a cutoff"
// bug: `_saveButtplugDeviceSettings` used to persist `featureRanges`
// WITHOUT `featureCutoffs` when only ranges were set. The loader's
// pre-split migration heuristic (`!saved.featureCutoffs &&
// !!saved.featureRanges`) then misread that shape as legacy clamp data
// and re-applied the range values via `setFeatureCutoff` — so after an
// app restart the feature Range showed up in the Limits (cutoff) editor.
//
// The fix: the save writes BOTH keys whenever either kind is
// non-default, so an absent `featureCutoffs` key reliably marks a
// genuinely pre-split save and the legacy migration stays intact.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ButtplugSync } from '../../renderer/js/buttplug-sync.js';

const FEATURE_KEYS = ['linear', 'vibrate', 'scalar', 'oscillate', 'rotate'];

function makeSync() {
  const buttplug = {
    connected: true,
    devices: [{
      index: 0,
      name: 'Dev',
      canLinear: false,
      canVibrate: true,
      canRotate: false,
      canScalar: false,
      canOscillate: false,
    }],
    sendLinear: vi.fn(),
    sendVibrate: vi.fn(),
    sendRotate: vi.fn(),
    sendScalar: vi.fn(),
    sendOscillate: vi.fn(),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
  return new ButtplugSync({
    buttplugManager: buttplug,
    videoPlayer: { video: { addEventListener: vi.fn(), removeEventListener: vi.fn() }, currentTime: 0, paused: true },
    funscriptEngine: { isLoaded: true, getActions: () => [] },
  });
}

/** Mirrors the feature-transform block of `_saveButtplugDeviceSettings`. */
function saveFeatureTransforms(sync, devIndex) {
  const settings = {};
  const featureRanges = {};
  const featureCutoffs = {};
  let anyFeatureRange = false;
  let anyFeatureCutoff = false;
  for (const key of FEATURE_KEYS) {
    const fr = sync.getFeatureRange(devIndex, key);
    if (fr.min !== 0 || fr.max !== 100) {
      featureRanges[key] = { min: fr.min, max: fr.max };
      anyFeatureRange = true;
    }
    const fc = sync.getFeatureCutoff(devIndex, key);
    if (fc.min !== 0 || fc.max !== 100) {
      featureCutoffs[key] = { min: fc.min, max: fc.max };
      anyFeatureCutoff = true;
    }
  }
  if (anyFeatureRange || anyFeatureCutoff) {
    settings.featureRanges = featureRanges;
    settings.featureCutoffs = featureCutoffs;
  }
  return settings;
}

/** Mirrors the feature-transform block of `_loadButtplugDeviceSettings`. */
function loadFeatureTransforms(sync, devIndex, saved) {
  const legacyClipsOnly = !saved.featureCutoffs && !!saved.featureRanges;
  if (saved.featureCutoffs && typeof saved.featureCutoffs === 'object') {
    for (const [key, fc] of Object.entries(saved.featureCutoffs)) {
      if (fc && Number.isFinite(fc.min) && Number.isFinite(fc.max)) {
        sync.setFeatureCutoff(devIndex, key, fc.min, fc.max);
      }
    }
  }
  if (saved.featureRanges && typeof saved.featureRanges === 'object') {
    for (const [key, fr] of Object.entries(saved.featureRanges)) {
      if (fr && Number.isFinite(fr.min) && Number.isFinite(fr.max)) {
        if (legacyClipsOnly) sync.setFeatureCutoff(devIndex, key, fr.min, fr.max);
        else sync.setFeatureRange(devIndex, key, fr.min, fr.max);
      }
    }
  }
}

describe('feature transform persistence round-trip', () => {
  it('range-only settings survive a save→restart→load as RANGE, not cutoff', () => {
    const sync = makeSync();
    sync.setFeatureRange(0, 'vibrate', 20, 80);

    const saved = saveFeatureTransforms(sync, 0);
    // The save-side invariant: whenever featureRanges is written,
    // featureCutoffs is present too (even `{}`) as the format marker.
    expect(saved.featureRanges).toEqual({ vibrate: { min: 20, max: 80 } });
    expect(saved.featureCutoffs).toEqual({});

    const reloaded = makeSync();
    loadFeatureTransforms(reloaded, 0, saved);
    expect(reloaded.getFeatureRange(0, 'vibrate')).toEqual({ min: 20, max: 80 });
    expect(reloaded.getFeatureCutoff(0, 'vibrate')).toEqual({ min: 0, max: 100 });
  });

  it('cutoff-only settings round-trip as cutoff', () => {
    const sync = makeSync();
    sync.setFeatureCutoff(0, 'rotate', 10, 60);

    const saved = saveFeatureTransforms(sync, 0);
    expect(saved.featureCutoffs).toEqual({ rotate: { min: 10, max: 60 } });
    expect(saved.featureRanges).toEqual({});

    const reloaded = makeSync();
    loadFeatureTransforms(reloaded, 0, saved);
    expect(reloaded.getFeatureCutoff(0, 'rotate')).toEqual({ min: 10, max: 60 });
    expect(reloaded.getFeatureRange(0, 'rotate')).toEqual({ min: 0, max: 100 });
  });

  it('range + cutoff together round-trip with their own semantics', () => {
    const sync = makeSync();
    sync.setFeatureRange(0, 'vibrate', 20, 80);
    sync.setFeatureCutoff(0, 'vibrate', 0, 70);

    const saved = saveFeatureTransforms(sync, 0);
    const reloaded = makeSync();
    loadFeatureTransforms(reloaded, 0, saved);
    expect(reloaded.getFeatureRange(0, 'vibrate')).toEqual({ min: 20, max: 80 });
    expect(reloaded.getFeatureCutoff(0, 'vibrate')).toEqual({ min: 0, max: 70 });
  });

  it('all-default transforms persist neither key', () => {
    const sync = makeSync();
    const saved = saveFeatureTransforms(sync, 0);
    expect(saved.featureRanges).toBeUndefined();
    expect(saved.featureCutoffs).toBeUndefined();
  });

  it('genuinely pre-split saves (featureRanges, no featureCutoffs key) still migrate to cutoff', () => {
    // Shape written before the range/cutoff split: clamp windows under
    // `featureRanges`, `featureCutoffs` key never written at all.
    const legacySaved = { featureRanges: { vibrate: { min: 10, max: 60 } } };
    const reloaded = makeSync();
    loadFeatureTransforms(reloaded, 0, legacySaved);
    expect(reloaded.getFeatureCutoff(0, 'vibrate')).toEqual({ min: 10, max: 60 });
    expect(reloaded.getFeatureRange(0, 'vibrate')).toEqual({ min: 0, max: 100 });
  });
});

describe('connection-panel save block stays in sync with this mirror', () => {
  const cpPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'renderer', 'components', 'connection-panel.js',
  );
  const source = fs.readFileSync(cpPath, 'utf8');

  it('writes both featureRanges and featureCutoffs together when either is set', () => {
    // Drift guard: if the save block reverts to per-key persistence, the
    // round-trip mirror above no longer reflects reality and the
    // range-only-reloads-as-cutoff bug comes back.
    expect(source).toContain('if (anyFeatureRange || anyFeatureCutoff) {');
    expect(source).not.toMatch(/if \(anyFeatureRange\) settings\.featureRanges/);
    expect(source).not.toMatch(/if \(anyFeatureCutoff\) settings\.featureCutoffs/);
  });
});
