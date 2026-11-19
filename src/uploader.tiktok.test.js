// node --test src/uploader.tiktok.test.js    (or: npm test)
//
// The uploader's TikTok side. The YouTube path is covered in
// uploader.test.js; what is tested here is what differs:
//   * the cap is a rolling 24 hours, not a calendar day
//   * an upload is a draft, so the caption is handed to the owner instead
//   * TikTok's own refusals, which are routine rather than exceptional

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from './store.js';
import { TikTokError } from './tiktok.js';
import { Uploader, candidates, tiktokPost } from './uploader.js';

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const T0 = Date.parse('2026-11-18T18:00:00Z'); // 10:00 Pacific
const HOUR = 3600_000;

async function setup(shorts) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-tt-'));
  dirs.push(dir);
  const store = new Store(':memory:');
  for (const [i, s] of shorts.entries()) {
    const file = `${s.name}-1-t00000${i}-x.mp4`;
    store.recordAutoclip({ momentId: `m${i}`, vodId: `v${i}`, offsetSeconds: i * 1000, broadcaster: s.name, caption: 'x', at: new Date(T0 - HOUR + i) });
    store.finishAutoclip(`m${i}`, { status: 'done', path: join(dir, file), review: { score: s.score, weak: false }, at: new Date(T0 - HOUR + i) });
    await writeFile(join(dir, file), 'VIDEO');
    await writeFile(
      join(dir, file.replace('.mp4', '.json')),
      JSON.stringify({
        caption: `"${s.name} line" 😂`,
        game: 'Grand Theft Auto VI',
        broadcaster: s.name,
        link: s.link === undefined ? 'https://twitch.tv/videos/1' : s.link,
      }),
    );
  }
  return { dir, store };
}

function fakeTikTok({ upload = async () => ({ publishId: 'p1', status: 'SEND_TO_USER_INBOX' }) } = {}) {
  const calls = [];
  return {
    calls,
    tiktokKeys: () => ({ clientKey: 'ck', clientSecret: 'cs', redirectUri: 'x' }),
    hasKeys: () => true,
    loadToken: async () => ({ refreshToken: 'r' }),
    forgetToken: async () => {},
    accessTokenFor: async () => 'access',
    uploadVideo: async (args) => {
      calls.push(args);
      return upload(args);
    },
  };
}

// A YouTube stub that is present but switched off, so only TikTok runs.
const idleYouTube = () => ({
  youtubeKeys: () => ({ clientId: '', clientSecret: '', redirectUri: 'x' }),
  hasKeys: () => false,
  loadToken: async () => null,
  forgetToken: async () => {},
  accessToken: async () => 'nope',
  uploadVideo: async () => {
    throw new Error('YouTube should not be called in these tests');
  },
});

function uploader({ store, dir, tt = fakeTikTok(), clock, logs = [] }) {
  const time = clock || { now: T0 };
  const u = new Uploader({
    store,
    dir,
    tt,
    yt: idleYouTube(),
    log: (m) => logs.push(m),
    now: () => time.now,
    settingsPath: join(dir, 'uploads.json'),
    dryRunLog: join(dir, 'dry.jsonl'),
    check: async () => ({ ok: true, problems: [] }),
  });
  u.state.tiktok.connected = true;
  return { u, time, tt, logs };
}

test('the TikTok caption carries the credit and the link back', async () => {
  const { dir, store } = await setup([{ name: 'lirik', score: 88 }]);
  const [c] = await candidates({ store, dir, platform: 'tiktok' });
  const post = tiktokPost(c);

  // TERMS.md promises both with every clip. The hook carries the credit; the
  // inbox endpoint has no caption field, so this is what the owner pastes.
  assert.match(post.caption, /credit: lirik on twitch/i);
  assert.match(post.caption, /https:\/\/twitch\.tv\/videos\/1/);
  assert.match(post.caption, /#gta6/i);
  // The title is the one line, so the de-duplication across a day works.
  assert.ok(!post.title.includes('\n'));
});

test('a short with no VOD still gets a link, to the channel', async () => {
  // Live recordings have no VOD to point into. A clip with no link at all
  // would make TERMS.md false.
  const { dir, store } = await setup([{ name: 'caseoh', score: 88, link: 'https://www.twitch.tv/caseoh' }]);
  const [c] = await candidates({ store, dir, platform: 'tiktok' });
  const post = tiktokPost(c);
  assert.match(post.caption, /Live on Twitch: https:\/\/www\.twitch\.tv\/caseoh/);
});

test('an upload is a draft, and the owner is told so and given the caption', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const { u, tt, logs } = uploader({ store, dir });
  u.settings.tiktok.mode = 'on';

  const result = await u.tick();

  assert.equal(result.status, 'done');
  assert.equal(result.platform, 'tiktok');
  assert.equal(result.videoId, 'p1');
  assert.equal(tt.calls.length, 1);
  // Not "posted to your profile": it is a draft until the owner taps post.
  assert.ok(logs.some((l) => /draft in your TikTok inbox/.test(l)));
  assert.ok(logs.some((l) => /caption to paste/.test(l) && /credit: best on twitch/i.test(l)));
});

test('the cap is a rolling 24 hours, not a calendar day', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, score: 60 + i }));
  const { dir, store } = await setup(many);
  const { u, time } = uploader({ store, dir });
  u.settings.tiktok.mode = 'on';
  u.cfg.tiktok.spacingMinutes = 10;

  let posted = 0;
  for (let i = 0; i < 8; i += 1) {
    if ((await u.tick())?.status === 'done') posted += 1;
    time.now += 11 * 60_000;
  }
  // TikTok allows 5 pending shares in any 24 hours.
  assert.equal(posted, 5);
  assert.match(u.schedule('tiktok').why, /today's 5 are done/);
  // It lifts 24 hours after the OLDEST attempt, not at a clock time.
  assert.equal(u.schedule('tiktok').resetAt, T0 + 24 * HOUR);

  // Midnight Pacific is 08:00 UTC, 14 hours after T0. YouTube's quota would
  // have reset by now. TikTok's has not, and must not.
  time.now = Date.parse('2026-11-19T08:05:00Z');
  assert.equal(await u.tick(), null);

  // Once the first attempt ages out of the window, there is room for one more.
  time.now = T0 + 24 * HOUR + 60_000;
  assert.equal((await u.tick())?.status, 'done');
});

test('the two platforms are counted and queued apart', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const { u } = uploader({ store, dir });
  u.settings.tiktok.mode = 'on';

  await u.tick();

  // Posted to TikTok, so it is out of TikTok's queue...
  assert.deepEqual(await candidates({ store, dir, platform: 'tiktok' }), []);
  // ...and still waiting for YouTube.
  assert.equal((await candidates({ store, dir, platform: 'youtube' })).length, 1);
  assert.equal(store.uploadsSince('tiktok', 0).length, 1);
  assert.equal(store.uploadsSince('youtube', 0).length, 0);
});

test('a cap reached mid-upload puts the short back, it does not burn it', async () => {
  // TikTok's init refuses outright once 5 shares are pending, which is the
  // normal state of affairs if the owner posts the drafts slowly. Striking
  // the short off for that would lose the best one in the queue each time.
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const { u } = uploader({
    store,
    dir,
    tt: fakeTikTok({
      upload: async () => {
        throw new TikTokError('starting the upload: 403 spam_risk_too_many_pending_share', 'quota');
      },
    }),
  });
  u.settings.tiktok.mode = 'on';

  const result = await u.tick();

  assert.equal(result.status, 'retry');
  // Back in the queue for next time, not struck off.
  assert.equal((await candidates({ store, dir, platform: 'tiktok' })).length, 1);
  // And the uploader has stopped until the window moves, rather than trying
  // the next-best short straight into the same refusal.
  assert.match(u.state.tiktok.blockedReason, /24-hour share cap/);
});

test('a refused video is set aside for good, and only that one', async () => {
  const { dir, store } = await setup([
    { name: 'best', score: 88 },
    { name: 'okay', score: 70 },
  ]);
  const { u } = uploader({
    store,
    dir,
    tt: fakeTikTok({
      upload: async () => {
        throw new TikTokError('TikTok rejected the video: duration_check_failed', 'refused');
      },
    }),
  });
  u.settings.tiktok.mode = 'on';

  assert.equal((await u.tick()).status, 'refused');

  const left = await candidates({ store, dir, platform: 'tiktok' });
  assert.deepEqual(
    left.map((c) => c.saved.broadcaster),
    ['okay'],
  );
  // Nothing is blocked: the account is fine, this video was not.
  assert.equal(u.state.tiktok.blockedUntil, 0);
});

test('a banned account stops uploads without claiming the sign-in died', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const { u, logs } = uploader({
    store,
    dir,
    tt: fakeTikTok({
      upload: async () => {
        throw new TikTokError('starting the upload: 403 spam_risk_user_banned_from_posting', 'blocked');
      },
    }),
  });
  u.settings.tiktok.mode = 'on';

  await u.tick();

  // Telling the owner to reconnect would be a lie, and they would do it over
  // and over to no effect.
  assert.equal(u.state.tiktok.connected, true);
  assert.match(u.state.tiktok.blockedReason, /refusing this account/);
  assert.equal(u.state.tiktok.blockedUntil, Number.POSITIVE_INFINITY);
  assert.ok(logs.some((l) => /not something to retry around/.test(l)));
});

test('it cannot be switched on without keys and a sign-in', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const { u } = uploader({ store, dir });

  u.state.tiktok.connected = false;
  await assert.rejects(u.setMode('tiktok', 'on'), /connect TikTok first/);
  await assert.rejects(u.setMode('snapchat', 'on'), /not built yet/);
  // Instagram IS built now, so it gets the keys message rather than that one.
  await assert.rejects(u.setMode('instagram', 'on'), /INSTAGRAM_APP_ID/);
  await u.setMode('tiktok', 'dry-run');
  assert.equal(u.settings.tiktok.mode, 'dry-run');

  // Dry run needs neither, so a day can be seen before anything is connected.
  assert.equal((await u.tick())?.status, 'dry-run');
});

test('a refresh token already past its expiry is not a connection', async () => {
  // TikTok refresh tokens last 180 days. Finding out by spending a slot is
  // worse than saying so up front.
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const expired = fakeTikTok();
  expired.loadToken = async () => ({ refreshToken: 'r', refreshExpiresAt: T0 - HOUR });
  const { u } = uploader({ store, dir, tt: expired });

  assert.equal(await u.isConnected('tiktok'), false);

  const live = fakeTikTok();
  live.loadToken = async () => ({ refreshToken: 'r', refreshExpiresAt: T0 + HOUR });
  const { u: u2 } = uploader({ store, dir, tt: live });
  assert.equal(await u2.isConnected('tiktok'), true);
});

test('the page says plainly that TikTok uploads are drafts', async () => {
  const { dir, store } = await setup([{ name: 'best', score: 88 }]);
  const { u } = uploader({ store, dir });
  const view = await u.view();

  assert.equal(view.tiktok.built, true);
  assert.equal(view.tiktok.draftsOnly, true);
  assert.match(view.tiktok.draftNote, /draft in your inbox/);
  assert.equal(view.tiktok.perDay, 5);
  // Instagram posts for real, so it carries no draft note.
  assert.equal(view.instagram.built, true);
  assert.equal(view.instagram.draftsOnly, undefined);
});
