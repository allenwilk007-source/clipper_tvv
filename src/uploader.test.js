// node --test src/uploader.test.js    (or: npm test)
//
// The uploader against a real (in-memory) store and a fake YouTube: what it
// picks, when, and what it does with each way an upload can fail.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from './store.js';
import { Uploader, candidates, pacificDayStart, youtubePost } from './uploader.js';
import { UploadError } from './youtube.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

test('the quota day starts at midnight Pacific, standard time or daylight', () => {
  // 23:30 on 17 Nov in Los Angeles (UTC-8).
  assert.equal(new Date(pacificDayStart(Date.parse('2026-11-18T07:30:00Z'))).toISOString(), '2026-11-17T08:00:00.000Z');
  // 23:59 on 30 Jun (UTC-7).
  assert.equal(new Date(pacificDayStart(Date.parse('2026-07-01T06:59:00Z'))).toISOString(), '2026-06-30T07:00:00.000Z');
});

const T0 = Date.parse('2026-11-18T18:00:00Z'); // 10:00 Pacific

/** A ready folder and a store holding these shorts. */
async function setup(shorts) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-'));
  dirs.push(dir);
  const store = new Store(':memory:');
  for (const [i, s] of shorts.entries()) {
    const file = `${s.name}-1-t00000${i}-x.mp4`;
    store.recordAutoclip({ momentId: `m${i}`, vodId: `v${i}`, offsetSeconds: i * 1000, broadcaster: s.name, caption: 'x', at: new Date(T0 - 3600_000 + i) });
    store.finishAutoclip(`m${i}`, { status: 'done', path: join(dir, file), review: { score: s.score, weak: s.weak || false }, at: new Date(T0 - 3600_000 + i) });
    await writeFile(join(dir, file), 'VIDEO');
    if (s.json !== false) {
      await writeFile(
        join(dir, file.replace('.mp4', '.json')),
        JSON.stringify({ caption: `"${s.name} line" 😂`, game: 'game' in s ? s.game : 'Grand Theft Auto VI', broadcaster: s.name, link: 'https://twitch.tv/videos/1' }),
      );
    }
  }
  return { dir, store };
}

function fakeYouTube({ upload = async () => 'vid123', token = async () => 'access' } = {}) {
  const calls = [];
  return {
    calls,
    youtubeKeys: () => ({ clientId: 'id', clientSecret: 'secret', redirectUri: 'x' }),
    hasKeys: () => true,
    loadToken: async () => ({ refreshToken: 'r' }),
    accessToken: token,
    uploadVideo: async (args) => {
      calls.push(args);
      return upload(args);
    },
  };
}

function uploader({ store, dir, yt = fakeYouTube(), check, clock }) {
  const time = clock || { now: T0 };
  const u = new Uploader({
    store,
    dir,
    yt,
    log: () => {},
    now: () => time.now,
    settingsPath: join(dir, 'uploads.json'),
    dryRunLog: join(dir, 'dry.jsonl'),
    check: check || (async () => ({ ok: true, problems: [] })),
  });
  u.state.youtube.connected = true;
  return { u, time, yt };
}

const SHORTS = [
  { name: 'okay', score: 60 },
  { name: 'best', score: 88 },
  { name: 'weakone', score: 90, weak: true },
  { name: 'low', score: 40 },
  { name: 'valorant', score: 95, game: 'VALORANT' },
  { name: 'nogame', score: 95, game: null },
  { name: 'nocopy', score: 95, json: false },
  { name: 'fort', score: 70, game: 'Fortnite' },
];

test('only the good ones, in a game this channel clips, best first', async () => {
  const { dir, store } = await setup(SHORTS);
  const picks = await candidates({ store, dir, platform: 'youtube' });
  assert.deepEqual(
    picks.map((c) => c.saved.broadcaster),
    ['best', 'fort', 'okay'],
  );
});

test("the post is rebuilt from the short's own game at post time", async () => {
  const { dir, store } = await setup([{ name: 'fort', score: 70, game: 'Fortnite' }]);
  const [c] = await candidates({ store, dir, platform: 'youtube' });
  const post = youtubePost(c);
  assert.match(post.title, /#Shorts #Fortnite/);
  assert.ok(post.title.length <= 100);
  assert.ok(post.tags.includes('fortnite') && !post.tags.some((t) => t.startsWith('gta')));
});

test('dry run: the full choice at the real cadence, and nothing sent', async () => {
  const { dir, store } = await setup(SHORTS);
  const { u, time, yt } = uploader({ store, dir });
  u.settings.youtube.mode = 'dry-run';

  assert.equal((await u.tick()).file.startsWith('best'), true);
  // Spacing: nothing until three hours later.
  time.now += 60 * 60_000;
  assert.equal(await u.tick(), null);
  time.now += 2 * 60 * 60_000;
  assert.ok((await u.tick()).file.startsWith('fort'));
  assert.equal(yt.calls.length, 0);
  // Logged under its own name, so a real run later starts clean.
  assert.equal(store.uploadsSince('youtube:dry', 0).length, 2);
  assert.equal(store.uploadsSince('youtube', 0).length, 0);
});

test('never more than the day allows, and the count resets at midnight Pacific', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, score: 60 + i }));
  const { dir, store } = await setup(many);
  const { u, time } = uploader({ store, dir });
  u.settings.youtube.mode = 'on';
  u.cfg.youtube.spacingMinutes = 10;
  let posted = 0;
  for (let i = 0; i < 12; i += 1) {
    if ((await u.tick())?.status === 'done') posted += 1;
    time.now += 11 * 60_000;
  }
  assert.equal(posted, 5);
  assert.match(u.schedule().why, /today's 5 are done/);
  // Past midnight Pacific (08:00 UTC the next day).
  time.now = Date.parse('2026-11-19T08:05:00Z');
  assert.equal((await u.tick()).status, 'done');
});

test('a restart never posts the same short twice', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const first = uploader({ store, dir });
  first.u.settings.youtube.mode = 'on';
  assert.equal((await first.u.tick()).status, 'done');
  const again = uploader({ store, dir, clock: { now: T0 + 24 * 3600_000 } });
  again.u.settings.youtube.mode = 'on';
  assert.equal(await again.u.tick(), null);
  assert.equal(again.yt.calls.length, 0);
});

test('an upload cut off by a crash is not retried, and is flagged', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  store.claimUpload({ file: 'best-1-t000000-x.mp4', platform: 'youtube', at: new Date(T0 - 5 * 3600_000) });
  const { u, yt } = uploader({ store, dir });
  await u.load();
  u.settings.youtube.mode = 'on';
  u.state.youtube.connected = true;
  assert.equal(await u.tick(), null);
  assert.equal(yt.calls.length, 0);
  assert.equal(store.lastUpload('youtube').status, 'uncertain');
});

test('each failure is handled for what it is', async () => {
  const shorts = [
    { name: 'a', score: 90 },
    { name: 'b', score: 80 },
    { name: 'c', score: 70 },
  ];
  const run = async (kind) => {
    const { dir, store } = await setup(shorts);
    let first = true;
    const yt = fakeYouTube({
      upload: async () => {
        if (first) {
          first = false;
          throw new UploadError(`${kind} failure`, kind);
        }
        return 'ok';
      },
    });
    const { u, time } = uploader({ store, dir, yt });
    u.settings.youtube.mode = 'on';
    const result = await u.tick();
    time.now += 3 * 3600_000 + 1;
    const next = await u.tick();
    return { result, next, u, store };
  };

  // Quota: stop until midnight Pacific, and say so. The short itself goes
  // back in the queue — the quota is about the account, not about this video,
  // and striking it off would lose the best short in the queue every time the
  // allowance runs out mid-upload.
  const quota = await run('quota');
  assert.equal(quota.result.status, 'retry');
  assert.equal(quota.next, null);
  assert.match(quota.u.schedule().why, /quota/);
  assert.equal((await candidates({ store: quota.store, dir: quota.u.dir, platform: 'youtube' })).length, 3);

  // Refused: that short is never tried again; the next one goes.
  const refused = await run('refused');
  assert.equal(refused.result.status, 'refused');
  assert.ok(refused.next.file.startsWith('b-'));

  // A transport failure is the one thing tried again.
  const transient = await run('transient');
  assert.equal(transient.result.status, 'retry');
  assert.ok(transient.next.file.startsWith('a-'));
  assert.equal(transient.next.status, 'done');

  // Unknown whether it landed: never retried.
  const uncertain = await run('uncertain');
  assert.equal(uncertain.result.status, 'uncertain');
  assert.ok(uncertain.next.file.startsWith('b-'));
});

test('a lapsed sign-in spends nothing and stops uploads until reconnected', async () => {
  const { dir, store } = await setup([{ name: 'a', score: 90 }]);
  const yt = fakeYouTube({
    token: async () => {
      throw new UploadError('sign-in: 400 invalid_grant', 'auth');
    },
  });
  const { u } = uploader({ store, dir, yt });
  u.settings.youtube.mode = 'on';
  assert.equal((await u.tick()).status, 'stopped');
  assert.equal(u.state.youtube.connected, false);
  assert.equal(store.uploadsSince('youtube', 0).length, 0);
  assert.equal(yt.calls.length, 0);
});

test('a short that fails its checks at post time is set aside, not posted', async () => {
  const { dir, store } = await setup([
    { name: 'broken', score: 95 },
    { name: 'fine', score: 80 },
  ]);
  const check = async (video) =>
    video.includes('broken') ? { ok: false, problems: [{ text: 'does not decode' }] } : { ok: true, problems: [] };
  const { u, yt } = uploader({ store, dir, check });
  u.settings.youtube.mode = 'on';
  const result = await u.tick();
  assert.ok(result.file.startsWith('fine'));
  assert.equal(yt.calls.length, 1);
  assert.equal(store.all("select status from uploads where file like 'broken%'")[0].status, 'skipped');
});

test('it cannot be switched on without keys and a sign-in', async () => {
  const { dir, store } = await setup([]);
  const { u } = uploader({ store, dir });
  u.state.youtube.connected = false;
  await assert.rejects(u.setMode('youtube', 'on'), /connect YouTube first/);
  await assert.rejects(u.setMode('snapchat', 'on'), /not built yet/);
  await u.setMode('youtube', 'dry-run');
  assert.equal(u.settings.youtube.mode, 'dry-run');
});

test("YouTube's errors are told apart: quota, account, this video, or the network", async () => {
  const { classify } = await import('./youtube.js');
  const err = (reason) => ({ error: { errors: [{ reason }] } });
  assert.equal(classify(403, err('quotaExceeded')), 'quota');
  assert.equal(classify(400, err('uploadLimitExceeded')), 'quota');
  assert.equal(classify(401, err('authError')), 'auth');
  // Account-level 403s stop uploads rather than striking off short after short.
  assert.equal(classify(403, err('insufficientPermissions')), 'auth');
  assert.equal(classify(403, err('youtubeSignupRequired')), 'auth');
  assert.equal(classify(403, null), 'auth');
  // Only a problem with this video is a refusal of it.
  assert.equal(classify(400, err('invalidTitle')), 'refused');
  assert.equal(classify(503, null), 'transient');
  assert.equal(classify(429, null), 'transient');
});
