// node --test src/clip.test.js    (or: npm test)
//
// Pure functions only. The subprocesses are deliberately untested: asserting
// that yt-dlp downloads video would be testing yt-dlp, would need the network,
// and would say nothing about the part that can actually be wrong here — the
// window maths and the argv we hand it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_CLIP_SECONDS,
  clipBasename,
  clipWindow,
  ffmpegVerticalArgs,
  formatClipTimestamp,
  formatSelector,
  normalizeVodId,
  parseOutputPath,
  parseProgress,
  readableFailure,
  splitCommand,
  verticalFilter,
  ytDlpArgs,
} from './clip.js';

test('timestamps are zero-padded hh:mm:ss', () => {
  assert.equal(formatClipTimestamp(0), '00:00:00');
  assert.equal(formatClipTimestamp(9), '00:00:09');
  assert.equal(formatClipTimestamp(61), '00:01:01');
  assert.equal(formatClipTimestamp(3600), '01:00:00');
  assert.equal(formatClipTimestamp(27_935), '07:45:35');
  // Sub-second offsets round rather than producing "00:00:12.4".
  assert.equal(formatClipTimestamp(12.6), '00:00:13');
  assert.equal(formatClipTimestamp(-5), '00:00:00');
});

test('the window reaches back further than it reaches forward', () => {
  const window = clipWindow({ offsetSeconds: 1000, pre: 25, post: 5 });
  assert.equal(window.start, 975);
  assert.equal(window.end, 1005);
  assert.equal(window.duration, 30);
  // The whole point of the asymmetry: most of the clip is before the
  // timestamp, because the timestamp is when people reacted.
  assert.ok(window.offset - window.start > window.end - window.offset);
});

test('a moment near the start of a VOD clamps at zero instead of going negative', () => {
  const window = clipWindow({ offsetSeconds: 10, pre: 25, post: 5 });
  assert.equal(window.start, 0);
  assert.equal(window.end, 15);
  assert.equal(window.duration, 15);
});

test('a bad window is rejected rather than queued', () => {
  assert.throws(() => clipWindow({ offsetSeconds: -1 }), /offsetSeconds/);
  assert.throws(() => clipWindow({ offsetSeconds: 'soon' }), /offsetSeconds/);
  assert.throws(() => clipWindow({ offsetSeconds: 100, pre: 0, post: 0 }), /more than zero/);
  assert.throws(
    () => clipWindow({ offsetSeconds: 10_000, pre: MAX_CLIP_SECONDS + 100, post: 0 }),
    /cap is/,
  );

  // An absurd pre close to the start of a VOD is not an error, because the
  // clamp has already made it harmless — the cap is on what gets downloaded,
  // not on what was asked for.
  assert.equal(clipWindow({ offsetSeconds: 100, pre: 99_999, post: 0 }).duration, 100);
});

test('VOD ids tolerate the "v" prefix and refuse anything else', () => {
  assert.equal(normalizeVodId('2931538239'), '2931538239');
  assert.equal(normalizeVodId('v2931538239'), '2931538239');
  assert.equal(normalizeVodId(' 2931538239 '), '2931538239');
  for (const bad of ['', null, 'abc', '123; rm -rf /', '../../etc/passwd', '12 34']) {
    assert.throws(() => normalizeVodId(bad), /not a Twitch VOD id/);
  }
});

test('quality becomes a height cap, a passthrough, or best', () => {
  assert.equal(formatSelector('720'), 'bv*[height<=720]+ba/b[height<=720]/b');
  assert.equal(formatSelector('1080p'), 'bv*[height<=1080]+ba/b[height<=1080]/b');
  assert.equal(formatSelector('source'), 'bv*+ba/b');
  assert.equal(formatSelector(''), 'bv*+ba/b');
  assert.equal(formatSelector('bv*[fps>50]+ba'), 'bv*[fps>50]+ba');
});

test('yt-dlp argv carries the section, the keyframe flag, and nothing shell-shaped', () => {
  const args = ytDlpArgs({
    vodId: 'v2931538239',
    start: 975,
    end: 1005,
    outTemplate: 'clips/x.%(ext)s',
    quality: '1080',
  });

  const section = args[args.indexOf('--download-sections') + 1];
  assert.equal(section, '*00:16:15-00:16:45');

  // Without this the cut lands on the nearest keyframe, which on Twitch can
  // be a couple of seconds off the moment.
  assert.ok(args.includes('--force-keyframes-at-cuts'));
  assert.ok(args.includes('--newline'));

  // --print would be the obvious way to learn the output path, but it implies
  // --quiet and takes the progress output with it, which is why neither it nor
  // a quiet flag may appear here.
  assert.ok(args.includes('--progress'));
  assert.ok(!args.some((arg) => /^--(print|quiet)/.test(arg)));
  assert.equal(args.at(-1), 'https://www.twitch.tv/videos/2931538239');

  // Every element is its own argv slot, so nothing needs quoting and nothing
  // can be glued into a second command.
  assert.ok(args.every((arg) => typeof arg === 'string'));
  assert.ok(!args.some((arg) => /[;&|]/.test(arg)));
});

test('a hostile vodId never reaches the argv', () => {
  assert.throws(
    () => ytDlpArgs({ vodId: '123 && calc.exe', start: 0, end: 10, outTemplate: 'x' }),
    /not a Twitch VOD id/,
  );
});

test('the vertical render keeps the whole frame over a blurred fill', () => {
  const filter = verticalFilter();
  assert.match(filter, /gblur/);
  // The foreground is scaled to full width, not cropped to 1080 wide, so
  // nothing at the edges of the shot is thrown away.
  assert.match(filter, /\[fg\]scale=1080:-2/);
  assert.match(filter, /overlay=\(W-w\)\/2:\(H-h\)\/2/);

  const args = ffmpegVerticalArgs({ input: 'a.mp4', output: 'b.mp4' });
  assert.equal(args[args.indexOf('-i') + 1], 'a.mp4');
  assert.equal(args.at(-1), 'b.mp4');
  assert.ok(args.includes('-filter_complex'));
});

test('the configured command can carry its own arguments', () => {
  assert.deepEqual(splitCommand('python -m yt_dlp'), { file: 'python', prefix: ['-m', 'yt_dlp'] });
  assert.deepEqual(splitCommand('  yt-dlp '), { file: 'yt-dlp', prefix: [] });
  assert.throws(() => splitCommand('   '), /empty command/);
});

test('basenames are unique per run and say what they hold', () => {
  const name = clipBasename({
    vodId: '2931538239',
    offsetSeconds: 3661,
    broadcaster: 'Jynxzi',
    now: new Date('2026-11-19T20:30:00.000Z'),
  });
  assert.equal(name, 'jynxzi-2931538239-t010101-20261119T203000Z');
  // Whatever a broadcaster calls themselves, the result stays a safe filename.
  assert.match(
    clipBasename({ vodId: '1', offsetSeconds: 0, broadcaster: '../../ev il' }),
    /^evil-1-t000000-/,
  );
});

test('progress lines are recognised from both subprocesses', () => {
  assert.deepEqual(parseProgress('[download]  42.1% of ~12.00MiB at 1.00MiB/s'), {
    stage: 'download',
    percent: 42.1,
  });
  assert.deepEqual(parseProgress('frame= 700 fps=340 q=31.0 time=00:00:12.88 bitrate=651.0kbits/s'), {
    stage: 'cut',
    seconds: 12.88,
  });
  assert.equal(parseProgress('[info] v123: Downloading 1 format(s)'), null);
});

test('the output path is read back out of the log', () => {
  assert.equal(
    parseOutputPath('[download] Destination: C:\\clips\\jynxzi-1-t000010-x.mp4'),
    'C:\\clips\\jynxzi-1-t000010-x.mp4',
  );
  // When the formats arrive separately it is the merged file that matters, so
  // this has to win over the Destination line that came before it.
  assert.equal(
    parseOutputPath('[Merger] Merging formats into "C:\\clips\\jynxzi-1-t000010-x.mp4"'),
    'C:\\clips\\jynxzi-1-t000010-x.mp4',
  );
  assert.equal(parseOutputPath('[download]  42.1% of ~12.00MiB'), null);
});

test('failures read as advice, not as a traceback', () => {
  assert.equal(
    readableFailure('Traceback (most recent call last):\n  File "x"\nERROR: [twitch] 123: Video does not exist'),
    '[twitch] 123: Video does not exist',
  );
  assert.match(readableFailure('ModuleNotFoundError: No module named yt_dlp'), /pip install yt-dlp/);
  assert.match(readableFailure("spawn python ENOENT"), /YTDLP_CMD/);
  assert.match(readableFailure('', '', 1), /code 1/);
});
