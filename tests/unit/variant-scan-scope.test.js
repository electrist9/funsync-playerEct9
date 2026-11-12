// Scan-scope regression for the variant dropdown's refresh-on-open.
//
// Real-device report (2026-11-12): videos in `F:\funsync\vatest\video`,
// funscripts in `F:\funsync\vatest\funscripts`, both configured as library
// sources. The library scan auto-detected all six variants, but opening the
// variant dropdown re-scanned ONLY the video's folder — which holds no
// scripts — and the fresh-vs-cached comparison replaced the six variants with
// an empty list. `main.log` shows it: `Scanned 7 entries ... from 2 source(s)`
// immediately followed by `Scanned 1 entries ... from 1 source(s)`.
//
// The scope rule lives in renderer/js/variant-scan-scope.js so it can be
// pinned here; app.js only wires it to the IPC call.

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { variantScanDirs, variantFoldersUnreachable } from '../../renderer/js/variant-scan-scope.js';

const VIDEO = 'F:\\funsync\\vatest\\video\\[Official Music Video] Perfume 「Spinning World」 [F27FkOytdYA].webm';
const VIDEO_DIR = 'F:\\funsync\\vatest\\video';
const SCRIPT_DIR = 'F:\\funsync\\vatest\\funscripts';
const SCRIPT_BASE = '[Official Music Video] Perfume 「Spinning World」 [F27FkOytdYA]';

const scriptIn = (dir, suffix) => ({
  label: suffix || 'Default',
  path: `${dir}\\${SCRIPT_BASE}${suffix ? ` (${suffix})` : ''}.funscript`,
});

describe('variantScanDirs', () => {
  it('scans just the video folder when its variants live beside it', () => {
    const dirs = variantScanDirs(VIDEO, [
      scriptIn(VIDEO_DIR),
      scriptIn(VIDEO_DIR, 'Simple'),
    ]);
    expect(dirs).toEqual([VIDEO_DIR]);
  });

  it('includes the separate funscript folder the cached variants came from', () => {
    const cached = [
      scriptIn(SCRIPT_DIR),
      scriptIn(SCRIPT_DIR, 'AUTO-BPM'),
      scriptIn(SCRIPT_DIR, 'Simple'),
    ];
    expect(variantScanDirs(VIDEO, cached)).toEqual([VIDEO_DIR, SCRIPT_DIR]);
  });

  it('keeps the video folder first and preserves first-seen order', () => {
    const dirs = variantScanDirs(VIDEO, [
      scriptIn('F:\\other\\scripts', 'Fast'),
      scriptIn(SCRIPT_DIR, 'Simple'),
      scriptIn(VIDEO_DIR, 'Pulse'),
    ]);
    expect(dirs).toEqual([VIDEO_DIR, 'F:\\other\\scripts', SCRIPT_DIR]);
  });

  it('dedupes folders that differ only by separator style or drive-letter case', () => {
    const dirs = variantScanDirs(VIDEO, [
      { path: 'f:/funsync/vatest/video/other.webm' },
      { path: 'f:/funsync/vatest/funscripts/a.funscript' },
      { path: 'F:\\funsync\\vatest\\funscripts\\b.funscript' },
    ]);
    expect(dirs).toEqual([VIDEO_DIR, 'f:/funsync/vatest/funscripts']);
  });

  it('returns nothing for a path with no directory part', () => {
    expect(variantScanDirs('clip.mp4', [])).toEqual([]);
    expect(variantScanDirs('', [])).toEqual([]);
  });

  it('tolerates a missing or malformed cached variant list', () => {
    expect(variantScanDirs(VIDEO)).toEqual([VIDEO_DIR]);
    expect(variantScanDirs(VIDEO, [null, {}, { path: '' }])).toEqual([VIDEO_DIR]);
  });
});

describe('variantFoldersUnreachable', () => {
  it('flags a failed scan of a folder that hosts cached variants', () => {
    const cached = [scriptIn(SCRIPT_DIR, 'Simple')];
    expect(variantFoldersUnreachable(cached, [SCRIPT_DIR])).toBe(true);
    // Same folder, different spelling — must still match.
    expect(variantFoldersUnreachable(cached, ['f:/funsync/vatest/funscripts/'])).toBe(true);
  });

  it('ignores failures elsewhere and empty failure lists', () => {
    const cached = [scriptIn(SCRIPT_DIR, 'Simple')];
    expect(variantFoldersUnreachable(cached, ['F:\\funsync\\vatest\\videos'])).toBe(false);
    expect(variantFoldersUnreachable(cached, [])).toBe(false);
    expect(variantFoldersUnreachable(cached, undefined)).toBe(false);
    expect(variantFoldersUnreachable([], [SCRIPT_DIR])).toBe(false);
  });
});

describe('app.js wiring', () => {
  const app = readFileSync(
    fileURLToPath(new URL('../../renderer/js/app.js', import.meta.url)),
    'utf8',
  );
  const body = app.slice(
    app.indexOf('async _refreshCurrentVariantsFromDisk()'),
    app.indexOf('_getPreferredVariantLabel(videoPath)'),
  );

  it('exists and rescans the multi-folder scope, not one derived dir', () => {
    expect(body).not.toBe('');
    expect(body).toContain('variantScanDirs(videoPath, cur)');
    expect(body).toContain('dirs.length === 1 ? dirs[0] : dirs');
    // The single-folder call that wiped cross-directory variant sets.
    expect(body).not.toContain('videoPath.replace(');
    expect(body).not.toMatch(/scanDirectory\(\s*dir\s*,/);
  });

  it('keeps the cache when a variant folder failed to scan', () => {
    expect(body).toContain('variantFoldersUnreachable(cur, result?.failedPaths)');
  });
});
