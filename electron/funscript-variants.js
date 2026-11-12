'use strict';

/**
 * Auto funscript variant detection — the shared classification rules.
 *
 * Implements docs/SPEC-auto-variant-detection.md. Required by electron/main.js
 * (the `scan-directory` handler) and imported directly by the unit tests, so
 * this file must stay plain CommonJS: no ESM syntax and no `require('electron')`
 * at module scope (vitest loads it outside Electron).
 *
 * A funscript filename is `<base><separator><label>.funscript`. Which
 * separators count as a variant boundary depends on
 * `settings.library.autoVariantMode`:
 *   - 'strict'  (default) — only unambiguous separators, and only whitelisted
 *                 labels for the separators that can also occur inside a real
 *                 title. Matches the RAW filename, because normalizeName()
 *                 folds `-`, `_` and `.` into spaces and would erase the very
 *                 separator we are trying to detect.
 *   - 'generic' — same guards, but any non-noise label and space-separated
 *                 labels are allowed too.
 *   - 'off'     — the pre-feature behaviour, verbatim (full rollback).
 */

/** Multi-axis scripts: `<base>.<axis>.funscript`. Never a variant. */
const AXIS_SUFFIXES = new Set([
  'surge', 'sway', 'twist', 'roll', 'pitch', 'vib', 'lube', 'pump', 'suction', 'valve',
]);

/**
 * Normalize a basename for matching: lowercase, separators to spaces,
 * collapse runs. Identical to the copy that used to live inline in
 * scan-directory; kept here so the classifier and the scan agree.
 */
const normalizeName = (name) => name.toLowerCase().replace(/[_.\-]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The strict-mode label whitelist (spec §4). English only — the labels users
 * actually write on funscripts are English regardless of UI language, and a
 * locale-translated whitelist would make detection depend on the UI language.
 * `library.variantKeywords` extends this list; it never replaces it.
 */
const VARIANT_KEYWORDS = [
  'soft', 'gentle', 'light', 'easy',
  'intense', 'hard', 'rough', 'heavy', 'edgy',
  'fast', 'slow',
  'extended', 'short',
  'loop', 'alt', 'pov', 'bonus', 'preview', 'teaser', 'intro',
];

/**
 * Mirror of renderer/js/fuzzy-match.js::NOISE_TOKENS. The renderer is a
 * sandboxed ESM context and cannot require this CommonJS file, so the list is
 * duplicated here; tests/unit/funscript-variant-noise-parity.test.js pins the
 * two copies against each other so they cannot drift silently.
 */
const NOISE_TOKENS = new Set([
  // source / container / codec
  'web', 'webdl', 'webrip', 'bluray', 'brrip', 'bdrip', 'dvdrip', 'hdtv', 'dl',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac', 'ac3', 'dts', 'mp4', 'mkv', 'avi', 'wmv', 'm4v',
  'hdr', 'sdr', 'hq', 'uhd', 'fhd', 'remux', 'proper', 'repack',
  // VR packing / projection
  'lr', 'rl', 'tb', 'bt', 'sbs', 'ou', 'mono', '3dh', '3dv', '2d', '3d',
  'vr', '180', '360', 'fisheye', 'equirect', 'mkx200', 'mkx220', 'rf52',
  'vrca220', 'oculus', 'quest', 'smartphone',
  // misc
  'funscript', 'script',
]);

/** True when a token carries no scene information (fuzzy-match parity). */
function isNoiseToken(t) {
  if (!t) return true;
  if (NOISE_TOKENS.has(t)) return true;
  if (/^\d{3,4}p$/.test(t)) return true;        // 720p 1080p 1920p 2160p
  if (/^\d+k$/.test(t)) return true;            // 4k 8k
  if (/^\d+x\d+$/.test(t)) return true;         // 180x180, 1920x1080
  if (/^(19|20)\d{2}$/.test(t)) return true;    // release years
  if (/^\d+fps$/.test(t)) return true;
  return false;
}

/**
 * Extra patterns the fuzzy matcher does not need but variant labels do:
 * a label that is only a number or only an episode/part marker says nothing
 * about which variation of the scene this script is.
 */
const NUMERIC_TOKEN_RE = /^\d+$/;
const SEQUENCE_TOKEN_RE = /^(?:part|pt|ep|episode|chap|chapter|vol|volume|sect|section|scene|seg|segment|track|disc|cd|act|take|cut)\d+$/i;
const EPISODE_TOKEN_RE = /^s\d{1,2}(?:[._-]?e\d{1,3})+$/i;   // S01E03, s1_e2
const EPISODE_ONLY_RE = /^e\d{1,3}$/i;                       // E03

/** True for `part2`, `ep04`, `take3` … — sequence markers, not variations. */
function isSequenceToken(t) {
  if (!t) return true;
  return SEQUENCE_TOKEN_RE.test(t) || EPISODE_TOKEN_RE.test(t) || EPISODE_ONLY_RE.test(t);
}

/** True for a token that is nothing but digits (`2024`, `01`, `3`). */
function isNumericToken(t) {
  return /^\d+$/.test(String(t == null ? '' : t));
}

/**
 * True for upload IDs / hashes — `[xK9pQ2mZ7wL]` style tags that some
 * scrapers append. Only used for the bracket separator, where such tags are
 * common; the other separators are already restricted enough.
 */
function isIdLikeToken(t) {
  const s = String(t == null ? '' : t);
  if (!/^[A-Za-z0-9]{8,14}$/.test(s)) return false;
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/\d/.test(s)) return false;
  // Mixed case + digits alone is not enough: real labels such as
  // "HalfSpeed2" look like that too. An ID/hash reads as noise because it
  // carries no word shape — no vowels at all ("xK9pQ2mZ7wL") or digits
  // scattered through the token rather than trailing a word ("abc12def34").
  if (!/[aeiouAEIOU]/.test(s)) return true;
  return (s.match(/\d+/g) || []).length >= 2;
}

/**
 * True when a candidate label carries no variation information: empty, a
 * release tag, a bare number, or an episode/part marker. Applied in every
 * mode except 'off' (spec §5, guard 3).
 */
function isVariantLabelNoise(label) {
  const raw = String(label == null ? '' : label).trim();
  if (!raw) return true;
  const tokens = raw.split(/[\s.\-_\()[\]{}]+/).filter(Boolean);
  if (!tokens.length) return true;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (isNoiseToken(token) || isNoiseToken(lower)) return true;
    if (isNumericToken(token)) return true;
    if (isSequenceToken(lower)) return true;
  }
  return false;
}

/**
 * Whitelist test for strict mode. Exact, whole-label match (case- and
 * whitespace-insensitive) against the built-in keywords plus the user's
 * `library.variantKeywords`. A multi-word label only matches a multi-word
 * keyword the user added.
 */
function keywordMatches(label, extraKeywords) {
  const norm = String(label == null ? '' : label).trim().toLowerCase();
  if (!norm) return false;
  for (const keyword of VARIANT_KEYWORDS) if (keyword === norm) return true;
  if (Array.isArray(extraKeywords)) {
    for (const keyword of extraKeywords) {
      const custom = String(keyword == null ? '' : keyword).trim().toLowerCase();
      if (custom && custom === norm) return true;
    }
  }
  return false;
}

/** Clamp a stored setting to one of the three documented modes. */
function resolveAutoVariantMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  if (mode === 'off') return 'off';
  if (mode === 'generic') return 'generic';
  return 'strict';
}

// Separator patterns, matched against the RAW basename (no extension).
const PAREN_RE = /^(.+?)\s*\(([^)]+)\)\s*$/;
const BRACKET_RE = /^(.+?)\s*\[([^\]]+)\]\s*$/;
// Lazy base + `[^-_]+$` pins the LAST separator, so "My-Title-soft" splits as
// base "My-Title" / label "soft" instead of base "My" / label "Title-soft".
const DASH_RE = /^(.+?)\s*[-_]\s*([^-_]+)$/;
const SPACE_RE = /^(.+?)\s+([^\s]+)$/;

/** Nearest folder name of a script path — the §7 fallback origin tag. */
function folderNameOf(p) {
  let s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
  // Drop the file name first: the tag is the folder the script lives in.
  let idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (idx < 0) return '';
  s = s.slice(0, idx).replace(/[\\/]+$/, '');
  idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * Classify one funscript basename (extension already stripped).
 *
 * @param {string} nameNoExt  raw basename without `.funscript`
 * @param {object} options
 * @param {string} options.dir                 directory the script lives in
 * @param {Set}    options.videoBaseLocal      `dir + '\0' + normalizedBase` of every video
 * @param {Set}    options.videoBaseGlobal     normalizedBase of every video
 * @param {string} options.mode                'strict' | 'generic' | 'off'
 * @param {string[]} options.keywords          extra whitelist entries
 * @returns {{videoBase: string, variantLabel: string|null, isAxis: boolean,
 *            axisSuffix: string|null, isAmbiguousDotVariant: boolean,
 *            autoDetected: boolean, fullNormalisedBase: string}}
 */
function classifyFunscriptName(nameNoExt, options = {}) {
  const dir = options.dir == null ? '' : String(options.dir);
  const videoBaseLocal = options.videoBaseLocal;
  const videoBaseGlobal = options.videoBaseGlobal;
  const mode = resolveAutoVariantMode(options.mode);
  const keywords = options.keywords;

  const fullNormalisedBase = normalizeName(nameNoExt);
  const hasVideo = (normalizedBase) => {
    if (videoBaseLocal && videoBaseLocal.has(dir + '\0' + normalizedBase)) return true;
    return !!(videoBaseGlobal && videoBaseGlobal.has(normalizedBase));
  };

  // Primary candidate: the whole name is the title.
  const asPrimary = () => ({
    videoBase: fullNormalisedBase,
    variantLabel: null,
    isAxis: false,
    axisSuffix: null,
    isAmbiguousDotVariant: false,
    autoDetected: false,
    fullNormalisedBase,
  });

  const asVariant = (normalizedBase, label, ambiguous) => ({
    videoBase: normalizedBase,
    variantLabel: label,
    isAxis: false,
    axisSuffix: null,
    isAmbiguousDotVariant: !!ambiguous,
    autoDetected: true,
    fullNormalisedBase,
  });

  const dotIdx = nameNoExt.lastIndexOf('.');
  const dotSuffix = dotIdx >= 0 ? nameNoExt.slice(dotIdx + 1).toLowerCase() : null;

  // Axis scripts win over every other reading: `Title.vib.funscript` and
  // `Title (Soft).vib.funscript` are multi-axis parts of the base script,
  // never variants (spec §5, guard 3).
  if (dotSuffix && AXIS_SUFFIXES.has(dotSuffix)) {
    return {
      videoBase: normalizeName(nameNoExt.slice(0, dotIdx)),
      variantLabel: null,
      isAxis: true,
      axisSuffix: dotSuffix,
      isAmbiguousDotVariant: false,
      autoDetected: false,
      fullNormalisedBase,
    };
  }

  const parenMatch = nameNoExt.match(PAREN_RE);

  if (mode === 'off') {
    // Pre-feature behaviour, kept verbatim so the setting is a real rollback.
    if (parenMatch) {
      if (hasVideo(fullNormalisedBase)) return asPrimary();
      return asVariant(normalizeName(parenMatch[1]), parenMatch[2].trim(), false);
    }
    if (dotSuffix && dotIdx > 0) {
      return asVariant(normalizeName(nameNoExt.slice(0, dotIdx)), dotSuffix, true);
    }
    return asPrimary();
  }

  // Guard 2 first, everywhere: if a video exists whose full name (trailing
  // separator group included) matches, the script is that video's primary.
  const fullMatchIsVideo = hasVideo(fullNormalisedBase);

  // `(L)` — unrestricted label width, unchanged from the current behaviour.
  // Parenthesised variant suffixes are unambiguous user intent, so this
  // separator keeps NOT requiring a video for the stripped base.
  if (parenMatch) {
    if (fullMatchIsVideo) return asPrimary();
    const label = parenMatch[2].trim();
    if (isVariantLabelNoise(label)) return asPrimary();
    return asVariant(normalizeName(parenMatch[1]), label, false);
  }

  // `[L]` — strict: whitelist only. generic: any non-noise label.
  // Extra guard: upload-ID-looking labels are never variants.
  const bracketMatch = nameNoExt.match(BRACKET_RE);
  if (bracketMatch) {
    if (fullMatchIsVideo) return asPrimary();
    const label = bracketMatch[2].trim();
    if (isVariantLabelNoise(label)) return asPrimary();
    const labelTokens = label.split(/[\s.\-_\()[\]{}]+/).filter(Boolean);
    if (labelTokens.some(isIdLikeToken)) return asPrimary();
    if (mode === 'strict' && !keywordMatches(label, keywords)) return asPrimary();
    const base = normalizeName(bracketMatch[1]);
    if (!base || !hasVideo(base)) return asPrimary();
    return asVariant(base, label, false);
  }

  // `.L` — ambiguous by nature ("video.intense" vs "S01.E03"). Kept as the
  // current provisional classification: the scan's sibling post-pass demotes
  // it to a primary when no primary sibling exists.
  if (dotSuffix && dotIdx > 0) {
    if (fullMatchIsVideo) return asPrimary();
    if (isVariantLabelNoise(dotSuffix)) return asPrimary();
    return asVariant(normalizeName(nameNoExt.slice(0, dotIdx)), dotSuffix, true);
  }

  // `[-_]L` / `_L` — spaces around the separator are allowed.
  const dashMatch = nameNoExt.match(DASH_RE);
  if (dashMatch) {
    if (fullMatchIsVideo) return asPrimary();
    const label = dashMatch[2].trim();
    if (isVariantLabelNoise(label)) return asPrimary();
    if (mode === 'strict' && !keywordMatches(label, keywords)) return asPrimary();
    const base = normalizeName(dashMatch[1]);
    if (!base || !hasVideo(base)) return asPrimary();
    return asVariant(base, label, false);
  }

  // ` L` — space only. Too common inside real titles for strict mode, so it
  // is a generic-mode-only separator.
  if (mode === 'generic') {
    const spaceMatch = nameNoExt.match(SPACE_RE);
    if (spaceMatch) {
      if (fullMatchIsVideo) return asPrimary();
      const label = spaceMatch[2].trim();
      if (isVariantLabelNoise(label)) return asPrimary();
      const base = normalizeName(spaceMatch[1]);
      if (!base || !hasVideo(base)) return asPrimary();
      return asVariant(base, label, false);
    }
  }

  return asPrimary();
}

/**
 * Spec §7 — display-only disambiguation of duplicated variant labels.
 *
 * Two variants can legitimately end up with the same label ("Soft" from two
 * sources, or "Soft" and "soft" in one folder, or two "Default" scripts). The
 * switcher would show two identical rows. This appends an origin tag to
 * `displayLabel` only: `label` itself is a persistence key
 * (library.preferredVariants, the star toggle, the phone bridge) and must not
 * change.
 *
 * Origin preference: the scan-time source name when it tells the duplicates
 * apart, otherwise the nearest folder name. Mutates and returns `variants`.
 */
function disambiguateVariantLabels(variants) {
  if (!Array.isArray(variants) || variants.length < 2) return variants || [];

  const labelKeyOf = (v) => String((v && v.label) || '').trim().toLowerCase();

  const labelCounts = new Map();
  for (const v of variants) {
    const key = labelKeyOf(v);
    if (!key) continue;
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }

  // Group the duplicated labels by source name so we can tell whether the
  // source alone is enough to separate them.
  const groups = new Map();
  for (const v of variants) {
    const key = labelKeyOf(v);
    if (!key || (labelCounts.get(key) || 0) < 2) continue;
    const origin = String((v && v.sourceName) || '').trim();
    const groupKey = key + '\0' + origin;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(v);
  }

  for (const [groupKey, members] of groups) {
    const origin = groupKey.slice(groupKey.indexOf('\0') + 1);
    // Same source (or no source at all) cannot tell them apart — fall back to
    // the nearest folder name.
    const useFolder = members.length > 1 || !origin;
    const taken = new Set();
    for (const v of members) {
      const tag = useFolder ? folderNameOf(v.path) : origin;
      if (!tag) continue;
      let display = `${v.label} (${tag})`;
      let n = 2;
      while (taken.has(display.toLowerCase())) display = `${v.label} (${tag} ${n++})`;
      taken.add(display.toLowerCase());
      v.displayLabel = display;
    }
  }

  return variants;
}

/**
 * Deterministic display order for one video's variants: Default first, then
 * label A→Z, then path A→Z.
 *
 * The comparator has to be a TOTAL order. The original inline version returned
 * -1 whenever `a.label === 'Default'` — including when `b.label` was
 * 'Default' too — so cmp(a, b) and cmp(b, a) both claimed "a goes first". V8's
 * sort then flipped such a pair on every call: two same-named funscripts from
 * different sources swapped places on each scan, and because
 * `disambiguateVariantLabels` numbers its fallback tags by POSITION, the two
 * rows also swapped their display labels. The dropdown re-scans on every open,
 * so the highlighted variant appeared to alternate between the two entries.
 *
 * The path tiebreak is what makes the order independent of the directory order
 * the scan happened to be given (the library scan walks the sources in
 * settings order, the dropdown refresh walks the video folder first and then
 * the cached variant folders). Mutates and returns `variants`.
 */
function sortVariantsForDisplay(variants) {
  if (!Array.isArray(variants) || variants.length < 2) return variants || [];
  variants.sort((a, b) => {
    const aDefault = a && a.label === 'Default' ? 0 : 1;
    const bDefault = b && b.label === 'Default' ? 0 : 1;
    if (aDefault !== bDefault) return aDefault - bDefault;
    const byLabel = String((a && a.label) || '').localeCompare(String((b && b.label) || ''));
    if (byLabel) return byLabel;
    const pa = String((a && a.path) || '');
    const pb = String((b && b.path) || '');
    if (pa === pb) return 0;
    return pa < pb ? -1 : 1;
  });
  return variants;
}

module.exports = {
  AXIS_SUFFIXES,
  normalizeName,
  sortVariantsForDisplay,
  VARIANT_KEYWORDS,
  NOISE_TOKENS,
  isNoiseToken,
  isSequenceToken,
  isNumericToken,
  isIdLikeToken,
  isVariantLabelNoise,
  keywordMatches,
  resolveAutoVariantMode,
  classifyFunscriptName,
  disambiguateVariantLabels,
  folderNameOf,
};
