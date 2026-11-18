// node --test src/engagement.test.js    (or: npm test)
//
// The meter's rules, on synthetic signals shaped like the real ones.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FLOOR_SCORE, KEEP_SCORE, bestWindow, parseSeries, scoreWindow, shiftWords } from './engagement.js';

// Loudness every 0.1s at `base` dB, with a burst of `burst` dB around `at`.
function loudness(seconds, { base = -28, burst = 0, at = 25 } = {}) {
  return Array.from({ length: seconds * 10 }, (_, i) => {
    const t = i / 10;
    return { t, v: base + (Math.abs(t - at) < 1 ? burst : 0) };
  });
}
// Scene scores every 0.2s.
const motion = (seconds, level = 0.05) =>
  Array.from({ length: seconds * 5 }, (_, i) => ({ t: i / 5, v: i % 10 === 0 ? 0.4 : level }));
const said = (start, text) =>
  text.split(' ').map((word, i) => ({ word: ` ${word}`, start: start + i * 0.3, end: start + i * 0.3 + 0.25, probability: 0.8 }));

test("ffmpeg's metadata lines are read in time order", () => {
  const log = 'frame:0 pts:0 pts_time:0\nlavfi.r128.M=-120.691\nframe:1 pts:4800 pts_time:0.1\nlavfi.r128.M=-23.5\n';
  assert.deepEqual(parseSeries(log, 'lavfi.r128.M'), [
    { t: 0, v: -120.691 },
    { t: 0.1, v: -23.5 },
  ]);
});

test('a moment chat and the room both reacted to scores high', () => {
  const result = scoreWindow({
    loudness: loudness(30, { burst: 14, at: 24 }),
    motion: motion(30),
    words: said(20, 'no way he did that! oh my god haha'),
    chat: { z: 6, classes: { funny: { z: 7 } } },
    payoffAt: 25,
  });
  assert.ok(result.score >= 75, `scored ${result.score}`);
  assert.ok(result.funny >= 60, `funny ${result.funny}`);
  assert.ok(result.reasons.some((r) => r.includes('burst')));
});

test('a menu with nothing said scores low, whatever chat did', () => {
  // The reviewer's lowest: a phone banking menu, 1/10, metered 13.
  const result = scoreWindow({
    loudness: loudness(30, { base: -30 }),
    motion: Array.from({ length: 150 }, (_, i) => ({ t: i / 5, v: 0 })),
    words: [],
    chat: { z: 3.7, classes: {} },
    payoffAt: 25,
  });
  assert.ok(result.score < FLOOR_SCORE, `scored ${result.score}`);
  assert.ok(result.reasons.includes('mostly a still frame'));
  assert.ok(result.reasons.includes('nothing said, or not clearly'));
});

test('the burst is judged against the clip, so a quiet streamer is not penalised for being quiet', () => {
  const quiet = scoreWindow({ loudness: loudness(30, { base: -38, burst: 12, at: 24 }), payoffAt: 25 });
  const loud = scoreWindow({ loudness: loudness(30, { base: -18, burst: 12, at: 24 }), payoffAt: 25 });
  assert.equal(quiet.parts.audio, loud.parts.audio);
});

test('the redo line sits where the calibration put it', () => {
  assert.equal(KEEP_SCORE, 50);
  assert.ok(FLOOR_SCORE < KEEP_SCORE);
});

test('a redo slides the frame until the burst lands three quarters in', () => {
  // 70s wide cut: the real burst is at 40s, chat reacted at 55s.
  const best = bestWindow({
    loudness: loudness(70, { burst: 15, at: 40 }),
    motion: motion(70),
    duration: 70,
    anchor: 55,
    length: 30,
  });
  // 40s at three quarters of a 30s window means a start near 17.5s — but the
  // window must still contain the chat reaction with 3s after it, so it can
  // start no earlier than 55 - 27 = 28. The search respects that.
  assert.ok(best.start >= 28 && best.start <= 52, `started at ${best.start}`);

  // With the reaction early enough, the burst lands where it should.
  const free = bestWindow({ loudness: loudness(70, { burst: 15, at: 40 }), motion: motion(70), duration: 70, anchor: 41, length: 30 });
  assert.ok(Math.abs(free.start + 22.5 - 40) <= 2, `burst at ${40 - free.start}s into the window`);
});

test("words from a wider cut are re-timed to the window's own clock", () => {
  const words = [
    { word: ' a', start: 4, end: 4.2 },
    { word: ' b', start: 12, end: 12.3 },
    { word: ' c', start: 45, end: 45.2 },
  ];
  assert.deepEqual(shiftWords(words, 10, 30), [{ word: ' b', start: 2, end: 2.3000000000000007 }]);
});
