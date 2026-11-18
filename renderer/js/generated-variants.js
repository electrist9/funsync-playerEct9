/**
 * Generated funscripts as script variations.
 *
 * The generate dialog writes its scripts into the app's own store folder
 * (`<userData>/generated-scripts`), not beside the video, so the library scan
 * can never find them. The backend hands them over through
 * `GET /api/generate/store`, where every item carries an absolute `path`; this
 * turns those records into variation rows the player can switch to.
 *
 * Rows carry `_generatedFamily` rather than the `_autoDetected` / `_isManual`
 * flags, which is what makes the chip say "audio" / "motion" instead of a plain
 * "auto". Nothing here is persisted: the rows are rebuilt from the store, so
 * turning the feature off — or deleting a script in the generate dialog —
 * leaves nothing behind to clean up.
 */

import { engineFamilyOf } from './generate-panel.js';

/**
 * The engine families the player knows how to label and switch to.
 * `engineFamilyOf` hands back whatever prefix an engine string carries, so a
 * store written by a newer backend (`depth`, say) would otherwise arrive as a
 * row with no chip and the wrong label. Unknown families stay out of the list.
 */
const SUPPORTED_FAMILIES = new Set(['audio', 'motion']);

/**
 * Store records shaped as variation rows, in the store's newest-first order.
 *
 * Records the player could not load are skipped: no id (nothing points back at
 * the store), an unknown engine (no label for it), or no `path` (the route
 * drops records whose file is gone, but an older backend sends no path at all).
 * One row per engine family — the store keeps one script per video and family,
 * so a second audio row would only be noise.
 *
 * @param items `data.items` from GET /api/generate/store; unknown keys ignored
 * @param labelFor (family: 'audio' | 'motion') => string, the localised label
 * @returns rows `[{ label, path, name, _generatedFamily, scriptId }]`
 */
export function generatedVariantRows(items, labelFor) {
  if (!Array.isArray(items)) return [];
  const label = typeof labelFor === 'function' ? labelFor : (family) => family;
  const rows = [];
  const seenPaths = new Set();
  const seenFamilies = new Set();
  for (const item of items) {
    const scriptId = typeof item?.id === 'string' ? item.id : '';
    const path = typeof item?.path === 'string' ? item.path : '';
    const family = engineFamilyOf(item);
    if (!scriptId || !path || !SUPPORTED_FAMILIES.has(family)) continue;
    if (seenPaths.has(path) || seenFamilies.has(family)) continue;
    seenPaths.add(path);
    seenFamilies.add(family);
    rows.push({
      label: label(family),
      path,
      // The file name inside the store folder. Shown in the tooltip in place of
      // the absolute path, which is the app's business and not the user's.
      name: typeof item.filename === 'string' && item.filename
        ? item.filename
        : path.split(/[\\/]/).pop(),
      _generatedFamily: family,
      scriptId,
    });
  }
  return rows;
}

/**
 * The newest generated script per video, keyed for a join against the library.
 *
 * The library's 「一致あり」 filter asks whether a video has a script at all.
 * Generated scripts live in the store folder, which the scan never walks, so
 * the scan alone answers "no" for a video whose only script was generated. The
 * store hands over every record through `GET /api/generate/store` (no
 * `video_path` = all records); this turns them into a lookup the library joins
 * against its own video paths.
 *
 * `list_all()` is newest-first, so the first record seen for a video is the
 * newest — later records for the same video are older and skipped. Records
 * without a `video_path` cannot be joined, and records without a `path` cannot
 * be loaded (the route drops gone files, but an older backend sends no path).
 *
 * Unlike `generatedVariantRows`, an unknown engine family is KEPT here: the
 * library only needs to know that a script exists, and a family it cannot
 * label still plays — the badge just falls back to the plain auto marker.
 *
 * @param items `data.items` from GET /api/generate/store; unknown keys ignored
 * @param normalizePath (path) => string, canonical key for the join
 * @returns Map<normalised video path, { scriptId, path, family, filename }>
 */
export function generatedScriptsByVideo(items, normalizePath) {
  if (!Array.isArray(items)) return new Map();
  const normalize = typeof normalizePath === 'function' ? normalizePath : (p) => String(p ?? '');
  const byVideo = new Map();
  for (const item of items) {
    const videoPath = typeof item?.video_path === 'string' ? item.video_path : '';
    const path = typeof item?.path === 'string' ? item.path : '';
    if (!videoPath || !path) continue;
    const key = normalize(videoPath);
    if (!key || byVideo.has(key)) continue; // newest-first ⇒ first wins
    byVideo.set(key, {
      scriptId: typeof item.id === 'string' ? item.id : '',
      path,
      family: engineFamilyOf(item),
      filename: typeof item.filename === 'string' ? item.filename : '',
    });
  }
  return byVideo;
}
