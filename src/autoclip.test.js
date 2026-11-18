// node --test src/autoclip.test.js    (or: npm test)
//
// The selection rules, each against the failure it exists to prevent, and the
// restart behaviour. No subprocesses: the queue is replaced with a recorder.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AutoClipper,
  autoclipConfig,
  cutOffset,
  liveArchiveFrom,
  loginOf,
  placeOnVod,
  selectForAutoclip,
} from './autoclip.js';
import { Store } from './store.js';

const NOW = Date.parse('2026-11-19T21:00:00Z');
const cfg = { ...autoclipConfig({}), pre: 25, post: 5, workDir: 'work', dir: 'ready' };

const moment = (over = {}) => ({
  id: 'm1',
  broadcaster: 'xqc',
  vodId: 'v100',
  offsetSeconds: 1000,
  reactionOffsetSeconds: 1030,
  state: 'fresh',
  opportunity: 5,
  source: 'clips',
  title: 'he drove off the pier',
  firstClipAt: new Date(NOW - 120_000).toISOString(),
  ...over,
});

const select = (moments, cuts = [], overrides = {}) =>
  selectForAutoclip(moments, { now: NOW, cuts, cfg: { ...cfg, ...overrides } });

test('a cut is built around where people reacted, not where the first clip began', () => {
  assert.equal(cutOffset(moment()), 1030);
  assert.equal(cutOffset({ offsetSeconds: 1000 }), 1000);
  assert.equal(cutOffset({ reactionOffsetSeconds: null, offsetSeconds: 5 }), 5);
  assert.equal(cutOffset({}), null);
});

test('nothing is cut before the archive can hold the end of the window', () => {
  // post (5s) + settle (30s) = 35s after the reaction.
  const early = select([moment({ firstClipAt: new Date(NOW - 20_000).toISOString() })]);
  assert.deepEqual(early.picks, []);
  assert.equal(early.skipped.settling, 1);

  const ready = select([moment({ firstClipAt: new Date(NOW - 40_000).toISOString() })]);
  assert.equal(ready.picks.length, 1);
});

test('a moment someone else has had time to post is left alone', () => {
  const { picks, skipped } = select([moment({ firstClipAt: new Date(NOW - 25 * 60_000).toISOString() })]);
  assert.deepEqual(picks, []);
  assert.equal(skipped.stale, 1);
});

test('only early and fresh moments are cut', () => {
  const { picks, skipped } = select([
    moment({ id: 'a', state: 'flooded', vodId: 'v1' }),
    moment({ id: 'b', state: 'warm', vodId: 'v2' }),
    moment({ id: 'c', state: 'early', vodId: 'v3' }),
  ]);
  assert.deepEqual(picks.map((m) => m.id), ['c']);
  assert.equal(skipped.state, 2);
});

test('a moment needs a VOD and a position in it', () => {
  const { picks, skipped } = select([
    moment({ id: 'a', vodId: null }),
    moment({ id: 'b', vodId: 'v2', offsetSeconds: null, reactionOffsetSeconds: null }),
  ]);
  assert.deepEqual(picks, []);
  assert.equal(skipped['no-vod'], 1);
  assert.equal(skipped['no-offset'], 1);
});

test('a moment already cut is not cut again, even under a new id', () => {
  // A chat spike cut earlier, which clips have since confirmed under a
  // different id. Same VOD, 10s apart: the same moment.
  const cuts = [{ momentId: 'chat:xqc:1', vodId: '100', offsetSeconds: 1020, broadcaster: 'xqc', at: NOW - 60_000 }];
  assert.equal(select([moment()], cuts).skipped['already-cut'], 1);

  // A different VOD, or the same VOD well apart, is a different moment.
  assert.equal(select([moment({ vodId: 'v200' })], cuts).picks.length, 1);
  assert.equal(select([moment({ reactionOffsetSeconds: 1100 })], cuts).picks.length, 1);
});

test('when a cap bites, the best moments are the ones kept', () => {
  const moments = [1, 2, 3, 4, 5].map((n) =>
    moment({ id: `m${n}`, broadcaster: `ch${n}`, vodId: `v${n}`, opportunity: n }),
  );
  const { picks, skipped } = select(moments, [], { maxPerPoll: 2 });
  assert.deepEqual(picks.map((m) => m.id), ['m5', 'm4']);
  assert.equal(skipped['poll-limit'], 3);
});

test('the hourly cap and the per-channel cap both hold', () => {
  const hourAgo = (minutes, broadcaster, n) => ({
    momentId: `old${n}`,
    vodId: `vold${n}`,
    offsetSeconds: 0,
    broadcaster,
    at: NOW - minutes * 60_000,
  });

  const full = Array.from({ length: 6 }, (_, n) => hourAgo(30, `other${n}`, n));
  assert.equal(select([moment()], full).skipped['hourly-limit'], 1);
  // Cuts older than an hour no longer count against it.
  const old = Array.from({ length: 6 }, (_, n) => hourAgo(90, `other${n}`, n));
  assert.equal(select([moment()], old).picks.length, 1);

  const twoOfXqc = [hourAgo(10, 'xQc', 1), hourAgo(20, 'xqc', 2)];
  const { picks, skipped } = select(
    [moment({ id: 'x' }), moment({ id: 'y', broadcaster: 'shroud', vodId: 'v9' })],
    twoOfXqc,
  );
  assert.deepEqual(picks.map((m) => m.id), ['y']);
  assert.equal(skipped['channel-limit'], 1);
});

function recorder() {
  const calls = [];
  const enqueue = (args) => {
    calls.push(args);
    return { id: `job${calls.length}` };
  };
  return { calls, enqueue };
}

test('a cut is queued as a short, claimed in the store, and settled', async () => {
  const store = new Store(':memory:');
  const { calls, enqueue } = recorder();
  const auto = new AutoClipper({ store, enqueue, now: () => NOW, cfg });

  await auto.onPoll([moment()]);
  assert.equal(calls.length, 1);
  const [job] = calls;
  assert.equal(job.offsetSeconds, 1030);
  assert.equal(job.dir, 'work');
  assert.equal(job.short.dir, 'ready');
  assert.equal(job.short.auto, true);
  assert.equal(job.short.moment.title, 'he drove off the pier');

  let [row] = store.all('select status, caption from autoclips');
  assert.equal(row.status, 'queued');
  assert.equal(row.caption, 'he drove off the pier');

  job.onSettled({ state: 'done', shortPath: 'ready/x.mp4', message: 'short ready' });
  [row] = store.all('select status, path from autoclips');
  assert.equal(row.status, 'done');
  assert.equal(row.path, 'ready/x.mp4');
  assert.equal(auto.status().done, 1);
  store.close();
});

test('a restart remembers what was cut, and does not cut it again', async () => {
  const store = new Store(':memory:');
  const first = recorder();
  await new AutoClipper({ store, enqueue: first.enqueue, now: () => NOW, cfg }).onPoll([moment()]);
  assert.equal(first.calls.length, 1);

  // The process died mid-render: that row is still 'queued'.
  const second = recorder();
  const restarted = new AutoClipper({ store, enqueue: second.enqueue, now: () => NOW + 60_000, cfg });
  assert.equal(restarted.load(), 1);
  await restarted.onPoll([moment()]);
  assert.equal(second.calls.length, 0);

  // Marked rather than retried: by now the moment has gone stale anyway.
  const [row] = store.all('select status from autoclips');
  assert.equal(row.status, 'interrupted');
  store.close();
});

test('the store refuses to claim the same moment twice', () => {
  const store = new Store(':memory:');
  const claim = { momentId: 'm1', vodId: 'v1', offsetSeconds: 10, broadcaster: 'x', caption: 'c' };
  assert.equal(store.recordAutoclip(claim), true);
  assert.equal(store.recordAutoclip(claim), false);
  store.close();
});

// --- placing chat moments without credentials --------------------------------

const VOD_START = NOW - 3600_000; // the recording began an hour ago

const chatMoment = (over = {}) =>
  moment({
    id: 'chat:lirik:1795018400',
    broadcaster: 'LIRIK',
    source: 'chat',
    state: 'early',
    vodId: null,
    offsetSeconds: null,
    reactionOffsetSeconds: null,
    ...over,
  });

test('a chat moment names its channel; a clip moment does not', () => {
  assert.equal(loginOf(chatMoment()), 'lirik');
  assert.equal(loginOf(moment({ id: '123:vod:1000' })), null);
  // Only a valid login ever reaches a URL.
  assert.equal(loginOf({ id: 'chat:../../x:1' }), null);
});

test('only an archive that is still recording is trusted', () => {
  // Measured: the current recording reports is_live, a finished one was_live.
  // An old VOD at the top of the list (archiving switched off for today) would
  // put "today's offset" into yesterday's broadcast.
  assert.deepEqual(liveArchiveFrom({ id: 'v1', timestamp: 1000, liveStatus: 'is_live' }), {
    vodId: 'v1',
    startedAt: 1_000_000,
  });
  assert.equal(liveArchiveFrom({ id: 'v1', timestamp: 1000, liveStatus: 'was_live' }), null);
  assert.equal(liveArchiveFrom({ id: 'v1', timestamp: NaN, liveStatus: 'is_live' }), null);
  assert.equal(liveArchiveFrom({ id: 'NA', timestamp: 1000, liveStatus: 'is_live' }), null);
});

test('a chat peak is placed by its distance from the start of the recording', () => {
  const archive = { vodId: 'v77', startedAt: VOD_START };
  const placed = placeOnVod(chatMoment(), archive);
  // The peak was two minutes ago, an hour into the recording.
  assert.equal(placed.vodId, 'v77');
  assert.equal(placed.reactionOffsetSeconds, 3480);
  assert.equal(placed.offsetSeconds, 3480);
  assert.equal(placed.offsetEstimated, true);
  assert.equal(placed.source, 'chat');
  // A peak from before this recording began belongs to some other broadcast.
  assert.equal(placeOnVod(chatMoment(), { vodId: 'v77', startedAt: NOW }), null);
});

test('with no credentials a chat moment is placed on the live recording and cut', async () => {
  const lookups = [];
  const findArchive = async (login) => {
    lookups.push(login);
    return { vodId: 'v77', startedAt: VOD_START };
  };
  const { calls, enqueue } = recorder();
  const auto = new AutoClipper({ enqueue, now: () => NOW, cfg, findArchive });

  await auto.onPoll([chatMoment()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].vodId, 'v77');
  assert.equal(calls[0].offsetSeconds, 3480);

  // Looked up once per broadcast, not once per poll.
  await auto.onPoll([chatMoment({ id: 'chat:lirik:1795019000', firstClipAt: new Date(NOW - 60_000).toISOString() })]);
  assert.deepEqual(lookups, ['lirik']);
});

test('a channel that is not recording is asked once, not every poll', async () => {
  let asked = 0;
  const auto = new AutoClipper({
    enqueue: recorder().enqueue,
    now: () => NOW,
    cfg,
    findArchive: async () => {
      asked += 1;
      return null;
    },
  });
  await auto.onPoll([chatMoment()]);
  await auto.onPoll([chatMoment()]);
  assert.equal(asked, 1);
  assert.equal(auto.lastSkipped['no-vod'], 1);
});

test('a moment the feed already placed is never looked up', async () => {
  let asked = 0;
  const auto = new AutoClipper({
    enqueue: recorder().enqueue,
    now: () => NOW,
    cfg,
    findArchive: async () => {
      asked += 1;
      return null;
    },
  });
  await auto.onPoll([chatMoment({ vodId: 'v5', offsetSeconds: 100, reactionOffsetSeconds: 100 })]);
  assert.equal(asked, 0);
});
