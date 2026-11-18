// Unit tests for the store-record → variation-row shaping step
// (renderer/js/generated-variants.js).
//
// The backend hands over its generated-script store as records; the player
// turns them into script variations. What matters here is what gets dropped and
// what a surviving row carries: a row the player cannot label or switch to is
// worse than no row, and the `_generatedFamily` tag is what makes the chip say
// "audio" / "motion" instead of a plain "auto".
//
// No DOM needed for the shaping itself, but the module imports the generate
// panel, which is a browser module — so this runs in the default jsdom env.
import { describe, it, expect } from 'vitest';
import { generatedVariantRows, generatedScriptsByVideo } from '../../renderer/js/generated-variants.js';

const labelFor = (family) => (family === 'audio' ? 'Generated audio' : 'Generated motion');

const audio = {
  id: 's-audio-1',
  engine: 'audio:clicks',
  filename: 'clip-audio.funscript',
  path: 'C:\\Users\\me\\AppData\\Roaming\\FunSync\\generated-scripts\\clip-audio.funscript',
};
const motion = {
  id: 's-motion-1',
  engine: 'motion:high',
  filename: 'clip-motion.funscript',
  path: 'C:\\Users\\me\\AppData\\Roaming\\FunSync\\generated-scripts\\clip-motion.funscript',
};

describe('generatedVariantRows', () => {
  it('shapes stored scripts as variation rows, newest first', () => {
    const rows = generatedVariantRows([motion, audio], labelFor);
    expect(rows).toEqual([
      {
        label: 'Generated motion',
        path: motion.path,
        name: 'clip-motion.funscript',
        _generatedFamily: 'motion',
        scriptId: 's-motion-1',
      },
      {
        label: 'Generated audio',
        path: audio.path,
        name: 'clip-audio.funscript',
        _generatedFamily: 'audio',
        scriptId: 's-audio-1',
      },
    ]);
  });

  it('drops records it cannot label or point back at', () => {
    // No id → nothing links a switch back to the store.
    expect(generatedVariantRows([{ ...audio, id: '' }], labelFor)).toEqual([]);
    expect(generatedVariantRows([{ ...audio, id: null }], labelFor)).toEqual([]);
    // No path → an older backend, or a file the route already dropped.
    expect(generatedVariantRows([{ ...audio, path: '' }], labelFor)).toEqual([]);
    expect(generatedVariantRows([{ ...audio, path: undefined }], labelFor)).toEqual([]);
    // No engine, or an engine family this player has no label for (a store
    // written by a newer backend). Guessing "motion" would be a wrong chip.
    expect(generatedVariantRows([{ ...audio, engine: '' }], labelFor)).toEqual([]);
    expect(generatedVariantRows([{ ...audio, engine: undefined }], labelFor)).toEqual([]);
    expect(generatedVariantRows([{ ...audio, engine: 'depth:high' }], labelFor)).toEqual([]);
    expect(generatedVariantRows([{ ...audio, engine: 'audio' }], labelFor)).toHaveLength(1);
  });

  it('keeps one row per engine family, the store keeping one script each', () => {
    // The store replaces a family's script on regeneration, so a second audio
    // record is either history or noise — either way the player shows one row.
    const rows = generatedVariantRows([
      { ...audio, id: 'newer', filename: 'clip-audio.funscript' },
      { ...audio, id: 'older', filename: 'clip-audio-2.funscript', path: 'X:\\store\\clip-audio-2.funscript' },
      motion,
    ], labelFor);
    expect(rows.map((r) => r.scriptId)).toEqual(['newer', 's-motion-1']);
  });

  it('never shows the same file twice', () => {
    const rows = generatedVariantRows([audio, { ...audio, id: 'other', engine: 'motion:low' }], labelFor);
    // Same path, different families: the path wins, because switching to it
    // twice would be a no-op row in the dropdown.
    expect(rows).toHaveLength(1);
    expect(rows[0].scriptId).toBe('s-audio-1');
  });

  it('falls back to the file name in the path when the record has none', () => {
    const rows = generatedVariantRows([{ ...audio, filename: '' }], labelFor);
    expect(rows[0].name).toBe('clip-audio.funscript');
    const posix = generatedVariantRows([{ ...audio, filename: null, path: '/data/store/clip-audio.funscript' }], labelFor);
    expect(posix[0].name).toBe('clip-audio.funscript');
  });

  it('tolerates a missing label function and a malformed payload', () => {
    // Without a label function the family name is the label — still honest.
    expect(generatedVariantRows([audio])[0].label).toBe('audio');
    expect(generatedVariantRows(undefined, labelFor)).toEqual([]);
    expect(generatedVariantRows(null, labelFor)).toEqual([]);
    expect(generatedVariantRows('nope', labelFor)).toEqual([]);
    expect(generatedVariantRows([null, 42, audio], labelFor)).toHaveLength(1);
  });
});

// The library's 「一致あり」 filter asks a different question than the player's
// dropdown: does this video have a script at all? So the same store records are
// shaped as a join table keyed by video path — and what gets kept differs.
describe('generatedScriptsByVideo', () => {
  const lower = (p) => String(p).toLowerCase();

  const enako = 'D:\\Y\\Movie\\えなこ-ZZZZ__dj pawa-orgasm (hardstyle) [MB0CkGfoGoY].mp4';

  it('keys records by video path for a library join', () => {
    const map = generatedScriptsByVideo([{ ...audio, video_path: enako }], lower);
    expect([...map.keys()]).toEqual([enako.toLowerCase()]);
    expect(map.get(enako.toLowerCase())).toEqual({
      scriptId: 's-audio-1',
      path: audio.path,
      family: 'audio',
      filename: 'clip-audio.funscript',
    });
  });

  it('keeps the newest record per video, the store being newest-first', () => {
    const map = generatedScriptsByVideo([
      { ...audio, id: 'newer', video_path: enako },
      { ...motion, id: 'older', video_path: enako },
    ], lower);
    expect([...map.values()].map((entry) => entry.scriptId)).toEqual(['newer']);
  });

  it('drops records it cannot join or load', () => {
    // No video path → nothing to join against; no path → nothing to load.
    expect(generatedScriptsByVideo([{ ...audio, video_path: '' }], lower).size).toBe(0);
    expect(generatedScriptsByVideo([{ ...audio, video_path: null }], lower).size).toBe(0);
    expect(generatedScriptsByVideo([{ ...audio, path: '' }], lower).size).toBe(0);
    expect(generatedScriptsByVideo([{ ...audio, path: undefined }], lower).size).toBe(0);
    expect(generatedScriptsByVideo([null, 42], lower).size).toBe(0);
  });

  it('keeps a family the library cannot label, unlike variation rows', () => {
    // The filter only asks whether a script exists. A `depth` script from a
    // newer backend still plays; only the badge falls back to plain auto.
    const map = generatedScriptsByVideo([{ ...audio, engine: 'depth:high', video_path: enako }], lower);
    expect(map.get(enako.toLowerCase()).family).toBe('');
    expect(generatedVariantRows([{ ...audio, engine: 'depth:high' }], labelFor)).toEqual([]);
  });

  it('collapses path spellings through the normaliser', () => {
    const map = generatedScriptsByVideo([
      { ...audio, id: 'newer', video_path: enako.toUpperCase() },
      { ...motion, id: 'older', video_path: enako },
    ], lower);
    // Same video, two spellings: one entry, and the newest of the two wins.
    expect([...map.values()].map((entry) => entry.scriptId)).toEqual(['newer']);
  });

  it('falls back to the raw path as key and tolerates a malformed payload', () => {
    const map = generatedScriptsByVideo([{ ...audio, video_path: enako }]);
    expect([...map.keys()]).toEqual([enako]);
    // Missing id / filename stay empty strings rather than breaking the join.
    const bare = generatedScriptsByVideo([{ video_path: enako, path: audio.path }]);
    expect(bare.get(enako)).toEqual({ scriptId: '', path: audio.path, family: '', filename: '' });
    expect(generatedScriptsByVideo(undefined, lower).size).toBe(0);
    expect(generatedScriptsByVideo(null, lower).size).toBe(0);
    expect(generatedScriptsByVideo('nope', lower).size).toBe(0);
  });
});
