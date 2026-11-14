/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Random-script-variation-on-play decision logic (zaikechi #209/#221).
//
// pickVariantIndexOnLoad resolves which variant a freshly loaded video
// starts on: random toggle beats pinned default while on; pins apply
// when it's off; anything else keeps the already-loaded auto-default
// (index 0). Pure + injectable RNG so the whole matrix is testable.

import { describe, it, expect } from 'vitest';
import { pickVariantIndexOnLoad, variantOrigin } from '../../renderer/js/variant-select.js';

const VARIANTS = [
  { label: 'Default' },
  { label: 'Soft' },
  { label: 'Intense' },
];

describe('pickVariantIndexOnLoad', () => {
  it('keeps the loaded default with fewer than 2 variants', () => {
    expect(pickVariantIndexOnLoad([], { randomOn: true })).toBe(0);
    expect(pickVariantIndexOnLoad([{ label: 'Only' }], { randomOn: true })).toBe(0);
    expect(pickVariantIndexOnLoad(null, { randomOn: true })).toBe(0);
  });

  it('random ON picks uniformly across ALL variants via the injected rng', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 0 })).toBe(0);
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 0.34 })).toBe(1);
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 0.99 })).toBe(2);
  });

  it('random ON beats a pinned default (the toggle exists to inject variety)', () => {
    const idx = pickVariantIndexOnLoad(VARIANTS, {
      randomOn: true,
      preferredLabel: 'Intense',
      rng: () => 0.34, // would pick 'Soft'
    });
    expect(idx).toBe(1);
  });

  it('random OFF honors the pinned default', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: false, preferredLabel: 'Intense' })).toBe(2);
  });

  it('pin matching trims whitespace (mirrors _applyPreferredVariant)', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { preferredLabel: '  Soft  ' })).toBe(1);
  });

  it('missing or already-default pin keeps the loaded default', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { preferredLabel: 'Deleted Variant' })).toBe(0);
    expect(pickVariantIndexOnLoad(VARIANTS, { preferredLabel: 'Default' })).toBe(0);
    expect(pickVariantIndexOnLoad(VARIANTS, {})).toBe(0);
  });

  it('clamps a hostile rng into range', () => {
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => 1.5 })).toBe(2);
    expect(pickVariantIndexOnLoad(VARIANTS, { randomOn: true, rng: () => -1 })).toBe(0);
  });
});

describe('variantOrigin', () => {
  // Provenance for the dropdown chip: the flags already exist in the data
  // (`_autoDetected` from the scan, `_isManual` from the manual-variant merge),
  // nothing here is persisted. Unknown origin must come back '' so the UI shows
  // no chip rather than a wrong one.
  it('reads the scan flag as auto', () => {
    expect(variantOrigin({ label: 'Soft', path: 'X:\\a\\video (Soft).funscript', _autoDetected: true })).toBe('auto');
  });

  it('reads the merge flag as manual', () => {
    expect(variantOrigin({ label: 'Custom', path: 'X:\\b\\custom.funscript', _isManual: true })).toBe('manual');
  });

  it('manual wins if a row somehow carries both flags', () => {
    // The merge dedupes by path and keeps the auto row, so this should not
    // happen — but the tie-break must not depend on property order.
    expect(variantOrigin({ label: 'Both', _autoDetected: true, _isManual: true })).toBe('manual');
  });

  it('returns an empty string when the origin is unknown', () => {
    // The synthetic "current script" row, and rows that never went through the
    // scan, carry neither flag — no chip is better than a wrong chip.
    expect(variantOrigin({ label: 'Default', path: 'X:\\a\\video.funscript' })).toBe('');
    expect(variantOrigin({})).toBe('');
    expect(variantOrigin(null)).toBe('');
    expect(variantOrigin(undefined)).toBe('');
  });

  it('ignores falsy flags rather than treating them as provenance', () => {
    expect(variantOrigin({ label: 'Default', _autoDetected: false, _isManual: false })).toBe('');
    expect(variantOrigin({ label: 'Default', _autoDetected: undefined, _isManual: 0 })).toBe('');
  });
});
