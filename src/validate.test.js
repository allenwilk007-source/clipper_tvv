// node --test src/validate.test.js    (or: npm test)
//
// The checks every short passes before it can reach the ready folder. The two
// real failures found among the first 38 shorts are pinned here.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgeChecks, judgeStreams, parseChecks } from './validate.js';

const good = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' },
  ],
  format: { duration: '30.000000' },
};

test('a correct short passes', () => {
  assert.deepEqual(judgeStreams(good), []);
});

test('a short that came out short fails, as a render fault', () => {
  // nickmercs, measured: 28.0s from a 30s window.
  const short = { ...good, format: { duration: '28.0' } };
  const [problem] = judgeStreams(short);
  assert.equal(problem.kind, 'render');
  assert.match(problem.text, /28\.0s long, expected 30s/);
});

test('wrong size, missing audio and an unreadable file are all caught', () => {
  const wrong = {
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
    format: {},
  };
  const texts = judgeStreams(wrong).map((p) => p.text);
  assert.ok(texts.some((t) => t.includes('1920x1080')));
  assert.ok(texts.includes('audio stream missing'));
  assert.ok(texts.some((t) => t.includes('no duration')));
  // No audio expected, none asked for.
  assert.ok(!judgeStreams({ ...good, streams: [good.streams[0]] }, { hasAudio: false }).length);
});

test("frozen, black and silent footage is read off ffmpeg's log", () => {
  const log = [
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2.0',
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 5.5',
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 20',
    '[blackdetect @ 0x2] black_start:0 black_end:3 black_duration:3',
    '[silencedetect @ 0x3] silence_start: 10',
    '[silencedetect @ 0x3] silence_end: 14 | silence_duration: 4',
    '[h264 @ 0x4] error while decoding MB 12 34',
  ].join('\n');
  const checks = parseChecks(log, 30);
  // The second freeze is still open at the end: it runs to 30s.
  assert.equal(checks.frozen, 15.5);
  assert.equal(checks.black, 3);
  assert.equal(checks.silent, 4);
  assert.equal(checks.errors.length, 1);
});

test('a stream frozen for the whole clip is rejected outright', () => {
  // zarbex, measured: frozen for 30s of 30s. Rendering again would not help.
  const [problem] = judgeChecks({ frozen: 30, black: 0, silent: 0, errors: [] }, 30);
  assert.equal(problem.kind, 'content');
  assert.match(problem.text, /frozen for 30s of 30s/);
});

test('a still scene is not an error: the meter marks that down instead', () => {
  assert.deepEqual(judgeChecks({ frozen: 20, black: 0, silent: 0, errors: [] }, 30), []);
});

test('decode errors are a render fault; silence only counts when sound was expected', () => {
  assert.equal(judgeChecks({ frozen: 0, black: 0, silent: 0, errors: ['corrupt frame'] }, 30)[0].kind, 'render');
  assert.match(judgeChecks({ frozen: 0, black: 0, silent: 30, errors: [] }, 30)[0].text, /no audible sound/);
  assert.deepEqual(judgeChecks({ frozen: 0, black: 0, silent: 30, errors: [] }, 30, { hasAudio: false }), []);
});
