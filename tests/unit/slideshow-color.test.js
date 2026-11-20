/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { dominantColorFromImageData } from '../../renderer/js/slideshow-color.js';

function rgba(pixels) {
  // pixels: array of [r,g,b] triples → Uint8ClampedArray RGBA stride 4.
  const out = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    out[i * 4] = pixels[i][0];
    out[i * 4 + 1] = pixels[i][1];
    out[i * 4 + 2] = pixels[i][2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe('dominantColorFromImageData', () => {
  it('returns the exact color for a single-color image', () => {
    const data = rgba(Array(16).fill([10, 200, 30]));
    expect(dominantColorFromImageData(data, 4, 4)).toBe('#0ac81e');
  });

  it('averages the most frequent bucket, ignoring minority colors', () => {
    // 12 pixels in bucket (r>>4, g>>4, b>>4) = (8, 8, 8), 4 pixels elsewhere.
    const majority = [
      [130, 130, 130],
      [131, 133, 129],
      [140, 130, 130],
      [130, 140, 130],
    ];
    const pixels = [];
    for (let i = 0; i < 3; i += 1) pixels.push(...majority);
    for (let i = 0; i < 4; i += 1) pixels.push([255, 0, 0]);
    const data = rgba(pixels);
    const hex = dominantColorFromImageData(data, pixels.length, 1);
    // Bucket average of the 12 majority pixels:
    // r: (130+131+140+130)*3 = 1593 → floor(1593/12) = 132 = 0x84
    // g: (130+133+130+140)*3 = 1599 → floor(1599/12) = 133 = 0x85
    // b: (130+129+130+130)*3 = 1557 → floor(1557/12) = 129 = 0x81
    expect(hex).toBe('#848581');
  });

  it('quantizes to 16 levels: colors in the same >>4 bucket share a key', () => {
    // 15 and 30 are different buckets (0 vs 1); 16 and 30 share bucket 1.
    const pixels = [[16, 16, 16], [30, 30, 30], [15, 15, 15]];
    const data = rgba(pixels);
    const hex = dominantColorFromImageData(data, 3, 1);
    expect(hex).toBe('#171717'); // bucket 1 wins (2 px): floor((16+30)/2) = 23 = 0x17
  });

  it('returns null for empty or invalid input', () => {
    expect(dominantColorFromImageData(null, 4, 4)).toBeNull();
    expect(dominantColorFromImageData(new Uint8ClampedArray(0), 0, 0)).toBeNull();
    expect(dominantColorFromImageData(new Uint8ClampedArray(16), 0, 4)).toBeNull();
    expect(dominantColorFromImageData(new Uint8ClampedArray(16), 4, -1)).toBeNull();
    expect(dominantColorFromImageData(undefined, 4, 4)).toBeNull();
  });

  it('clamps the scan to the shorter of w*h and data length', () => {
    // Declared 10x10 but only 4 pixels of data → scan 4 pixels, still works.
    const data = rgba([[200, 10, 10], [201, 10, 10], [202, 10, 10], [10, 200, 10]]);
    const hex = dominantColorFromImageData(data, 10, 10);
    expect(hex).toBe('#c90a0a');
  });

  it('is deterministic on ties: first-inserted bucket wins', () => {
    const pixels = [[16, 16, 16], [32, 32, 32]]; // one pixel per bucket
    const data = rgba(pixels);
    expect(dominantColorFromImageData(data, 2, 1)).toBe('#101010');
  });
});
