import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { audioWindow, parseLoudness, peakOf, robustStats } from './audio.js';

// Captured from ffmpeg 9's ebur128 on a real Twitch audio segment, so the
// parser is tested against the format it will actually meet rather than
// against a tidier one invented here.
const EBUR128 = `
[Parsed_ebur128_0 @ 000001f41ddb5840] t: 0.100000  TARGET:-23 LUFS    M: -28.2 S: -28.0     I: -28.1 LUFS       LRA:   0.6 LU
[Parsed_ebur128_0 @ 000001f41ddb5840] t: 0.200000  TARGET:-23 LUFS    M: -120.7 S: -28.1     I: -28.1 LUFS       LRA:   0.6 LU
[Parsed_ebur128_0 @ 000001f41ddb5840] t: 0.300000  TARGET:-23 LUFS    M: -26.4 S: -27.9     I: -28.0 LUFS       LRA:   0.6 LU
[Parsed_ebur128_0 @ 000001f41ddb5840] t: 0.400000  TARGET:-23 LUFS    M: -12.1 S: -24.3     I: -26.4 LUFS       LRA:   0.6 LU
[in#0/hls @ 000001f41b8bfd40] Opening 'https://example.invalid/segment.mp4' for reading
[Parsed_ebur128_0 @ 000001f41ddb5840] t: 0.500000  TARGET:-23 LUFS    M: -27.1 S: -26.0     I: -26.9 LUFS       LRA:   0.6 LU
`;

describe('parseLoudness', () => {
  it('reads the momentary loudness series out of the log', () => {
    const samples = parseLoudness(EBUR128);
    assert.deepEqual(
      samples.map((s) => s.m),
      [-28.2, -26.4, -12.1, -27.1],
    );
    assert.equal(samples[0].t, 0.1);
  });

  it('drops digital silence rather than averaging it in', () => {
    // -120.7 is not a quiet passage, it is no signal at all. Left in, it drags
    // the median somewhere no audible moment ever sits.
    const samples = parseLoudness(EBUR128);
    assert.equal(
      samples.some((s) => s.m < -70),
      false,
    );
  });

  it('ignores the surrounding ffmpeg chatter', () => {
    assert.equal(parseLoudness('[https @ 0x1] Opening ... for reading').length, 0);
    assert.equal(parseLoudness('').length, 0);
  });
});

describe('robustStats', () => {
  it('a single loud burst does not drag the baseline up to hide itself', () => {
    const quiet = Array.from({ length: 50 }, () => -30);
    const stats = robustStats([...quiet, -5]);
    assert.equal(stats.median, -30);
  });

  it('reports nothing for an empty series rather than NaN', () => {
    assert.deepEqual(robustStats([]), { median: null, mad: null, count: 0 });
  });
});

describe('peakOf', () => {
  const flat = (value, count) =>
    Array.from({ length: count }, (_, i) => ({ t: i * 0.1, m: value + (i % 2 ? 0.4 : -0.4) }));

  it('finds the loudest point and places it in the VOD', () => {
    const samples = [...flat(-30, 40), { t: 4.0, m: -10 }, ...flat(-30, 40)];
    const peak = peakOf(samples, { windowStart: 1000, chatOffset: 1030 });
    assert.equal(peak.loudness, -10);
    assert.equal(peak.at, 1004);
  });

  it('lag is positive when the audio came before chat', () => {
    const samples = [...flat(-30, 40), { t: 4.0, m: -10 }];
    const peak = peakOf(samples, { windowStart: 1000, chatOffset: 1030 });
    // Loud at 1004, chat nominated 1030: audio led by 26 seconds.
    assert.equal(peak.lag, 26);
  });

  it('lag is negative when the loudest point came after the nomination', () => {
    const samples = [...flat(-30, 10), { t: 50.0, m: -10 }];
    const peak = peakOf(samples, { windowStart: 1000, chatOffset: 1030 });
    assert.equal(peak.lag, -20);
  });

  it('refuses a z-score when the window has no variation to measure against', () => {
    // MAD 0 would make every wobble an infinite spike.
    const samples = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.1, m: -30 }));
    const peak = peakOf(samples, { windowStart: 0, chatOffset: 10 });
    assert.equal(peak.z, null);
    assert.equal(peak.loudness, -30);
  });

  it('returns nothing at all when there were no samples', () => {
    assert.equal(peakOf([], { windowStart: 0 }), null);
  });
});

describe('peak isolation', () => {
  const at = (t, m) => ({ t, m });
  const quiet = (from, count, value = -40) =>
    Array.from({ length: count }, (_, i) => at(from + i * 0.1, value));

  it('is large when one event stands alone in the window', () => {
    const samples = [...quiet(0, 100), at(10, -12), ...quiet(10.1, 100)];
    const peak = peakOf(samples, { windowStart: 0 });
    // Nothing else within 5s comes near it.
    assert.equal(peak.isolation, 28);
  });

  it('is small when the window is loud in several places', () => {
    // Three comparable bursts: the maximum is one of them more or less by
    // accident, so the window says almost nothing about where the moment was.
    const samples = [
      ...quiet(0, 50),
      at(5, -13),
      ...quiet(5.1, 50),
      at(12, -12),
      ...quiet(12.1, 50),
      at(20, -13.5),
      ...quiet(20.1, 50),
    ];
    const peak = peakOf(samples, { windowStart: 0 });
    assert.equal(peak.loudness, -12);
    assert.equal(peak.isolation, 1);
  });

  it('does not compare the peak with its own 400ms window', () => {
    // ebur128's momentary loudness slides, so samples either side of a peak
    // are largely the same sound. Counting one as a rival would report every
    // peak as unisolated.
    const samples = [...quiet(0, 50), at(5.0, -12), at(5.1, -12.4), at(5.2, -13), ...quiet(5.3, 50)];
    const peak = peakOf(samples, { windowStart: 0 });
    assert.equal(peak.isolation, 28);
  });

  it('reports nothing when the window is too short to hold a rival', () => {
    const samples = [at(0, -30), at(0.1, -20), at(0.2, -25)];
    const peak = peakOf(samples, { windowStart: 0 });
    assert.equal(peak.isolation, null);
  });
});

describe('audioWindow', () => {
  it('is symmetric, so a peak lands either side by chance half the time', () => {
    const window = audioWindow(500, { before: 30, after: 30 });
    assert.equal(window.start, 470);
    assert.equal(window.end, 530);
    assert.equal(window.offset - window.start, window.end - window.offset);
  });

  it('clamps at the start of the VOD without going negative', () => {
    const window = audioWindow(10, { before: 30, after: 30 });
    assert.equal(window.start, 0);
    assert.equal(window.end, 40);
  });
});
