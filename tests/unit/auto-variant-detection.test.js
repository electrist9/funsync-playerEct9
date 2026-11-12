/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Auto funscript variant detection — docs/SPEC-auto-variant-detection.md.
// Exercises the real classifier (electron/funscript-variants.js), not a mirror
// of it, so the scan-directory handler and these assertions cannot drift apart.
// The scan's sibling post-pass is pinned separately in
// tests/unit/scan-directory-variants.test.js.

import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  classifyFunscriptName,
  disambiguateVariantLabels,
  resolveAutoVariantMode,
  sortVariantsForDisplay,
  isVariantLabelNoise,
  isIdLikeToken,
  keywordMatches,
} from '../../electron/funscript-variants.js';

// Same extension list the scanner uses, so a "video exists" in these tests
// means exactly what it means during a real scan.
const VIDEO_EXTS = ['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac', '.m4a'];

function videoSetsFor(videoFilenames, dir) {
  const videoBaseLocal = new Set();
  const videoBaseGlobal = new Set();
  for (const vname of videoFilenames) {
    const dotPos = vname.lastIndexOf('.');
    const vext = dotPos >= 0 ? vname.slice(dotPos).toLowerCase() : '';
    if (!VIDEO_EXTS.includes(vext)) continue;
    const vbase = normalizeName(vname.slice(0, dotPos));
    videoBaseLocal.add(dir + '\0' + vbase);
    videoBaseGlobal.add(vbase);
  }
  return { videoBaseLocal, videoBaseGlobal };
}

/** Classify one funscript filename against a set of sibling videos. */
function classify(filename, { dir = '/lib', videos = [], mode = 'strict', keywords = [] } = {}) {
  const nameNoExt = filename.replace(/\.funscript$/i, '');
  const sets = videoSetsFor(videos, dir);
  return classifyFunscriptName(nameNoExt, { dir, ...sets, mode, keywords });
}

describe('Separator rules (spec §2), strict mode, video "Title.mp4" present', () => {
  const videos = ['Title.mp4'];

  it('(L) — always a variant, no whitelist needed', () => {
    const r = classify('Title (Soft).funscript', { videos });
    expect(r.variantLabel).toBe('Soft');
    expect(r.videoBase).toBe('title');
    expect(r.autoDetected).toBe(true);
  });

  it('[L] — variant when the label is whitelisted', () => {
    const r = classify('Title [Soft].funscript', { videos });
    expect(r.variantLabel).toBe('Soft');
    expect(r.videoBase).toBe('title');
  });

  it('.L — variant, flagged ambiguous for the sibling post-pass', () => {
    const r = classify('Title.soft.funscript', { videos });
    expect(r.variantLabel).toBe('soft');
    expect(r.videoBase).toBe('title');
    expect(r.isAmbiguousDotVariant).toBe(true);
  });

  it('-L — variant when the label is whitelisted', () => {
    const r = classify('Title-soft.funscript', { videos });
    expect(r.variantLabel).toBe('soft');
    expect(r.videoBase).toBe('title');
    expect(r.isAmbiguousDotVariant).toBe(false);
  });

  it('_L and "- L" (spaces around the separator) behave the same', () => {
    expect(classify('Title_soft.funscript', { videos }).variantLabel).toBe('soft');
    expect(classify('Title - soft.funscript', { videos }).variantLabel).toBe('soft');
    expect(classify('Title_soft.funscript', { videos }).videoBase).toBe('title');
    expect(classify('Title - soft.funscript', { videos }).videoBase).toBe('title');
  });

  it('only a space is NOT a variant boundary in strict mode', () => {
    const r = classify('Title Soft.funscript', { videos });
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title soft');
    expect(r.autoDetected).toBe(false);
  });

  it('the separator split uses the LAST separator, not the first', () => {
    const r = classify('My-Title-soft.funscript', { videos: ['My-Title.mp4'] });
    expect(r.variantLabel).toBe('soft');
    expect(r.videoBase).toBe('my title');
  });
});

describe('Generic mode widens the rules (spec §2, §3)', () => {
  const videos = ['Title.mp4'];

  it('space-separated labels become variants', () => {
    const r = classify('Title Soft.funscript', { videos, mode: 'generic' });
    expect(r.variantLabel).toBe('Soft');
    expect(r.videoBase).toBe('title');
  });

  it('non-whitelisted, non-noise labels are accepted', () => {
    expect(classify('Title-handson.funscript', { videos, mode: 'generic' }).variantLabel).toBe('handson');
    expect(classify('Title [Simple].funscript', { videos, mode: 'generic' }).variantLabel).toBe('Simple');
    expect(classify('Title-handson.funscript', { videos, mode: 'strict' }).variantLabel).toBeNull();
    expect(classify('Title [Simple].funscript', { videos, mode: 'strict' }).variantLabel).toBeNull();
  });

  it('noise labels are still rejected in generic mode', () => {
    // ` L` is a real separator in generic mode, so the label itself has to be
    // what disqualifies these names.
    for (const name of ['Title-2024.funscript', 'Title-part2.funscript', 'Title 2024.funscript', 'Title part2.funscript']) {
      expect(classify(name, { videos, mode: 'generic' }).variantLabel).toBeNull();
    }
  });

  it('space separator labels are accepted in generic mode only', () => {
    expect(classify('Title Soft.funscript', { videos, mode: 'generic' }).variantLabel).toBe('Soft');
    expect(classify('Title Soft.funscript', { videos, mode: 'strict' }).variantLabel).toBeNull();
  });
});

describe('Whitelist and library.variantKeywords (spec §4)', () => {
  const videos = ['Title.mp4'];

  it('accepts every built-in keyword', () => {
    for (const keyword of ['soft', 'gentle', 'light', 'easy', 'intense', 'hard', 'rough', 'heavy', 'edgy',
      'fast', 'slow', 'extended', 'short', 'loop', 'alt', 'pov', 'bonus', 'preview', 'teaser', 'intro']) {
      expect(classify(`Title-${keyword}.funscript`, { videos }).variantLabel).toBe(keyword);
    }
  });

  it('rejects labels outside the whitelist in strict mode', () => {
    const r = classify('Title-slowmo.funscript', { videos });
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title slowmo');
  });

  it('library.variantKeywords extends the whitelist', () => {
    const r = classify('Title-slowmo.funscript', { videos, keywords: ['slowmo'] });
    expect(r.variantLabel).toBe('slowmo');
  });

  it('user keywords never remove built-in ones', () => {
    expect(classify('Title-soft.funscript', { videos, keywords: ['slowmo'] }).variantLabel).toBe('soft');
  });

  it('keywords are matched trimmed and case-insensitively', () => {
    expect(classify('Title-SlowMo.funscript', { videos, keywords: ['  SlowMo '] }).variantLabel).toBe('SlowMo');
    expect(keywordMatches('soft', [])).toBe(true);
    expect(keywordMatches('Soft-ish', [])).toBe(false);
  });
});

describe('Noise and ID guards apply in every mode (spec §5)', () => {
  const videos = ['Title.mp4'];

  it('a bare number is never a label', () => {
    for (const mode of ['strict', 'generic']) {
      const r = classify('Title-2024.funscript', { videos, mode });
      expect(r.variantLabel).toBeNull();
      expect(r.videoBase).toBe('title 2024');
    }
  });

  it('part2-style sequence markers are never labels', () => {
    for (const label of ['part2', 'Part 3', 'ep04', 'take2', 'S01E03']) {
      expect(classify(`Title-${label}.funscript`, { videos, mode: 'generic' }).variantLabel).toBeNull();
    }
  });

  it('release tags are never labels', () => {
    expect(classify('Title (1080p).funscript', { videos }).variantLabel).toBeNull();
    expect(classify('Title [Webrip].funscript', { videos, mode: 'generic' }).variantLabel).toBeNull();
    expect(isVariantLabelNoise('1080p')).toBe(true);
    expect(isVariantLabelNoise('Soft')).toBe(false);
    expect(isVariantLabelNoise('')).toBe(true);
  });

  it('upload-ID-looking bracket labels are never variants', () => {
    expect(isIdLikeToken('xK9pQ2mZ7wL')).toBe(true);
    expect(isIdLikeToken('SuperMario')).toBe(false);
    expect(isIdLikeToken('HalfSpeed2')).toBe(false);
    expect(isIdLikeToken('Abc12Def34')).toBe(true);
    expect(isIdLikeToken('SlowMo4Ever')).toBe(false);
    for (const mode of ['strict', 'generic']) {
      const r = classify('Title [xK9pQ2mZ7wL].funscript', { videos, mode });
      expect(r.variantLabel).toBeNull();
      expect(r.videoBase).toBe('title [xk9pq2mz7wl]');
    }
  });
});

describe('Video-existence guards (spec §5)', () => {
  it('guard 2: a video matching the FULL name makes the script that video\'s primary', () => {
    const r = classify('Title-soft.funscript', { videos: ['Title-soft.mp4'] });
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title soft');
  });

  it('guard 2 also covers the parenthesised form', () => {
    const r = classify('Title (Soft).funscript', { videos: ['Title (Soft).mp4'] });
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title (soft)');
  });

  it('guard 1: -L and [L] need a video for the stripped base', () => {
    expect(classify('Title-soft.funscript').variantLabel).toBeNull();
    expect(classify('Title [Soft].funscript').variantLabel).toBeNull();
    expect(classify('Title-soft.funscript').videoBase).toBe('title soft');
  });

  it('guard 1 does not apply to (L), which keeps the current behaviour', () => {
    const r = classify('Title (Soft).funscript');
    expect(r.variantLabel).toBe('Soft');
    expect(r.videoBase).toBe('title');
  });

  it('a video in another scanned folder still counts (global fallback)', () => {
    const r = classify('Title-soft.funscript', { dir: '/other' });
    expect(r.variantLabel).toBeNull();
    const sets = videoSetsFor(['Title.mp4'], '/lib');
    const r2 = classifyFunscriptName('Title-soft', { dir: '/other', ...sets, mode: 'strict', keywords: [] });
    expect(r2.variantLabel).toBe('soft');
    expect(r2.videoBase).toBe('title');
  });
});

describe('Axis scripts win over variant readings (spec §5, guard 3)', () => {
  const videos = ['Title.mp4', 'Title (Soft).mp4'];

  it('Title.vib.funscript is an axis part of "Title"', () => {
    const r = classify('Title.vib.funscript', { videos });
    expect(r.isAxis).toBe(true);
    expect(r.axisSuffix).toBe('vib');
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title');
  });

  it('axis suffix beats a parenthesised label', () => {
    const r = classify('Title (Soft).vib.funscript', { videos });
    expect(r.isAxis).toBe(true);
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title (soft)');
  });

  it('axis suffix beats a dash label', () => {
    const r = classify('Title-soft.vib.funscript', { videos });
    expect(r.isAxis).toBe(true);
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title soft');
  });
});

describe('Spec §8 edge-case table', () => {
  it('"Title-soft.mp4" + "Title-soft.funscript" → primary, not a variant', () => {
    const r = classify('Title-soft.funscript', { videos: ['Title-soft.mp4'] });
    expect(r.variantLabel).toBeNull();
  });

  it('"Title.mp4" + "Title-soft.funscript" → variant "soft"', () => {
    expect(classify('Title-soft.funscript', { videos: ['Title.mp4'] }).variantLabel).toBe('soft');
  });

  it('"Title-2024.funscript" → noise, not a variant', () => {
    expect(classify('Title-2024.funscript', { videos: ['Title.mp4'] }).variantLabel).toBeNull();
  });

  it('scraper-bracketed name keeps the parenthesised label', () => {
    const r = classify('[Official Music Video] Title [xK9pQ2mZ7wL] (Simple).funscript', { videos: ['[Official Music Video] Title [xK9pQ2mZ7wL].mp4'] });
    expect(r.variantLabel).toBe('Simple');
    expect(r.isAxis).toBe(false);
  });

  it('(AUTO-BPM) is a variant and the raw label is kept as written', () => {
    const r = classify('Title (AUTO-BPM).funscript', { videos: ['Title.mp4'] });
    expect(r.variantLabel).toBe('AUTO-BPM');
  });

  it('no matching video anywhere → nothing is detected as a variant', () => {
    const r = classify('Orphan-soft.funscript');
    expect(r.variantLabel).toBeNull();
    expect(r.autoDetected).toBe(false);
  });
});

describe('mode "off" restores the pre-feature behaviour verbatim (spec §3)', () => {
  const videos = ['Title.mp4'];

  it('parentheses still produce variants', () => {
    expect(classify('Title (Soft).funscript', { videos, mode: 'off' }).variantLabel).toBe('Soft');
  });

  it('.L is still an ambiguous variant', () => {
    const r = classify('Title.soft.funscript', { videos, mode: 'off' });
    expect(r.variantLabel).toBe('soft');
    expect(r.isAmbiguousDotVariant).toBe(true);
  });

  it('no new separators: dash, underscore, bracket and space stay primaries', () => {
    for (const name of ['Title-soft.funscript', 'Title_soft.funscript', 'Title [Soft].funscript', 'Title Soft.funscript']) {
      expect(classify(name, { videos, mode: 'off' }).variantLabel).toBeNull();
    }
  });

  it('no noise guard: legacy behaviour is kept exactly', () => {
    expect(classify('Title (1080p).funscript', { videos, mode: 'off' }).variantLabel).toBe('1080p');
    expect(classify('Title-part2.funscript', { videos, mode: 'off' }).variantLabel).toBeNull();
  });

  it('the full-name video guard still applies, as before', () => {
    const r = classify('Title (Soft).funscript', { videos: ['Title (Soft).mp4'], mode: 'off' });
    expect(r.variantLabel).toBeNull();
    expect(r.videoBase).toBe('title (soft)');
  });
});

describe('resolveAutoVariantMode', () => {
  it('defaults to strict for missing or unknown values', () => {
    for (const value of [undefined, null, '', 'auto', 'Strict-ish']) {
      expect(resolveAutoVariantMode(value)).toBe('strict');
    }
  });

  it('accepts off and generic case-insensitively', () => {
    expect(resolveAutoVariantMode('OFF')).toBe('off');
    expect(resolveAutoVariantMode(' Generic ')).toBe('generic');
  });
});

describe('Display-only label disambiguation (spec §7)', () => {
  it('duplicate labels from different sources get the source name appended', () => {
    const variants = [
      { label: 'Soft', path: '/A/Title (Soft).funscript', sourceName: 'SourceA' },
      { label: 'Soft', path: '/B/Title (Soft).funscript', sourceName: 'SourceB' },
    ];
    disambiguateVariantLabels(variants);
    expect(variants.map((v) => v.displayLabel)).toEqual(['Soft (SourceA)', 'Soft (SourceB)']);
    expect(variants.map((v) => v.label)).toEqual(['Soft', 'Soft']);
  });

  it('duplicates inside one source fall back to the nearest folder name', () => {
    const variants = [
      { label: 'Soft', path: '/lib/FolderA/Title (Soft).funscript', sourceName: 'SourceA' },
      { label: 'soft', path: '/lib/FolderB/Title (soft).funscript', sourceName: 'SourceA' },
    ];
    disambiguateVariantLabels(variants);
    expect(variants.map((v) => v.displayLabel)).toEqual(['Soft (FolderA)', 'soft (FolderB)']);
  });

  it('a scan without a source map uses folder names directly', () => {
    const variants = [
      { label: 'Default', path: '/lib/FolderA/Title.funscript' },
      { label: 'Default', path: '/lib/FolderB/Title.funscript' },
    ];
    disambiguateVariantLabels(variants);
    expect(variants.map((v) => v.displayLabel)).toEqual(['Default (FolderA)', 'Default (FolderB)']);
  });

  it('same source AND same folder get a numeric fallback', () => {
    const variants = [
      { label: 'Soft', path: '/lib/FolderA/Title (Soft).funscript', sourceName: 'SourceA' },
      { label: 'Soft', path: '/lib/FolderA/Title (soft).funscript', sourceName: 'SourceA' },
    ];
    disambiguateVariantLabels(variants);
    expect(variants.map((v) => v.displayLabel)).toEqual(['Soft (FolderA)', 'Soft (FolderA 2)']);
  });

  it('unique labels are left untouched', () => {
    const variants = [
      { label: 'Default', path: '/lib/A/Title.funscript', sourceName: 'A' },
      { label: 'Soft', path: '/lib/A/Title (Soft).funscript', sourceName: 'A' },
    ];
    disambiguateVariantLabels(variants);
    expect(variants.every((v) => v.displayLabel === undefined)).toBe(true);
  });

  it('handles Windows paths and a missing label', () => {
    const variants = [
      { label: 'Soft', path: 'F:\\lib\\FolderA\\Title (Soft).funscript' },
      { label: 'Soft', path: 'F:\\lib\\FolderB\\Title (Soft).funscript' },
      { label: '', path: 'F:\\lib\\FolderA\\weird.funscript' },
    ];
    disambiguateVariantLabels(variants);
    expect(variants[0].displayLabel).toBe('Soft (FolderA)');
    expect(variants[1].displayLabel).toBe('Soft (FolderB)');
    expect(variants[2].displayLabel).toBeUndefined();
  });

  it('is a no-op for fewer than two variants', () => {
    const variants = [{ label: 'Soft', path: '/lib/A/Title (Soft).funscript' }];
    expect(disambiguateVariantLabels(variants)).toEqual(variants);
    expect(variants[0].displayLabel).toBeUndefined();
  });
});

describe('Deterministic variant ordering', () => {
  // Regression for the flip-flopping dropdown. The comparator the scan used
  // returned -1 whenever `a.label === 'Default'` — including when `b.label`
  // was 'Default' too — so cmp(a,b) and cmp(b,a) both said "a goes first".
  // V8 flipped such a pair on every sort call, and because §7 disambiguation
  // numbers its fallback tags by POSITION, two same-named funscripts swapped
  // rows AND swapped their display labels every time the dropdown re-scanned.
  const DANCER = { label: 'Default', path: 'D:/Y/SLIB/FunScriptDancer/rq/1618362349/PENTHOUSE1/PENTHOUSE (1).funscript' };
  const FLOW = { label: 'Default', path: 'D:/Y/SLIB/FunscriptFlow/rq/1618362349/PENTHOUSE1/PENTHOUSE (1).funscript' };

  it('puts Default first, then labels alphabetically', () => {
    const variants = [
      { label: 'Intense', path: '/lib/a/Title.intense.funscript' },
      { label: 'Default', path: '/lib/a/Title.funscript' },
      { label: 'Soft', path: '/lib/a/Title.soft.funscript' },
    ];
    expect(sortVariantsForDisplay(variants).map((v) => v.label)).toEqual(['Default', 'Intense', 'Soft']);
  });

  it('orders two Default variants by path, not by the order the scan found them', () => {
    const forward = sortVariantsForDisplay([{ ...DANCER }, { ...FLOW }]).map((v) => v.path);
    const reverse = sortVariantsForDisplay([{ ...FLOW }, { ...DANCER }]).map((v) => v.path);
    expect(forward).toEqual(reverse);
    expect(forward).toEqual([DANCER.path, FLOW.path]);
  });

  it('gives the same order for every input permutation', () => {
    const items = [
      { label: 'Soft', path: '/lib/M/Title (Soft).funscript' },
      { label: 'Default', path: '/lib/Z/Title.funscript' },
      { label: 'Soft', path: '/lib/B/Title (Soft).funscript' },
      { label: 'Default', path: '/lib/A/Title.funscript' },
    ];
    const permutations = (list) => (list.length <= 1
      ? [list]
      : list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])));
    const expected = [
      '/lib/A/Title.funscript',
      '/lib/Z/Title.funscript',
      '/lib/B/Title (Soft).funscript',
      '/lib/M/Title (Soft).funscript',
    ];
    const orders = permutations(items).map((p) => sortVariantsForDisplay(p).map((v) => v.path));
    expect(orders).toHaveLength(24);
    for (const order of orders) expect(order).toEqual(expected);
  });

  it('is a no-op for fewer than two variants', () => {
    const one = [{ label: 'Default', path: '/lib/A/Title.funscript' }];
    expect(sortVariantsForDisplay(one)).toBe(one);
    expect(sortVariantsForDisplay(null)).toEqual([]);
  });

  it('two Default scripts from different sources are tagged with their own source', () => {
    // The scan tags each variant with the source its OWN file lives in, so §7
    // separates cross-source duplicates instead of falling back to a leaf
    // folder name both scripts happen to share.
    const variants = [
      { ...DANCER, sourceName: 'FunScriptDancer' },
      { ...FLOW, sourceName: 'FunscriptFlow' },
    ];
    sortVariantsForDisplay(variants);
    disambiguateVariantLabels(variants);
    expect(variants.map((v) => v.displayLabel)).toEqual([
      'Default (FunScriptDancer)',
      'Default (FunscriptFlow)',
    ]);
    // `label` itself stays untouched: it is the persistence key.
    expect(variants.map((v) => v.label)).toEqual(['Default', 'Default']);
  });
});
