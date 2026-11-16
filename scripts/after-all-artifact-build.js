#!/usr/bin/env node
// electron-builder `afterAllArtifactBuild` hook (wired in electron-builder.yml).
//
// Injects the `FunSync-portable.txt` marker into the Windows *zip* artifact
// only. The marker is what opts an unpacked build into portable mode
// (main.js: marker or `data/` next to the exe -> userData = <exeDir>/data).
//
// Why a hook instead of `extraFiles`: extraFiles/extraResources land in
// EVERY win artifact, so the marker would also end up inside the NSIS
// install next to the installed exe — every installed copy would then run
// in portable mode (data in the install dir, auto-update skipped). The zip
// is the only artifact that should carry it.
//
// Fails the build loudly on any error: a zip without the marker is a
// silently broken portable build, which is exactly the class of
// green-build/shipped-broken failure the build.js checks exist to close.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const MARKER_NAME = 'FunSync-portable.txt';
const MARKER_CONTENT =
  'FunSync Player portable-mode marker.\n' +
  '\n' +
  'While this file sits next to "FunSync Player.exe", all app data is kept\n' +
  'in the "data" folder beside it, so the whole folder travels on a USB\n' +
  'stick. Delete this file to go back to the default per-user data location\n' +
  '(%LOCALAPPDATA%).\n';

// electron-builder's zip target archives the win-unpacked CONTENTS at the
// archive root (exe at top level). Be defensive: if a future version wraps
// everything in a single top-level folder, put the marker beside the exe
// there instead of at the root.
function markerPrefix(zip) {
  const names = Object.keys(zip.files);
  if (names.some((n) => /^[^/]+\.exe$/i.test(n))) return '';
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size === 1) return tops.values().next().value + '/';
  throw new Error(
    `Cannot locate the app exe at the root of the zip — unexpected archive layout ` +
    `(${names.slice(0, 10).join(', ')}...). Refusing to place ${MARKER_NAME} blindly.`,
  );
}

async function injectMarker(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const prefix = markerPrefix(zip);
  const markerPath = prefix + MARKER_NAME;
  if (zip.file(markerPath)) {
    console.log(`[afterAllArtifactBuild] ${path.basename(zipPath)} already contains ${markerPath}, leaving it alone`);
    return;
  }
  zip.file(markerPath, MARKER_CONTENT);
  // JSZip re-deflates every entry on regenerate; the win zip is a few
  // hundred MB, so this costs a minute or two on a release build. Acceptable
  // for a once-per-release step, and it keeps the marker guarantee.
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  fs.writeFileSync(zipPath, out);
  console.log(`[afterAllArtifactBuild] added ${markerPath} to ${path.basename(zipPath)}`);
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  const artifacts = (buildResult && buildResult.artifactPaths) || [];
  const zips = artifacts.filter((p) => p.toLowerCase().endsWith('.zip'));
  if (zips.length === 0) return;
  for (const zipPath of zips) {
    await injectMarker(zipPath);
  }
};
