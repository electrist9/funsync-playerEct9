/**
 * Unit tests for the VR client's pure slideshow state machine
 * (backend/vr-remote/js/slideshow.js → SlideshowModel). Timing/color helpers
 * resolve through the vitest '/shared-js/…' aliases to the real shared files.
 */
import { describe, it, expect } from 'vitest';
import { SlideshowModel, MAX_TRANSITION_S } from '../../backend/vr-remote/js/slideshow.js';

const ACTIONS = [
  { at: 0, pos: 0 },
  { at: 1000, pos: 10 },
  { at: 2000, pos: 80 },
  { at: 3000, pos: 10 },
  { at: 4000, pos: 90 },
];

function makeModel(overrides = {}, extra = {}) {
  return new SlideshowModel({
    canvasW: 1600,
    canvasH: 900,
    corner: 'bottom_right',
    sizeDenom: 8,
    imageOrder: 'name',
    transition: 'crossfade',
    background: 'solid',
    presets: [],
    preset: '',
    imageUrls: extra.imageUrls ?? ['a.png', 'b.png', 'c.png'],
    actions: extra.actions ?? ACTIONS,
    ...overrides,
  });
}

describe('SlideshowModel switch times', () => {
  it('derives switch points from the up-mode funscript', () => {
    const m = makeModel();
    // Upward moves above prev (threshold 0): at=1000 (10>0), at=2000 (80>10),
    // at=4000 (90>10); the 80→10 drop is not an up-switch.
    expect(m.switchTimes).toEqual([1, 2, 4]);
  });

  it('resolves a named preset from the presets list', () => {
    const m = makeModel({
      preset: 'p2',
      presets: [
        { name: 'p1', mode: 'peak', threshold: 20, step: 100, order: 'forward' },
        { name: 'p2', mode: 'cumulative', threshold: 0, step: 120, order: 'pingpong' },
      ],
    });
    expect(m.preset.name).toBe('p2');
    expect(m.preset.mode).toBe('cumulative');
    // |Δpos| 10+70+70+80 = 230 with step 120 → 1 switch (acc wraps once).
    expect(m.switchTimes).toEqual([3]);
  });

  it('no actions → no switches, photo 0 forever', () => {
    const m = makeModel({}, { actions: [] });
    expect(m.switchTimes).toEqual([]);
    const f = m.frame(12.5);
    expect(f.photoIndex).toBe(0);
    expect(f.transition).toBeNull();
  });

  it('no images → empty frame', () => {
    const m = makeModel({}, { imageUrls: [] });
    const f = m.frame(3);
    expect(f.photoIndex).toBe(-1);
    expect(f.fromIndex).toBe(-1);
  });
});

describe('SlideshowModel.frame transition windows', () => {
  it('before the first switch shows photo 0 with no transition', () => {
    const f = makeModel().frame(0.5);
    expect(f.photoIndex).toBe(0);
    expect(f.fromIndex).toBe(0);
    expect(f.toIndex).toBe(-1);
    expect(f.transition).toBeNull();
  });

  it('just after a switch reports from→to with a partial progress', () => {
    const m = makeModel();
    // switches [1,2,4]: at 2.1 we are 0.1s into the switch-at-2 window.
    const f = m.frame(2.1);
    expect(f.fromIndex).toBe(1);
    expect(f.toIndex).toBe(2);
    // gap to next switch is 2s → window = min(0.5, 2/4) = 0.5s
    expect(f.progress).toBeCloseTo(0.2, 5);
    expect(f.transition).toBe('crossfade');
    expect(f.photoIndex).toBe(2);
  });

  it('progress saturates at 1 and clears the transition', () => {
    const m = makeModel();
    const f = m.frame(3);
    expect(f.progress).toBe(1);
    expect(f.transition).toBeNull();
    expect(f.photoIndex).toBe(2);
  });

  it('last switch uses the max window (no following switch)', () => {
    const m = makeModel();
    const f = m.frame(4 + MAX_TRANSITION_S / 2);
    expect(f.progress).toBeCloseTo(0.5, 5);
    const done = m.frame(4 + MAX_TRANSITION_S + 1);
    expect(done.progress).toBe(1);
    // 4th photo over 3 wraps around in forward order.
    expect(done.photoIndex).toBe(0);
  });

  it('negative or NaN time clamps to 0', () => {
    const m = makeModel();
    expect(m.frame(-5).photoIndex).toBe(0);
    expect(m.frame(Number.NaN).photoIndex).toBe(0);
  });
});

describe('SlideshowModel ordering and transitions', () => {
  it('pingpong preset order bounces the photo index', () => {
    const m = makeModel({
      preset: 'pp',
      presets: [{ name: 'pp', mode: 'up', threshold: 0, step: 100, order: 'pingpong' }],
      imageUrls: ['a.png', 'b.png', 'c.png'],
    });
    // switches [1,2,4]: frame(3) is past switch 2 → ordinal 2; pingpong over
    // 3 photos is 0,1,2,1,… so ordinal 2 → 2, ordinal 3 → 1.
    expect(m.frame(3).photoIndex).toBe(2);
    expect(m.frame(10).photoIndex).toBe(1);
  });

  it('random transitions are picked once per switch and cached', () => {
    let calls = 0;
    const rng = () => {
      calls += 1;
      return ((calls * 37) % 100) / 100;
    };
    const m = makeModel({ transition: 'random', rng });
    const a = m.frame(2.1);
    const b = m.frame(2.2);
    expect(a.transition).not.toBeNull();
    expect(b.transition).toBe(a.transition);
    const callsAfterFirst = 1;
    expect(calls).toBe(callsAfterFirst);
  });

  it('invalid transition/background settings sanitize to defaults', () => {
    const m = makeModel({ transition: 'bogus', background: 'nope' });
    expect(m.transition).toBe('crossfade');
    expect(m.background).toBe('solid');
  });
});

describe('SlideshowModel wipe geometry', () => {
  it('computes a video window inside the canvas for the configured corner', () => {
    const m = makeModel({ corner: 'top_left', sizeDenom: 4 });
    const f = m.frame(1, 1920, 1080);
    expect(f.wipe.x).toBe(16);
    expect(f.wipe.y).toBe(16);
    expect(f.wipe.w).toBeGreaterThan(0);
    expect(f.wipe.w * f.wipe.h).toBeLessThanOrEqual(m.canvasW * m.canvasH);
    // aspect preserved:
    expect(f.wipe.w / f.wipe.h).toBeCloseTo(1920 / 1080, 1);
  });

  it('unknown video size falls back to the bounding box', () => {
    const m = makeModel({ corner: 'bottom_right', sizeDenom: 8 });
    const f = m.frame(1, 0, 0);
    const side = Math.sqrt(8);
    expect(f.wipe.w).toBe(Math.floor((m.canvasW - 32) / side));
    expect(f.wipe.x + f.wipe.w).toBe(m.canvasW - 16);
  });
});
