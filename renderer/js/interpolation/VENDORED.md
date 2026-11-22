# Vendored: framegen real-time interpolation runtime

Provenance
- Source: https://github.com/MONZikWasTaken/Framegen — npm package `framegen@1.4.0`
  (tarball sha512-NqK6nckQMqW6l...T5MSTmxtvojQQ==), repo commit dc8000fd711a32b52ee0f5e6e90a1fa8622e04bd.
- Files: `rt.js` (MIT, unmodified), `sr.js` (MIT, TinySR upscale, unmodified),
  `index.d.ts` (MIT), `LICENSE` (MIT, code), `weights/rt_v7s.bin|.json` (v7-small
  t-factored student, 2.9 MB), `weights/rt_sr.bin|.json` (TinySR).
- `rt.js`/`sr.js` are ESM; import as `./rt.js`, `./sr.js`. No WASM, no ML framework —
  hand-written WGSL compute kernels (CSP-safe under `script-src 'self'`).

Weights license (IMPORTANT — read before shipping)
- The `.bin` weight blobs are NOT MIT. Per upstream WEIGHTS_LICENSE.md
  (https://github.com/MONZikWasTaken/Framegen/blob/main/WEIGHTS_LICENSE.md):
  "Non-commercial research and personal use only." Unchanged redistribution with
  the notice is allowed; selling or bundling into a paid product/service is not.
  The notice is bundled verbatim at `weights/WEIGHTS_LICENSE.md`.
- DECIDED 2026-11-21 with the user: keep the NC weights vendored, distributed
  unchanged with the notice, for personal/free builds only. FunSync Player is
  GPL-3.0 and free, so this is tolerable, but the NC term conflicts with GPL
  freedoms for downstream recipients — do NOT put these blobs in any paid
  product/service. Revisit before any commercial release; fallback options:
  1. Keep weights out of the distributed artifact: electron-builder `files` must
     exclude `renderer/js/interpolation/weights/*.bin`; the app fetches them at
     runtime (jsDelivr CDN, versioned, CORS-enabled — upstream's supported path)
     into the userData cache on first enable.
  2. Train our own student weights with upstream `tools/train_student.py` on
     permissively-licensed footage (weights then ours).
  3. Ask upstream for commercial/free weight licensing (README: "get in touch").
- `spike.js` + `renderer/interpolation-spike.html` (Phase-0 perf spike harness)
  were removed 2026-11-21 after the feature shipped in `js/frame-interpolator.js`.

API (see index.d.ts)
- `createRT(device, {w,h,weightsBin,weightsManifest,textureInput:true,textureOutput:true,convTune})`
  — w,h must be divisible by 16. rt_v7s is t-factored (film.2.weight) + tfact2
  refine (refine.c0.weight): `prepPair(a,b)` runs the t-free trunk once per pair;
  `runT(t, outTex)` writes one interpolated frame at t in (0,1) — this is what
  makes 2×–6× affordable.
- Input textures: rgba8unorm, usage TEXTURE_BINDING | COPY_DST.
  Output textures: rgba8unorm, usage STORAGE_BINDING | TEXTURE_BINDING.
- `tuneConvRB(device, {ci, co, w16, h16, s2ci})` → persist per GPU+shape (localStorage).
- `profileT(a,b,t,outTex)` → per-stage GPU timings (needs `timestamp-query`).
