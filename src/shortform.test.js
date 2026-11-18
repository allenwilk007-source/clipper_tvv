// node --test src/shortform.test.js    (or: npm test)
//
// Pure functions only. Each of the text traps described in shortform.js was
// hit for real while building this, so each one is pinned here.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  captionFor,
  cleanCaption,
  creditFor,
  dominantReaction,
  escapeFilterPath,
  postTextFor,
  shortformArgs,
  twitchTime,
  wrapCaption,
} from './shortform.js';

const graphOf = (args) => args[args.indexOf('-filter_complex') + 1];

test('stream-title furniture is stripped and the first segment kept', () => {
  assert.equal(cleanCaption('GTA 6 DAY 1 | !merch !discord [DROPS ON]'), 'GTA 6 DAY 1');
  assert.equal(cleanCaption('insane heist https://x.co/abc #ad'), 'insane heist');
});

test('characters the font cannot draw are removed, not printed as boxes', () => {
  assert.equal(cleanCaption('he is cooked 💀💀'), 'he is cooked');
  assert.equal(cleanCaption('Ça va très bien'), 'Ça va très bien');
  // Nothing drawable left is reported as '' so the caller falls back to
  // something that will actually render.
  assert.equal(cleanCaption('정말 대박'), '');
});

test('punctuation stranded by stripping is dropped, but a bare !!! survives', () => {
  // "%{pts}" loses its braces to the font filter, which used to leave a lone
  // "%" printed in the caption. Seen in a real render.
  assert.equal(cleanCaption("he's 100% cooked %{pts}"), "he's 100% cooked pts");
  assert.equal(cleanCaption('NO WAY !!!'), 'NO WAY !!!');
});

test('wrapping keeps every line short enough to clear the side buttons', () => {
  const lines = wrapCaption('this is a fairly long caption about a heist gone wrong');
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(line.length <= 16, `"${line}" is too long`);
  assert.ok(lines[2].endsWith('…'), 'a cut-off caption should say so');

  // One word longer than a line is split rather than allowed to overflow.
  assert.deepEqual(wrapCaption('A'.repeat(22)), ['A'.repeat(16), 'A'.repeat(6)]);
});

test('the reaction hook names only a class that actually spiked', () => {
  const chat = { classes: { funny: { z: 4.1 }, hype: { z: 2.5 }, clipit: { z: 1.2 } } };
  assert.equal(dominantReaction(chat), 'funny');
  assert.equal(dominantReaction({ classes: { funny: { z: 1.9 } } }), null);
  assert.equal(dominantReaction(null), null);
});

test('a clip title beats the hook, but a chat-only moment leads with what chat did', () => {
  const laughing = { classes: { funny: { z: 5 } } };
  // A clip title is a person describing this exact moment.
  assert.equal(
    captionFor({ source: 'clips', title: 'bro crashed the getaway car', chat: laughing }),
    'bro crashed the getaway car',
  );
  // A chat-only moment only has the stream title, which is about the whole
  // broadcast, so the evidence from chat goes first.
  assert.equal(captionFor({ source: 'chat', title: 'GTA 6 DAY 1 | !merch', chat: laughing }), 'CHAT LOST IT');
  assert.equal(captionFor({ source: 'chat', title: 'GTA 6 DAY 1 | !merch', chat: null }), 'GTA 6 DAY 1');
  assert.equal(
    captionFor({ source: 'chat', broadcaster: 'xQc', title: '', chat: null }, { game: 'Grand Theft Auto VI' }),
    'XQC IN GRAND THEFT AUTO VI',
  );
});

test('a Windows font path survives both layers of filtergraph escaping', () => {
  // Unescaped, the colon after the drive letter splits the option in two and
  // ffmpeg reports "No option name near '/Windows/Fonts/...'". This exact
  // output was verified by a real render with ffmpeg 9.0.2.
  assert.equal(escapeFilterPath('C:\\Windows\\Fonts\\seguibl.ttf'), 'C\\\\:/Windows/Fonts/seguibl.ttf');
  assert.equal(escapeFilterPath("C:/Users/O'Brien/f.ttf"), "C\\\\:/Users/O\\\\\\'Brien/f.ttf");
});

const ARGS = {
  input: 'in.mp4',
  output: 'out.mp4',
  captionPath: 'C:/clips/.work/a.caption.txt',
  creditPath: 'C:/clips/.work/a.credit.txt',
  font: 'C:/Windows/Fonts/seguibl.ttf',
};

test('a % in a title cannot be read as an expansion', () => {
  // Measured: with drawtext's default expansion, a caption reading
  // "he's 100% cooked" fails the whole render ("Conversion failed!"). With
  // expansion=none it renders. Both text layers need it.
  const graph = graphOf(shortformArgs(ARGS));
  assert.equal(graph.match(/expansion=none/g)?.length, 2);
  // The caption itself never appears in the graph — it goes in by file.
  assert.match(graph, /textfile=C\\\\:\/clips\/\.work\/a\.caption\.txt/);
});

test('loudness is normalised and resampled back to 48k', () => {
  // loudnorm hands on 192 kHz unless told otherwise, which some upload
  // pipelines reject outright.
  const graph = graphOf(shortformArgs(ARGS));
  assert.match(graph, /\[0:a\]loudnorm=I=-14:TP=-1\.5:LRA=11,aresample=48000\[a\]/);
});

test('a source with no audio maps video only', () => {
  const args = shortformArgs({ ...ARGS, hasAudio: false });
  assert.ok(args.includes('-an'));
  assert.ok(!graphOf(args).includes('[0:a]'));
  assert.ok(!args.includes('[a]'));
});

test('no credit line is drawn when the name has nothing the font can draw', () => {
  assert.equal(creditFor({ broadcaster: '정말' }), '');
  assert.equal(creditFor({ broadcaster: 'Sodapoppin' }), '@Sodapoppin on Twitch');
  const graph = graphOf(shortformArgs({ ...ARGS, creditPath: null }));
  assert.equal(graph.match(/drawtext=/g)?.length, 1);
});

test('the post copy links straight to the moment in the full stream', () => {
  assert.equal(twitchTime(3955), '1h05m55s');
  const text = postTextFor(
    { broadcaster: 'Sodapoppin', vodId: 'v2932490378' },
    { caption: 'he is cooked', start: 3955, hashtags: '#gta6' },
  );
  const lines = text.split('\n');
  assert.equal(lines[0], 'he is cooked');
  assert.ok(lines.includes('Credit: Sodapoppin on Twitch'));
  assert.ok(lines.includes('Full stream: https://www.twitch.tv/videos/2932490378?t=1h05m55s'));
  assert.ok(lines.includes('#gta6 #sodapoppin'));
});
