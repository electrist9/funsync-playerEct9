/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Unit tests for Script Variant Detection and Management.
// The classification itself lives in electron/funscript-variants.js and is
// covered in depth by tests/unit/auto-variant-detection.test.js; this file
// keeps the original behaviour pins and the grouping / switching logic, and
// now drives them through the real classifier instead of a copy of it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyFunscriptName, sortVariantsForDisplay } from '../../electron/funscript-variants.js';

describe('Variant Detection (scan-directory logic)', () => {
  const DIR = '/lib';
  const VIDEO_EXTS = ['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.mp3', '.wav', '.ogg', '.flac', '.m4a'];

  // Thin wrapper: filename in, classification out. `videos` lets a test say
  // which videos sit next to the script (the scanner builds these two sets).
  function classifyFunscript(filename, videos = []) {
    if (!filename.toLowerCase().endsWith('.funscript')) return null;
    const nameNoExt = filename.slice(0, -'.funscript'.length);

    const videoBaseLocal = new Set();
    const videoBaseGlobal = new Set();
    for (const vname of videos) {
      const dotPos = vname.lastIndexOf('.');
      const vext = dotPos >= 0 ? vname.slice(dotPos).toLowerCase() : '';
      if (!VIDEO_EXTS.includes(vext)) continue;
      const vbase = vname.slice(0, dotPos).toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      videoBaseLocal.add(DIR + '\0' + vbase);
      videoBaseGlobal.add(vbase);
    }

    return classifyFunscriptName(nameNoExt, {
      dir: DIR,
      videoBaseLocal,
      videoBaseGlobal,
      mode: 'strict',
      keywords: [],
    });
  }

  describe('Default (no suffix)', () => {
    it('detects default funscript', () => {
      const result = classifyFunscript('video.funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBeNull();
      expect(result.isAxis).toBe(false);
    });

    it('handles spaces and separators in name', () => {
      const result = classifyFunscript('My_Cool-Video.funscript');
      expect(result.videoBase).toBe('my cool video');
      expect(result.variantLabel).toBeNull();
    });
  });

  describe('Parenthesized variants', () => {
    it('detects (Soft) variant', () => {
      const result = classifyFunscript('video (Soft).funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('Soft');
      expect(result.isAxis).toBe(false);
    });

    it('detects (Intense) variant', () => {
      const result = classifyFunscript('My Video (Intense).funscript');
      expect(result.videoBase).toBe('my video');
      expect(result.variantLabel).toBe('Intense');
    });

    it('handles no space before parenthesis', () => {
      const result = classifyFunscript('video(HalfSpeed).funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('HalfSpeed');
    });
  });

  describe('Dot-separated variants', () => {
    it('detects .intense variant', () => {
      const result = classifyFunscript('video.intense.funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('intense');
      expect(result.isAxis).toBe(false);
    });

    it('detects .halfspeed variant', () => {
      const result = classifyFunscript('video.halfspeed.funscript');
      expect(result.videoBase).toBe('video');
      expect(result.variantLabel).toBe('halfspeed');
    });
  });

  describe('Axis suffixes (NOT variants)', () => {
    it('detects .vib as axis, not variant', () => {
      const result = classifyFunscript('video.vib.funscript');
      expect(result.isAxis).toBe(true);
      expect(result.axisSuffix).toBe('vib');
      expect(result.variantLabel).toBeNull();
    });

    it('detects .twist as axis', () => {
      const result = classifyFunscript('video.twist.funscript');
      expect(result.isAxis).toBe(true);
      expect(result.axisSuffix).toBe('twist');
    });

    it('detects .surge as axis', () => {
      const result = classifyFunscript('video.surge.funscript');
      expect(result.isAxis).toBe(true);
      expect(result.axisSuffix).toBe('surge');
    });

    it('all 10 axis suffixes are detected', () => {
      const axes = ['surge','sway','twist','roll','pitch','vib','lube','pump','suction','valve'];
      for (const axis of axes) {
        const result = classifyFunscript(`video.${axis}.funscript`);
        expect(result.isAxis).toBe(true);
        expect(result.axisSuffix).toBe(axis);
      }
    });

    it('axis detection is case-insensitive', () => {
      const result = classifyFunscript('video.VIB.funscript');
      expect(result.isAxis).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('returns null for non-funscript files', () => {
      expect(classifyFunscript('video.mp4')).toBeNull();
      expect(classifyFunscript('video.txt')).toBeNull();
    });

    it('treats a numeric dot segment as part of the title, not a label', () => {
      const result = classifyFunscript('video.2024.01.funscript');
      // "01" is a bare number, so spec §5 keeps it in the title instead of
      // reading it as a variant label.
      expect(result.variantLabel).toBeNull();
      expect(result.videoBase).toBe('video 2024 01');
    });

    it('handles empty filename', () => {
      const result = classifyFunscript('.funscript');
      expect(result.videoBase).toBe('');
    });
  });

  describe('Variant grouping', () => {
    it('groups variants by video base name', () => {
      const files = [
        'MyVideo.funscript',
        'MyVideo (Soft).funscript',
        'MyVideo (Intense).funscript',
        'MyVideo.vib.funscript',
        'OtherVideo.funscript',
      ];

      const classified = files.map(f => ({ ...classifyFunscript(f), name: f }));
      const myVideoVariants = classified.filter(c => c && c.videoBase === 'myvideo' && !c.isAxis);
      const myVideoAxes = classified.filter(c => c && c.videoBase === 'myvideo' && c.isAxis);

      expect(myVideoVariants).toHaveLength(3); // Default + Soft + Intense
      expect(myVideoAxes).toHaveLength(1); // vib
    });

    it('sorts variants with Default first', () => {
      // Real function, not a copy of the comparator: the inline copy let the
      // broken version pass (see sortVariantsForDisplay for the story).
      const variants = [
        { label: 'Intense', path: '/v.intense.funscript' },
        { label: 'Default', path: '/v.funscript' },
        { label: 'Soft', path: '/v.soft.funscript' },
      ];
      sortVariantsForDisplay(variants);

      expect(variants[0].label).toBe('Default');
      expect(variants[1].label).toBe('Intense');
      expect(variants[2].label).toBe('Soft');
    });

    it('only includes variants array when more than 1', () => {
      const variants = [{ label: 'Default', path: '/v.funscript' }];
      const result = variants.length > 1 ? variants : [];
      expect(result).toEqual([]);
    });
  });
});

describe('Variant Switching', () => {
  it('tracks active variant by path', () => {
    const variants = [
      { label: 'Default', path: '/v.funscript' },
      { label: 'Soft', path: '/v (Soft).funscript' },
      { label: 'Intense', path: '/v.intense.funscript' },
    ];

    let activeIndex = 0;
    let activePath = variants[0].path;

    // Switch to Intense
    activeIndex = 2;
    activePath = variants[2].path;

    // Resolve index from path after array rebuild
    const resolvedIndex = variants.findIndex(v => v.path === activePath);
    expect(resolvedIndex).toBe(2);
    expect(variants[resolvedIndex].label).toBe('Intense');
  });

  it('handles path not found after rebuild (falls back to index)', () => {
    const variants = [
      { label: 'Default', path: '/v.funscript' },
      { label: 'New', path: '/v.new.funscript' },
    ];

    const activePath = '/deleted.funscript';
    const resolvedIndex = variants.findIndex(v => v.path === activePath);
    expect(resolvedIndex).toBe(-1); // not found
  });

  it('cycle forward wraps around', () => {
    const len = 3;
    let idx = 2; // last
    idx = (idx + 1 + len) % len;
    expect(idx).toBe(0); // wraps to first
  });

  it('cycle backward wraps around', () => {
    const len = 3;
    let idx = 0; // first
    idx = (idx - 1 + len) % len;
    expect(idx).toBe(2); // wraps to last
  });
});

describe('Manual Variants', () => {
  it('stores manual variants per video path', () => {
    const manualVariants = {};
    const videoPath = '/videos/test.mp4';

    manualVariants[videoPath] = [];
    manualVariants[videoPath].push({ label: 'Custom', path: '/scripts/custom.funscript', name: 'custom.funscript' });

    expect(manualVariants[videoPath]).toHaveLength(1);
    expect(manualVariants[videoPath][0].label).toBe('Custom');
  });

  it('combines auto-detected and manual variants', () => {
    const autoVariants = [
      { label: 'Default', path: '/v.funscript' },
      { label: 'Soft', path: '/v (Soft).funscript' },
    ];
    const manualVariants = [
      { label: 'Custom', path: '/custom.funscript' },
    ];

    const all = [...autoVariants, ...manualVariants];
    expect(all).toHaveLength(3);
  });

  it('derives label from parenthesized filename', () => {
    const name = 'video (Super Soft).funscript';
    const nameNoExt = name.replace(/\.funscript$/i, '');
    const parenMatch = nameNoExt.match(/\(([^)]+)\)/);
    const label = parenMatch ? parenMatch[1].trim() : nameNoExt;
    expect(label).toBe('Super Soft');
  });

  it('derives label from full filename when no parentheses', () => {
    const name = 'HARDER video script.funscript';
    const nameNoExt = name.replace(/\.funscript$/i, '');
    const parenMatch = nameNoExt.match(/\(([^)]+)\)/);
    const label = parenMatch ? parenMatch[1].trim() : nameNoExt;
    expect(label).toBe('HARDER video script');
  });
});

describe('Scan + dropdown wiring — selection follows the file, not the row', () => {
  // Pins the fix for "variant selection becomes non-deterministic when two
  // funscripts share a filename across sources": the scan must sort with the
  // shared total-order comparator, tag each variant with its OWN source, and
  // the renderer must resolve the active row from the active path.
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  const main = read('../../electron/main.js');
  const app = read('../../renderer/js/app.js');

  const dropdown = app.slice(
    app.indexOf('_showVariantDropdown() {'),
    app.indexOf('// Add variation button'),
  );
  const switchBody = app.slice(
    app.indexOf('async _switchVariant(index) {'),
    app.indexOf('// Cloud-sync re-uploads'),
  );

  it('main.js sorts variants with the shared deterministic comparator', () => {
    expect(main).toContain('sortVariantsForDisplay(variants);');
    // The old inline comparator: not a total order, flipped a pair of
    // 'Default' variants on every scan. It existed twice (exact match and
    // fuzzy match), so pin that both call sites are gone.
    expect(main).not.toContain("if (a.label === 'Default') return -1;");
    expect(main).not.toContain("a.label === 'Default' ? -1");
  });

  it('main.js tags each variant with the source its own file lives in', () => {
    expect(main).toContain('v.sourceName = sourceNameFor(v.path) || sourceName;');
    // Tagging every variant with the VIDEO's source made cross-source
    // duplicates indistinguishable, so §7 fell back to a folder tag both
    // scripts shared and the labels became position-derived.
    expect(main).not.toContain('for (const v of variants) v.sourceName = sourceName;');
  });

  it('the dropdown marks the row whose path is the active variant', () => {
    expect(dropdown).not.toBe('');
    expect(dropdown).toContain('variants.findIndex((v) => v.path === activePath)');
    expect(dropdown).toContain('if (i === markerIndex) item.classList.add');
    expect(dropdown).not.toContain('if (i === this._activeVariantIndex) item.classList.add');
  });

  it('_switchVariant re-homes a stale index instead of reloading the same script', () => {
    expect(switchBody).not.toBe('');
    expect(switchBody).toContain('variant.path === this._activeVariantPath');
    expect(switchBody).toContain('this._activeVariantIndex = index;');
  });
});

describe('Variant provenance — auto-detected vs added by hand is visible', () => {
  // The two kinds of row used to look identical in the player dropdown, so the
  // only way to learn which was which was to try removing one (manual rows can
  // be removed, auto rows come back on the next scan). Provenance is derived at
  // render time from flags that already exist — no new persistence.
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  const app = read('../../renderer/js/app.js');
  const popout = read('../../renderer/player-popout.js');
  const css = read('../../renderer/styles/player.css');

  const merge = app.slice(
    app.indexOf('_updateVariantSelector() {'),
    app.indexOf('// Resolve active index from stored path'),
  );
  const dropdown = app.slice(
    app.indexOf('_showVariantDropdown() {'),
    app.indexOf('// Add variation button'),
  );
  const stream = app.slice(
    app.indexOf('_streamPlayerWindowData() {'),
    app.indexOf('_relayUpNext(fields)'),
  );
  const popoutRows = popout.slice(
    popout.indexOf('function renderVariants('),
    popout.indexOf('// --- Up Next card'),
  );

  it('tags manual rows at the merge — as a copy, never into settings', () => {
    expect(merge).not.toBe('');
    expect(merge).toContain('.map(v => ({ ...v, _isManual: true }))');
    // The untagged merge: `manual` is a live reference into
    // settings.library.manualVariants, so annotating it in place would persist
    // `_isManual` into config.json and into backups.
    expect(merge).not.toContain('const deduped = manual.filter(v => !seenPaths.has(v.path));');
  });

  it('the inline dropdown renders a provenance chip on each row', () => {
    expect(dropdown).not.toBe('');
    expect(dropdown).toContain('const origin = variantOrigin(v);');
    expect(dropdown).toContain('variant-selector__tag variant-selector__tag--${origin}');
    expect(dropdown).toContain("'variants.autoTag'");
    expect(dropdown).toContain("'variants.manualTag'");
    // The tooltip carries the path, which is what separates two same-named
    // scripts from different sources.
    expect(dropdown).toContain('variants.autoTagTitle');
    expect(dropdown).toContain('variants.manualTagTitle');
  });

  it('the pop-out payload carries origin and its dropdown renders the same chip', () => {
    expect(stream).toContain('origin: variantOrigin(v)');
    expect(popoutRows).not.toBe('');
    // Unknown origin (anything but the two known values) gets no chip.
    expect(popoutRows).toContain("v.origin === 'auto' || v.origin === 'manual'");
    expect(popoutRows).toContain('variant-selector__tag variant-selector__tag--${origin}');
    expect(popoutRows).toContain("'variants.autoTag'");
    // `is-active` had no rule in player.css, so the selected row was never
    // marked in the pop-out. Both dropdowns now share the styled class.
    expect(popoutRows).toContain("item.classList.add('variant-selector__item--active')");
    expect(popoutRows).not.toContain("item.classList.add('is-active')");
  });

  it('the chip is styled once, in the stylesheet both dropdowns load', () => {
    expect(css).toMatch(/\.variant-selector__tag\s*\{/);
    expect(css).toMatch(/\.variant-selector__tag--manual\s*\{/);
    // The label keeps flex:1, so a long name ellipsizes instead of pushing the
    // chip out of the 320px dropdown.
    expect(css).toMatch(/\.variant-selector__item-label\s*\{[^}]*flex:\s*1/);
  });

  it('every locale ships the chip labels and their tooltips', () => {
    // locale-key-parity.test.js proves the keys exist in all eight; this pins
    // that the new ones are actually filled in, not empty strings.
    for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const json = JSON.parse(read(`../../renderer/locales/${locale}.json`));
      for (const key of ['autoTag', 'manualTag', 'autoTagTitle', 'manualTagTitle']) {
        expect(json.variants[key], `${locale}.json variants.${key}`).toBeTruthy();
      }
    }
  });
});
