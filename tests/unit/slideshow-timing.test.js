// Unit tests for slideshow-timing.js — pure port of rhythmslide funscript.py /
// videowipe.py. Switch times are in SECONDS (matching the reference).
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PRESET,
  FUNSCRIPT_MODES,
  PHOTO_ORDERS,
  makePreset,
  sanitizePresets,
  resolvePreset,
  parsePoints,
  computeSwitchTimes,
  photoIndexAt,
  naturalCompare,
  arrangeImages,
  wipeGeometry,
  WIPE_MARGIN_PX,
  CONCRETE_TRANSITIONS,
  TRANSITIONS,
  BACKGROUNDS,
  sanitizeTransition,
  sanitizeBackground,
  pickRandomTransition,
} from '../../renderer/js/slideshow-timing.js';

describe('makePreset', () => {
  it('trims the name and coerces numbers', () => {
    const p = makePreset('  My Preset  ', 'peak', '5', '120', 'pingpong');
    expect(p).toEqual({ name: 'My Preset', mode: 'peak', threshold: 5, step: 120, order: 'pingpong' });
  });
});

describe('sanitizePresets', () => {
  it('drops non-list input entirely', () => {
    expect(sanitizePresets(undefined)).toEqual([]);
    expect(sanitizePresets('nope')).toEqual([]);
  });

  it('drops non-dict entries, empty names, and duplicate names (first wins)', () => {
    const out = sanitizePresets([
      null,
      'string',
      { name: '  ', mode: 'up' },
      { name: 'A', mode: 'up', threshold: 0, step: 100, order: 'forward' },
      { name: 'A', mode: 'peak' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('A');
    expect(out[0].mode).toBe('up');
  });

  it('normalizes unknown mode/order to defaults', () => {
    const out = sanitizePresets([{ name: 'X', mode: 'bogus', order: 'weird' }]);
    expect(out[0].mode).toBe('up');
    expect(out[0].order).toBe('forward');
  });

  it('clamps threshold >= 0 and step > 0 (invalid values fall back to defaults)', () => {
    const out = sanitizePresets([
      { name: 'A', threshold: -5, step: 0 },
      { name: 'B', threshold: 'abc', step: 'xyz' },
    ]);
    expect(out[0].threshold).toBe(0);
    expect(out[0].step).toBe(100);
    expect(out[1].threshold).toBe(0);
    expect(out[1].step).toBe(100);
  });
});

describe('resolvePreset', () => {
  const presets = [
    { name: 'First', mode: 'up', threshold: 0, step: 100, order: 'forward' },
    { name: 'Second', mode: 'peak', threshold: 10, step: 100, order: 'pingpong' },
  ];

  it('matches the default name exactly', () => {
    expect(resolvePreset(presets, 'Second').mode).toBe('peak');
  });

  it('falls back to the first preset when the name is missing or empty', () => {
    expect(resolvePreset(presets, 'Nope').name).toBe('First');
    expect(resolvePreset(presets, '').name).toBe('First');
  });

  it('falls back to the built-in default when the list is empty', () => {
    const p = resolvePreset([], 'whatever');
    expect(p.mode).toBe('up');
    expect(p.threshold).toBe(0);
    expect(p.step).toBe(100);
    expect(p.order).toBe('forward');
  });

  it('sanitizes entries while resolving', () => {
    const p = resolvePreset([{ name: 'Bad', mode: 'nope', step: -1 }], 'Bad');
    expect(p.mode).toBe('up');
    expect(p.step).toBe(100);
  });
});

describe('parsePoints', () => {
  it('skips unreadable entries and sorts by at', () => {
    const pts = parsePoints([
      { at: 500, pos: 100 },
      null,
      { at: 'abc', pos: 1 },
      { at: 0, pos: 'x' },
      { at: 0, pos: 0 },
      42,
    ]);
    expect(pts).toEqual([[0, 0], [500, 100]]);
  });

  it('returns empty for non-array input', () => {
    expect(parsePoints(undefined)).toEqual([]);
  });
});

describe('computeSwitchTimes — up mode', () => {
  const actions = [
    { at: 0, pos: 0 },
    { at: 500, pos: 100 },   // rise → switch at 0.5s
    { at: 1000, pos: 50 },   // fall → no switch
    { at: 1500, pos: 90 },   // rise → switch at 1.5s
  ];

  it('switches on upward moves (times in seconds)', () => {
    expect(computeSwitchTimes(actions, { mode: 'up' })).toEqual([0.5, 1.5]);
  });

  it('ignores rises below the threshold', () => {
    expect(computeSwitchTimes(actions, { mode: 'up', threshold: 50 })).toEqual([0.5]);
  });

  it('the first action is never a switch point', () => {
    const a = [{ at: 0, pos: 0 }, { at: 100, pos: 1 }];
    expect(computeSwitchTimes(a, { mode: 'up', threshold: 0 })).toEqual([0.1]);
    // A script starting mid-rise still has no switch at the first action.
    const b = [{ at: 1000, pos: 50 }, { at: 2000, pos: 60 }];
    expect(computeSwitchTimes(b, { mode: 'up' })).toEqual([2]);
  });

  it('merges duplicate at values', () => {
    const a = [
      { at: 0, pos: 0 },
      { at: 500, pos: 100 },
      { at: 500, pos: 100 },
    ];
    expect(computeSwitchTimes(a, { mode: 'up' })).toEqual([0.5]);
  });

  it('returns empty for empty or single-action scripts', () => {
    expect(computeSwitchTimes([], { mode: 'up' })).toEqual([]);
    expect(computeSwitchTimes([{ at: 0, pos: 0 }], { mode: 'up' })).toEqual([]);
  });

  it('defaults to up mode for unknown mode values', () => {
    expect(computeSwitchTimes(actions, { mode: 'bogus' })).toEqual([0.5, 1.5]);
  });
});

describe('computeSwitchTimes — peak mode', () => {
  const actions = [
    { at: 0, pos: 0 },
    { at: 500, pos: 100 },  // local max → switch at 0.5
    { at: 1000, pos: 0 },   // local min → switch at 1.0
    { at: 1500, pos: 100 }, // local max → switch at 1.5
    { at: 2000, pos: 50 },  // not an extremum (end)
  ];

  it('switches at both rise and fall extrema', () => {
    expect(computeSwitchTimes(actions, { mode: 'peak' })).toEqual([0.5, 1, 1.5]);
  });

  it('ignores extrema whose smaller adjacent swing is below threshold', () => {
    const a = [
      { at: 0, pos: 0 },
      { at: 500, pos: 100 }, // swings: 100 then 5
      { at: 1000, pos: 95 },
    ];
    expect(computeSwitchTimes(a, { mode: 'peak', threshold: 10 })).toEqual([]);
    expect(computeSwitchTimes(a, { mode: 'peak', threshold: 4 })).toEqual([0.5]);
  });
});

describe('computeSwitchTimes — cumulative mode', () => {
  const actions = [
    { at: 0, pos: 0 },
    { at: 500, pos: 60 },   // acc 60
    { at: 1000, pos: 0 },   // acc 120 → switch at 1.0 (step 100)
    { at: 1500, pos: 80 },  // acc 200 → switch at 1.5
    { at: 2000, pos: 0 },   // acc 280
  ];

  it('switches each time accumulated |Δpos| reaches step', () => {
    expect(computeSwitchTimes(actions, { mode: 'cumulative', step: 100 })).toEqual([1, 1.5]);
  });

  it('does not accumulate moves at or below threshold', () => {
    const a = [
      { at: 0, pos: 0 },
      { at: 500, pos: 5 },   // jitter, not accumulated
      { at: 1000, pos: 100 }, // |100-5| = 95 < 100 → no switch
    ];
    expect(computeSwitchTimes(a, { mode: 'cumulative', threshold: 5, step: 100 })).toEqual([]);
  });

  it('can emit multiple switches at one action when the jump spans several steps', () => {
    const a = [
      { at: 0, pos: 0 },
      { at: 500, pos: 250 }, // acc 250 → two switches at 0.5, merged to one
    ];
    expect(computeSwitchTimes(a, { mode: 'cumulative', step: 100 })).toEqual([0.5]);
  });

  it('returns empty for step <= 0', () => {
    expect(computeSwitchTimes(actions, { mode: 'cumulative', step: 0 })).toEqual([]);
    expect(computeSwitchTimes(actions, { mode: 'cumulative', step: -10 })).toEqual([]);
  });
});

describe('photoIndexAt', () => {
  it('forward wraps around', () => {
    expect(photoIndexAt(3, 'forward', 0)).toBe(0);
    expect(photoIndexAt(3, 'forward', 2)).toBe(2);
    expect(photoIndexAt(3, 'forward', 3)).toBe(0);
    expect(photoIndexAt(3, 'forward', 7)).toBe(1);
  });

  it('pingpong bounces without repeating endpoints', () => {
    const seq = [];
    for (let i = 0; i < 8; i++) seq.push(photoIndexAt(3, 'pingpong', i));
    expect(seq).toEqual([0, 1, 2, 1, 0, 1, 2, 1]);
  });

  it('pingpong with one photo stays at 0', () => {
    expect(photoIndexAt(1, 'pingpong', 5)).toBe(0);
  });

  it('returns -1 for empty photo list', () => {
    expect(photoIndexAt(0, 'forward', 0)).toBe(-1);
  });
});

describe('naturalCompare', () => {
  it('orders embedded numbers numerically', () => {
    expect(naturalCompare('img2.jpg', 'img10.jpg')).toBe(-1);
    expect(naturalCompare('img10.jpg', 'img2.jpg')).toBe(1);
  });

  it('is case-insensitive for text', () => {
    expect(naturalCompare('B.jpg', 'a.jpg')).toBe(1);
  });

  it('equal strings compare 0', () => {
    expect(naturalCompare('a1', 'a1')).toBe(0);
  });
});

describe('arrangeImages', () => {
  const paths = [
    'C:\\pics\\b\\img10.png',
    'C:\\pics\\a\\img2.png',
    'C:\\pics\\img1.png',
  ];

  it('name mode sorts by basename naturally (not full path)', () => {
    expect(arrangeImages(paths, 'name')).toEqual([
      'C:\\pics\\img1.png',
      'C:\\pics\\a\\img2.png',
      'C:\\pics\\b\\img10.png',
    ]);
  });

  it('random mode is a permutation, deterministic with an injected rng', () => {
    // rng always 0 → j=0 every step: swap(2,0) then swap(1,0)
    const out = arrangeImages(paths, 'random', () => 0);
    expect(out).toHaveLength(paths.length);
    expect([...out].sort()).toEqual([...paths].sort());
    expect(out).toEqual([
      'C:\\pics\\a\\img2.png',
      'C:\\pics\\img1.png',
      'C:\\pics\\b\\img10.png',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [...paths];
    arrangeImages(input, 'name');
    arrangeImages(input, 'random');
    expect(input).toEqual(paths);
  });

  it('handles empty and non-array input', () => {
    expect(arrangeImages([], 'name')).toEqual([]);
    expect(arrangeImages(undefined, 'random')).toEqual([]);
  });
});

describe('wipeGeometry', () => {
  const PARENT_W = 1600;
  const PARENT_H = 900;
  const VIDEO_W = 1920;
  const VIDEO_H = 1080;

  it('keeps the bounding box near 1/denom of the inset area and preserves aspect', () => {
    const g = wipeGeometry(PARENT_W, PARENT_H, VIDEO_W, VIDEO_H, 'bottom_right', WIPE_MARGIN_PX, 8);
    // 16:9 video in a 16:9 parent → w/h ratio preserved
    expect(g.w / g.h).toBeCloseTo(VIDEO_W / VIDEO_H, 1);
    // area ≈ 1/8 of the margin-inset area
    const inset = (PARENT_W - 2 * WIPE_MARGIN_PX) * (PARENT_H - 2 * WIPE_MARGIN_PX);
    expect((g.w * g.h) / inset).toBeLessThanOrEqual(1 / 8 + 0.01);
    expect((g.w * g.h) / inset).toBeGreaterThan(1 / 8 - 0.05);
  });

  it('larger denom means smaller wipe', () => {
    const a = wipeGeometry(PARENT_W, PARENT_H, VIDEO_W, VIDEO_H, 'bottom_right', WIPE_MARGIN_PX, 4);
    const b = wipeGeometry(PARENT_W, PARENT_H, VIDEO_W, VIDEO_H, 'bottom_right', WIPE_MARGIN_PX, 16);
    expect(a.w * a.h).toBeGreaterThan(b.w * b.h);
  });

  it('anchors to each corner with the margin', () => {
    const g = (corner) => wipeGeometry(PARENT_W, PARENT_H, VIDEO_W, VIDEO_H, corner, WIPE_MARGIN_PX, 8);
    const br = g('bottom_right');
    expect(br.x + br.w).toBe(PARENT_W - WIPE_MARGIN_PX);
    expect(br.y + br.h).toBe(PARENT_H - WIPE_MARGIN_PX);
    const tl = g('top_left');
    expect([tl.x, tl.y]).toEqual([WIPE_MARGIN_PX, WIPE_MARGIN_PX]);
    const tr = g('top_right');
    expect(tr.x + tr.w).toBe(PARENT_W - WIPE_MARGIN_PX);
    expect(tr.y).toBe(WIPE_MARGIN_PX);
    const bl = g('bottom_left');
    expect(bl.x).toBe(WIPE_MARGIN_PX);
    expect(bl.y + bl.h).toBe(PARENT_H - WIPE_MARGIN_PX);
  });

  it('invalid corner behaves as bottom_right', () => {
    const bogus = wipeGeometry(PARENT_W, PARENT_H, VIDEO_W, VIDEO_H, 'middle', WIPE_MARGIN_PX, 8);
    const br = wipeGeometry(PARENT_W, PARENT_H, VIDEO_W, VIDEO_H, 'bottom_right', WIPE_MARGIN_PX, 8);
    expect(bogus).toEqual(br);
  });

  it('unknown video size uses the bounding box as-is', () => {
    const g = wipeGeometry(PARENT_W, PARENT_H, 0, 0, 'bottom_right', WIPE_MARGIN_PX, 4);
    const side = Math.sqrt(4);
    expect(g.w).toBe(Math.floor((PARENT_W - 2 * WIPE_MARGIN_PX) / side));
    expect(g.h).toBe(Math.floor((PARENT_H - 2 * WIPE_MARGIN_PX) / side));
  });

  it('degenerate parents return a zero rect', () => {
    expect(wipeGeometry(0, 900, 1920, 1080, 'bottom_right')).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(wipeGeometry(1600, -5, 1920, 1080, 'bottom_right')).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('invalid denom falls back to 8', () => {
    const bad = wipeGeometry(PARENT_W, PARENT_H, 0, 0, 'bottom_right', WIPE_MARGIN_PX, 0);
    const good = wipeGeometry(PARENT_W, PARENT_H, 0, 0, 'bottom_right', WIPE_MARGIN_PX, 8);
    expect(bad).toEqual(good);
  });
});

describe('constants', () => {
  it('mode/order tuples match the rhythmslide reference', () => {
    expect(FUNSCRIPT_MODES).toEqual(['up', 'peak', 'cumulative']);
    expect(PHOTO_ORDERS).toEqual(['forward', 'pingpong']);
    expect(BUILTIN_PRESET).toMatchObject({ mode: 'up', threshold: 0, step: 100, order: 'forward' });
  });

  it('transition/background tuples match the rhythmslide renderer port', () => {
    expect(CONCRETE_TRANSITIONS).toEqual(['crossfade', 'wipe_left', 'wipe_right', 'slide_left', 'slide_right', 'zoom']);
    expect(TRANSITIONS).toEqual([...CONCRETE_TRANSITIONS, 'random']);
    expect(BACKGROUNDS).toEqual(['solid', 'dominant']);
  });
});

describe('sanitizeTransition', () => {
  it('accepts every concrete kind and random', () => {
    for (const v of TRANSITIONS) expect(sanitizeTransition(v)).toBe(v);
  });

  it('falls back to crossfade for invalid values', () => {
    expect(sanitizeTransition(undefined)).toBe('crossfade');
    expect(sanitizeTransition(null)).toBe('crossfade');
    expect(sanitizeTransition('spin')).toBe('crossfade');
    expect(sanitizeTransition('')).toBe('crossfade');
  });
});

describe('sanitizeBackground', () => {
  it('accepts solid and dominant, falls back to solid', () => {
    expect(sanitizeBackground('solid')).toBe('solid');
    expect(sanitizeBackground('dominant')).toBe('dominant');
    expect(sanitizeBackground('gradient')).toBe('solid');
    expect(sanitizeBackground(undefined)).toBe('solid');
  });
});

describe('pickRandomTransition', () => {
  it('maps rng values deterministically onto the concrete kinds', () => {
    const n = CONCRETE_TRANSITIONS.length; // 6
    expect(pickRandomTransition(() => 0)).toBe(CONCRETE_TRANSITIONS[0]);
    expect(pickRandomTransition(() => 0.5)).toBe(CONCRETE_TRANSITIONS[Math.floor(0.5 * n)]);
    expect(pickRandomTransition(() => 0.999999)).toBe(CONCRETE_TRANSITIONS[n - 1]);
  });

  it('clamps out-of-range rng values and always returns a concrete kind', () => {
    for (const v of [-1, 0, 0.33, 0.75, 0.999999, 1, 2]) {
      const picked = pickRandomTransition(() => v);
      expect(CONCRETE_TRANSITIONS).toContain(picked);
    }
  });

  it('treats a non-numeric rng result as 0', () => {
    expect(pickRandomTransition(() => 'x')).toBe(CONCRETE_TRANSITIONS[0]);
  });
});
