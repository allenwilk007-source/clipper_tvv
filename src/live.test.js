// node --test src/live.test.js    (or: npm test)
//
// Live recording, without the network: what Twitch serves is replayed from
// the shapes measured on ishowspeed's real playlist and page.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RecorderManager, concatList, coverage, liveFromPage, parsePlaylist } from './live.js';

const T0 = Date.parse('2026-11-18T21:07:32.199Z');
const iso = (ms) => new Date(ms).toISOString();

// As served on joining: a stitched pre-roll ad, then the live stream.
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:5',
  `#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="${iso(T0)}",DURATION=6.000`,
  '#EXT-X-DISCONTINUITY',
  `#EXT-X-PROGRAM-DATE-TIME:${iso(T0)}`,
  '#EXTINF:2.000,Amazon|2474283100495.0',
  'https://seg/ad-1.ts',
  `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + 2000)}`,
  '#EXTINF:2.000,Amazon|2474283100495.0',
  'https://seg/ad-2.ts',
  // An ad segment whose title does not say so, caught by the date range.
  `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + 4000)}`,
  '#EXTINF:2.000,',
  'https://seg/ad-3.ts',
  '#EXT-X-DISCONTINUITY',
  `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + 6000)}`,
  '#EXTINF:2.000,live',
  'https://seg/live-1.ts',
  `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + 8000)}`,
  '#EXTINF:2.000,live',
  'https://seg/live-2.ts',
  '#EXT-X-TWITCH-PREFETCH:https://seg/prefetch.ts',
].join('\n');

test('ads are told apart from the stream, by title or by date range', () => {
  const segments = parsePlaylist(PLAYLIST);
  assert.deepEqual(
    segments.map((s) => [s.uri.split('/').pop(), s.ad]),
    [
      ['ad-1.ts', true],
      ['ad-2.ts', true],
      ['ad-3.ts', true],
      ['live-1.ts', false],
      ['live-2.ts', false],
    ],
  );
  // Each segment carries its wall-clock start, which is what lets a chat
  // spike be matched to the exact seconds of video.
  assert.equal(segments[3].at, T0 + 6000);
  assert.equal(segments[3].duration, 2);
  // Prefetch hints are not segments.
  assert.ok(!segments.some((s) => s.uri.includes('prefetch')));
});

test("a channel page says whether it is live, and what it is playing", () => {
  const page = (description) => `<meta name="description" content="${description}">`;
  // The three shapes seen live.
  assert.deepEqual(
    liveFromPage(page('🔴PLAYING GTA 6 EARLY ACCESS | Streaming grand theft auto vi for 14759 viewers.')),
    { live: true, game: 'grand theft auto vi', viewers: 14759 },
  );
  assert.deepEqual(liveFromPage(page('70 Hour Pirate Token Hunt! Day 2 | Streaming fortnite.')), {
    live: true,
    game: 'fortnite',
    viewers: 0,
  });
  assert.equal(liveFromPage(page('LE JEU &amp; LA DÉCENNIE | Streaming grand theft auto vi.')).game, 'grand theft auto vi');
  // Offline pages carry the channel's general blurb instead.
  assert.deepEqual(liveFromPage(page('summit1g streams live on Twitch! Check out their videos.')), {
    live: false,
    game: null,
    viewers: 0,
  });
});

const seg = (at, duration = 2) => ({ at, duration, file: `${at}.ts` });

test('a cut is only made across recording with no gap in it', () => {
  const index = [seg(0), seg(2000), seg(4000), seg(6000)];
  assert.equal(coverage(index, 1000, 7000).length, 4);
  // An ad break leaves a hole; a cut across it would be shorter than it
  // claims and out of step with the chat that nominated it.
  const holed = [seg(0), seg(2000), seg(10_000), seg(12_000)];
  assert.equal(coverage(holed, 1000, 13_000), null);
  // Asking for more than was recorded, at either end.
  assert.equal(coverage(index, -5000, 7000), null);
  assert.equal(coverage(index, 1000, 20_000), null);
});

test('the concat list quotes Windows paths safely', () => {
  assert.equal(
    concatList([{ file: "C:\\clips\\.work\\it's.ts" }, { file: 'C:/clips/a.ts' }]),
    "file 'C:/clips/.work/it'\\''s.ts'\nfile 'C:/clips/a.ts'\n",
  );
});

// --- deciding what to record --------------------------------------------------

function manager({ pages, vods, max = 2 }) {
  const started = [];
  const stopped = [];
  const m = new RecorderManager({
    log: () => {},
    max,
    games: ['Grand Theft Auto VI', 'Fortnite'],
    dir: 'live-test-dir',
    checkPage: async (login) => pages[login],
    hasVod: async (login) => vods[login],
    createRecorder: ({ login }) => ({
      login,
      dir: `live-test-dir/${login}`,
      state: 'recording',
      start() {
        started.push(login);
      },
      stop() {
        stopped.push(login);
      },
      status: () => ({ login }),
    }),
  });
  return { m, started, stopped };
}

const sweepAll = async (m) => {
  for (let i = 0; i < m.channels.length; i += 1) await m.sweepOne();
};

test('only live channels, in a clipped game, with no VOD, are recorded', async () => {
  const { m, started } = manager({
    pages: {
      ishowspeed: { live: true, game: 'grand theft auto vi', viewers: 14759 },
      zerator: { live: true, game: 'grand theft auto vi', viewers: 6044 },
      lirik: { live: true, game: 'grand theft auto vi', viewers: 9000 }, // has a VOD
      sodapoppin: { live: true, game: 'world of warcraft', viewers: 20000 }, // wrong game
      summit1g: { live: false, game: null, viewers: 0 }, // offline
    },
    vods: { ishowspeed: false, zerator: false, lirik: true },
    max: 4,
  });
  m.setChannels(['ishowspeed', 'zerator', 'lirik', 'sodapoppin', 'summit1g']);
  await sweepAll(m);
  assert.deepEqual(started.sort(), ['ishowspeed', 'zerator']);
  // Named as configured, not as the page lower-cases it, for titles.
  assert.equal(m.recorders.get('ishowspeed').game, 'Grand Theft Auto VI');
});

test('when more need recording than the cap allows, the biggest win', async () => {
  const { m, started } = manager({
    pages: {
      small: { live: true, game: 'fortnite', viewers: 300 },
      big: { live: true, game: 'fortnite', viewers: 30000 },
      middle: { live: true, game: 'fortnite', viewers: 5000 },
    },
    vods: { small: false, big: false, middle: false },
    max: 2,
  });
  m.setChannels(['small', 'big', 'middle']);
  await sweepAll(m);
  assert.deepEqual([...m.recorders.keys()].sort(), ['big', 'middle']);
  assert.ok(started.includes('big'));
});

test("a VOD that can't be told yet is not recorded on a guess", async () => {
  const { m, started } = manager({
    pages: { maybe: { live: true, game: 'fortnite', viewers: 100 } },
    vods: { maybe: undefined },
  });
  m.setChannels(['maybe']);
  await sweepAll(m);
  assert.deepEqual(started, []);
});

test('a recording stops when the channel goes offline or is taken off the list', async () => {
  const pages = { ishowspeed: { live: true, game: 'grand theft auto vi', viewers: 1 }, zerator: { live: true, game: 'fortnite', viewers: 1 } };
  const { m, stopped } = manager({ pages, vods: { ishowspeed: false, zerator: false } });
  m.setChannels(['ishowspeed', 'zerator']);
  await sweepAll(m);
  assert.equal(m.recorders.size, 2);

  pages.ishowspeed = { live: false, game: null, viewers: 0 };
  m.seen.get('ishowspeed').checkedAt = 0;
  m.cursor = 0;
  await m.sweepOne();
  assert.deepEqual(stopped, ['ishowspeed']);

  m.setChannels([]);
  assert.deepEqual(stopped, ['ishowspeed', 'zerator']);
});

test('a recording keeps its slot against a channel only slightly bigger', async () => {
  const pages = {
    a: { live: true, game: 'fortnite', viewers: 1000 },
    b: { live: true, game: 'fortnite', viewers: 900 },
    c: { live: false, game: null, viewers: 0 },
  };
  const { m, stopped } = manager({ pages, vods: { a: false, b: false, c: false }, max: 2 });
  m.setChannels(['a', 'b', 'c']);
  await sweepAll(m);
  assert.deepEqual([...m.recorders.keys()].sort(), ['a', 'b']);

  // c edges past b: not worth another ad and a lost buffer.
  m.seen.set('c', { live: true, game: 'fortnite', viewers: 1100, vod: false, checkedAt: Date.now() });
  m.rebalance();
  assert.deepEqual(stopped, []);

  // Twice the size: it takes the slot.
  m.seen.set('c', { live: true, game: 'fortnite', viewers: 3000, vod: false, checkedAt: Date.now() });
  m.rebalance();
  assert.deepEqual(stopped, ['b']);
});

test('fragmented-MP4 streams carry the init segment each fragment needs', () => {
  const segments = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-MAP:URI="https://seg/init-0.mp4"',
      `#EXT-X-PROGRAM-DATE-TIME:${iso(T0)}`,
      '#EXTINF:2.000,live',
      'https://seg/1.mp4',
      '#EXT-X-MAP:URI="https://seg/init-1.mp4"',
      `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + 2000)}`,
      '#EXTINF:2.000,live',
      'https://seg/2.mp4',
    ].join('\n'),
  );
  assert.deepEqual(segments.map((s) => s.map), ['https://seg/init-0.mp4', 'https://seg/init-1.mp4']);
  // MPEG-TS streams have none.
  assert.equal(parsePlaylist(PLAYLIST)[3].map, null);
});

test('the recorder stores each fragment playable on its own', async () => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { LiveRecorder } = await import('./live.js');
  const dir = await mkdtemp(join(tmpdir(), 'live-'));
  const served = {
    'https://pl/x.m3u8': ['#EXTM3U', '#EXT-X-MAP:URI="https://seg/init.mp4"', `#EXT-X-PROGRAM-DATE-TIME:${iso(T0)}`, '#EXTINF:2.000,live', 'https://seg/1.mp4'].join('\n'),
    'https://seg/init.mp4': 'INIT',
    'https://seg/1.mp4': 'FRAG',
  };
  const fetchImpl = async (url) => ({
    ok: url in served,
    status: url in served ? 200 : 404,
    text: async () => served[url],
    arrayBuffer: async () => new TextEncoder().encode(served[url]).buffer,
  });
  const rec = new LiveRecorder({ login: 'x', dir, resolveUrl: async () => 'https://pl/x.m3u8', fetchImpl, log: () => {}, now: () => T0 + 4000 });
  await rec.poll();
  const [file] = await readdir(dir);
  assert.equal(file, `${T0}.mp4`);
  assert.equal(await readFile(join(dir, file), 'utf8'), 'INITFRAG');
  await rm(dir, { recursive: true, force: true });
});

// A top-level MP4 box: 4-byte size, 4-byte type, payload.
const box = (type, payload = '') => {
  const body = Buffer.from(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};

test('fragments are joined behind one init segment, and split where it changes', async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { initLength, joinFragments } = await import('./live.js');
  const dir = await mkdtemp(join(tmpdir(), 'join-'));
  const initA = Buffer.concat([box('ftyp', 'a'), box('moov', 'A')]);
  const initB = Buffer.concat([box('ftyp', 'b'), box('moov', 'B')]);
  const frag = (n) => Buffer.concat([box('emsg', n), box('moof', n), box('mdat', n)]);
  assert.equal(initLength(Buffer.concat([initA, frag('1')])), initA.length);
  assert.equal(initLength(Buffer.from('G@\u0000\u0010 not an mp4 at all')), 0);

  const files = [];
  for (const [i, [init, n]] of [[initA, '1'], [initA, '2'], [initB, '3']].entries()) {
    const file = join(dir, `${i}.mp4`);
    await writeFile(file, Buffer.concat([init, frag(n)]));
    files.push({ file });
  }
  const joined = await joinFragments(files, { dir, name: 'x' });
  assert.equal(joined.files.length, 2);
  assert.deepEqual(await readFile(joined.files[0].file), Buffer.concat([initA, frag('1'), frag('2')]));
  assert.deepEqual(await readFile(joined.files[1].file), Buffer.concat([initB, frag('3')]));
  // MPEG-TS goes through untouched.
  const ts = [{ file: join(dir, 'a.ts') }];
  assert.deepEqual(await joinFragments(ts, { dir, name: 'y' }), { files: ts, temp: [] });
  await rm(dir, { recursive: true, force: true });
});
