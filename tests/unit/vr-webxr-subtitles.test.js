/**
 * Unit tests for the SRT/WebVTT subtitle parser
 * (backend/vr-remote/js/subtitles.js). Pure/DOM-free by design.
 */

import { describe, expect, it } from 'vitest';
import {
  parseTimestamp,
  cleanCueText,
  parseSubtitles,
  activeCue,
} from '../../backend/vr-remote/js/subtitles.js';

describe('parseTimestamp', () => {
  it('parses hh:mm:ss,mmm (SRT)', () => {
    expect(parseTimestamp('00:01:23,456')).toBeCloseTo(83.456, 3);
    expect(parseTimestamp('01:02:03.004')).toBeCloseTo(3723.004, 3);
  });

  it('parses mm:ss.mmm (VTT short form)', () => {
    expect(parseTimestamp('01:23.45')).toBeCloseTo(83.45, 3);
  });

  it('rejects junk', () => {
    expect(parseTimestamp('nope')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
  });
});

describe('cleanCueText', () => {
  it('strips tags, hints and hard breaks', () => {
    expect(cleanCueText('<i>Hello</i> <c.white>world</c>')).toBe('Hello world');
    expect(cleanCueText('one\\Ntwo')).toBe('one two');
    expect(cleanCueText('{\\an8} centered')).toBe('centered');
    expect(cleanCueText('  a   b ')).toBe('a b');
  });
});

describe('parseSubtitles', () => {
  it('parses SRT with numbered cues', () => {
    const cues = parseSubtitles([
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'First line',
      'second line',
      '',
      '2',
      '00:00:04,000 --> 00:00:05,000',
      '<i>Italic</i>',
      '',
    ].join('\n'));
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, end: 3, text: 'First line second line' });
    expect(cues[1].text).toBe('Italic');
  });

  it('parses WebVTT with header and cue settings', () => {
    const cues = parseSubtitles([
      'WEBVTT',
      'Kind: captions',
      'Language: ja',
      '',
      'NOTE a comment',
      '',
      '00:00:10.000 --> 00:00:12.000 align:start position:0%',
      'こんにちは',
      '',
    ].join('\n'));
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ start: 10, end: 12, text: 'こんにちは' });
  });

  it('sorts cues by start time and drops BOM', () => {
    const cues = parseSubtitles('\uFEFF' + [
      '00:00:20,000 --> 00:00:21,000',
      'later',
      '',
      '00:00:05,000 --> 00:00:06,000',
      'earlier',
      '',
    ].join('\n'));
    expect(cues.map((c) => c.text)).toEqual(['earlier', 'later']);
  });

  it('returns [] for empty or garbage input', () => {
    expect(parseSubtitles('')).toEqual([]);
    expect(parseSubtitles(null)).toEqual([]);
    expect(parseSubtitles('WEBVTT\n\nno cues here')).toEqual([]);
  });
});

describe('activeCue', () => {
  const cues = [
    { start: 1, end: 3, text: 'a' },
    { start: 5, end: 7, text: 'b' },
  ];

  it('finds the covering cue, inclusive at both ends', () => {
    expect(activeCue(cues, 1)?.text).toBe('a');
    expect(activeCue(cues, 3)?.text).toBe('a');
    expect(activeCue(cues, 6)?.text).toBe('b');
  });

  it('returns null between cues and past the end', () => {
    expect(activeCue(cues, 4)).toBeNull();
    expect(activeCue(cues, 0)).toBeNull();
    expect(activeCue(cues, 99)).toBeNull();
  });

  it('tolerates empty input', () => {
    expect(activeCue([], 2)).toBeNull();
    expect(activeCue(null, 2)).toBeNull();
  });
});
