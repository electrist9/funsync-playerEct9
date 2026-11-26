/**
 * Minimal SRT/WebVTT subtitle parsing — pure, DOM-free, Node-testable.
 * The VR client renders cues on a head-locked UIPanel (the WebXR session
 * has no DOM, so browser-native <track> rendering is unavailable).
 */

/** "hh:mm:ss[.,]mmm" or "mm:ss[.,]mmm" → seconds, or null. */
export function parseTimestamp(raw) {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(String(raw).trim());
  if (!m) return null;
  // The fraction is positional, not always milliseconds: VTT allows ".45"
  // meaning 450 ms, SRT's ",456" is 456 ms.
  if (m[1] !== undefined) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 10 ** m[4].length;
  }
  return Number(m[5]) * 60 + Number(m[6]) + Number(m[7]) / 10 ** m[7].length;
}

const CUE_LINE = /^(.*?-->.*)$/;

/** Strip VTT/SRT inline tags and voice/timing metadata from a cue text line. */
export function cleanCueText(line) {
  return String(line)
    .replace(/<[^>]*>/g, '')          // <i>, <c.xxx>, <v>, ruby, …
    .replace(/\{[^}]*\}/g, '')        // {\an8} style ASS-ish hints
    .replace(/\\N/gi, ' ')            // SRT/ASS hard line break
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse SRT or WebVTT text into cues sorted by start time.
 * @returns {Array<{start: number, end: number, text: string}>}
 */
export function parseSubtitles(text) {
  if (!text) return [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const cues = [];
  let i = 0;
  // Skip everything up to the first cue (WEBVTT header, NOTE blocks, …).
  while (i < lines.length && !CUE_LINE.test(lines[i])) i += 1;
  while (i < lines.length) {
    const header = CUE_LINE.exec(lines[i]);
    if (!header) { i += 1; continue; }
    i += 1;
    const parts = header[1].split('-->');
    const start = parseTimestamp(parts[0]);
    // VTT allows cue settings after the timestamp — take the first token.
    const end = parseTimestamp((parts[1] || '').trim().split(/\s+/)[0]);
    if (start === null || end === null) { i += 1; continue; }
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(cleanCueText(lines[i]));
      i += 1;
    }
    const joined = textLines.filter(Boolean).join(' ');
    if (joined) cues.push({ start, end, text: joined });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** The cue active at time t (seconds), or null. Linear scan is fine for
 *  a handful of hundred cues checked every 0.2s. */
export function activeCue(cues, t) {
  if (!cues || !cues.length) return null;
  for (const cue of cues) {
    if (cue.start <= t && t <= cue.end) return cue;
    if (cue.start > t) break;
  }
  return null;
}
