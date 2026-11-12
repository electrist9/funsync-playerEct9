/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The renderer is a sandboxed ESM context and cannot require the CommonJS
// classifier in electron/funscript-variants.js, so the release-tag list
// (NOISE_TOKENS) and its predicate are duplicated in both files. That
// duplication is only safe while the two copies agree — this file pins them.
//
// If this test fails, fix BOTH copies in the same commit; a variant label
// that one side calls noise and the other does not means the scanner and the
// fuzzy matcher disagree about the same filename.

import { describe, it, expect } from 'vitest';
import {
  NOISE_TOKENS as ELECTRON_NOISE_TOKENS,
  isNoiseToken as electronIsNoiseToken,
} from '../../electron/funscript-variants.js';
import {
  NOISE_TOKENS as RENDERER_NOISE_TOKENS,
  isNoiseToken as rendererIsNoiseToken,
} from '../../renderer/js/fuzzy-match.js';

describe('NOISE_TOKENS parity (electron/funscript-variants.js ↔ renderer/js/fuzzy-match.js)', () => {
  it('the electron copy is not empty', () => {
    // Guards the test itself: an accidentally emptied copy would make every
    // assertion below pass vacuously.
    expect(ELECTRON_NOISE_TOKENS.size).toBeGreaterThan(30);
  });

  it('contains exactly the same tokens', () => {
    const electronOnly = [...ELECTRON_NOISE_TOKENS].filter((t) => !RENDERER_NOISE_TOKENS.has(t));
    const rendererOnly = [...RENDERER_NOISE_TOKENS].filter((t) => !ELECTRON_NOISE_TOKENS.has(t));
    expect({ electronOnly, rendererOnly }).toEqual({ electronOnly: [], rendererOnly: [] });
    expect(ELECTRON_NOISE_TOKENS.size).toBe(RENDERER_NOISE_TOKENS.size);
  });

  it('every token is a lowercase string', () => {
    for (const token of ELECTRON_NOISE_TOKENS) {
      expect(typeof token).toBe('string');
      expect(token).toBe(token.toLowerCase());
    }
  });
});

describe('isNoiseToken parity', () => {
  // Covers every pattern the predicate knows about plus real-world labels,
  // so a regex edit on one side cannot slip through a set-membership check.
  const CORPUS = [
    // list members
    'webdl', 'webrip', 'bluray', 'x264', 'hevc', 'av1', 'mp4', 'mkv', 'hdr',
    'lr', 'rl', 'sbs', 'ou', '3d', 'vr', '180', '360', 'fisheye', 'oculus',
    'funscript', 'script',
    // pattern members
    '720p', '1080p', '2160p', '4k', '8k', '1920x1080', '180x180', '2019', '1998', '60fps',
    // NOT noise — these are the labels variant detection must keep
    'soft', 'intense', 'rough', 'slow', 'extended', 'loop', 'alt', 'pov',
    'halfspeed', 'slowmo', 'handson', 'edgy', 'bonus', 'teaser',
    // case: the lists are lowercase-only on both sides
    'WEBDL', 'Soft',
    // empty-ish
    '', ' ',
  ];

  it('both copies answer identically for every token in the corpus', () => {
    const disagreements = CORPUS
      .map((token) => ({ token, electron: electronIsNoiseToken(token), renderer: rendererIsNoiseToken(token) }))
      .filter((row) => row.electron !== row.renderer);
    expect(disagreements).toEqual([]);
  });

  it('treats missing input the same way', () => {
    for (const value of [null, undefined, '']) {
      expect(electronIsNoiseToken(value)).toBe(rendererIsNoiseToken(value));
    }
  });
});
