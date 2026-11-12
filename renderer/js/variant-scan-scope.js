// Scan scope for the variant dropdown's refresh-on-open (renderer/js/app.js).
//
// `_refreshCurrentVariantsFromDisk()` re-scans the disk when the dropdown is
// opened, so a variant dropped in later shows up without a full library
// refresh. It used to scan ONLY the video's own folder — which is wrong for a
// separate funscript-folder source: docs/SPEC-auto-variant-detection.md §4
// guard1 deliberately pairs a script whose video lives in ANOTHER source
// (same-directory priority, then global fallback), so the video's folder
// contains no scripts at all, the rescan reports zero variants, and the
// comparison "fresh vs cached" wipes the set the library scan had just found.
// The dropdown then collapses to a single "Default" entry.
//
// These helpers are pure so the scope rule can be pinned by tests; app.js owns
// the IPC call.

import { canonicalPath, dirOfPath } from './path-utils.js';

/**
 * Folders a refresh-on-open scan must cover for one video: the video's own
 * folder first, then every folder the cached variant set lives in, in first-
 * seen order and deduplicated by `canonicalPath` (so a variant that was
 * re-homed onto a differently-spelled but identical folder doesn't scan twice).
 *
 * Rescanning the cached variant folders is what makes the fresh-vs-cached
 * comparison honest: both sides then describe the same scope, so a script that
 * really was deleted still gets pruned, while a cross-directory set survives.
 *
 * @param {string} videoPath — absolute path of the playing video
 * @param {Array<{path?: string}>} [variants] — cached auto-detected variants
 * @returns {string[]} dirs to scan; empty when videoPath has no folder part
 */
export function variantScanDirs(videoPath, variants) {
  const raw = String(videoPath || '');
  const videoDir = dirOfPath(raw);
  // A bare filename (no directory part) has nothing to rescan.
  if (!videoDir || videoDir === raw) return [];

  const dirs = [videoDir];
  const seen = new Set([canonicalPath(videoDir)]);
  for (const v of (Array.isArray(variants) ? variants : [])) {
    const dir = dirOfPath(v?.path || '');
    if (!dir) continue;
    const key = canonicalPath(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Did a folder that hosts one of the cached variants FAIL to scan?
 *
 * `scan-directory` reports unreachable folders in `failedPaths` instead of
 * returning an empty listing. An unreachable folder is not an empty folder:
 * treating it as empty would prune live variants whenever a drive sleeps or a
 * network share drops, the exact mistake the association validator made on
 * 2026-08-11. Callers keep their cached variant set when this returns true.
 *
 * @param {Array<{path?: string}>} [variants] — cached auto-detected variants
 * @param {string[]} [failedPaths] — `failedPaths` from the scan result
 * @returns {boolean}
 */
export function variantFoldersUnreachable(variants, failedPaths) {
  const failed = new Set(
    (Array.isArray(failedPaths) ? failedPaths : [])
      .map((p) => canonicalPath(p))
      .filter(Boolean),
  );
  if (failed.size === 0) return false;
  return (Array.isArray(variants) ? variants : [])
    .some((v) => failed.has(canonicalPath(dirOfPath(v?.path || ''))));
}
