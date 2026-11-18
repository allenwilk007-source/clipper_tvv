// node --test src/autoclip.test.js    (or: npm test)
//
// The selection rules, each against the failure it exists to prevent, and the
// restart behaviour. No subprocesses: the queue is replaced with a recorder.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AutoClipper, autoclipConfig, cutOffset, momentLogin, selectForAutoclip } from './autoclip.js';
import { Store } from './store.js';

const NOW = Date.parse('2026-11-19T21:00:00Z');
// Caps pinned here rather than read from the defaults, so raising a default
// cannot quietly weaken what these tests check. No game filter unless a test
// asks for one.
const cfg = {
  ...autoclipConfig({}),
  games: [],
  perHour: 6,
  perChannelPerHour: 2,
  maxPerPoll: 2,
  pre: 25,
  post: 5,
  workDir: 'work',
  dir: 'ready',
};

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
  assert.equal(job.short.music, false);
  // The render is told which titles not to repeat, this one's included.
  assert.ok(job.short.avoid.some((title) => title.startsWith('he drove off the pier')));

  let [row] = store.all('select status, caption from autoclips');
  assert.equal(row.status, 'queued');
  // Provisional, with an emoji: the clip title, before anything was transcribed.
  assert.match(row.caption, /^he drove off the pier \p{Extended_Pictographic}$/u);

  // The render returns the final title, shaped by what was said.
  job.onSettled({ state: 'done', shortPath: 'ready/x.mp4', message: 'short ready', caption: '"Bye bye car" 😂' });
  [row] = store.all('select status, path, caption from autoclips');
  assert.equal(row.status, 'done');
  assert.equal(row.path, 'ready/x.mp4');
  assert.equal(row.caption, '"Bye bye car" 😂');
  assert.equal(auto.status().done, 1);
  // And it will not be used again.
  assert.ok(auto.recentCaptions.includes('"Bye bye car" 😂'));
  store.close();
});

test('background music follows the switch, for shorts queued after it', async () => {
  const { calls, enqueue } = recorder();
  const auto = new AutoClipper({ enqueue, now: () => NOW, cfg });
  auto.setMusic(true);
  await auto.onPoll([moment()]);
  assert.equal(calls[0].short.music, true);
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

// --- channel automation -------------------------------------------------------

test('a moment names its channel, from a chat id or a display name', () => {
  assert.equal(momentLogin({ id: 'chat:caseoh_:1795018400', broadcaster: 'CaseOh' }), 'caseoh_');
  assert.equal(momentLogin({ id: '123:vod:1000', broadcaster: 'xQc' }), 'xqc');
});

test('with channels added, only those channels are clipped', () => {
  const { picks, skipped } = select(
    [moment({ id: 'a', broadcaster: 'xQc' }), moment({ id: 'b', broadcaster: 'shroud', vodId: 'v9' })],
    [],
    { channels: ['xqc'] },
  );
  assert.deepEqual(picks.map((m) => m.id), ['a']);
  assert.equal(skipped['not-automated'], 1);
});

test('with no channels added, every channel the feed sees is fair game', () => {
  const { picks } = select([moment({ id: 'a' }), moment({ id: 'b', broadcaster: 'shroud', vodId: 'v9' })]);
  assert.equal(picks.length, 2);
});

test('the channel list can be changed while running', async () => {
  const { calls, enqueue } = recorder();
  const auto = new AutoClipper({ enqueue, now: () => NOW, cfg });
  auto.setChannels(['shroud']);
  await auto.onPoll([moment()]);
  assert.equal(calls.length, 0);
  assert.equal(auto.lastSkipped['not-automated'], 1);

  auto.setChannels(['xqc']);
  await auto.onPoll([moment()]);
  assert.equal(calls.length, 1);
});

// --- games -------------------------------------------------------------------

test('only the configured games are clipped, whatever the channel', () => {
  const games = { games: ['Grand Theft Auto VI', 'Fortnite'] };
  const { picks, skipped } = select(
    [
      moment({ id: 'gta', game: 'Grand Theft Auto VI' }),
      moment({ id: 'fn', broadcaster: 'clix', vodId: 'v2', game: 'fortnite' }),
      // The first live test cut this one and tagged it #gta6.
      moment({ id: 'wow', broadcaster: 'sodapoppin', vodId: 'v3', game: 'World of Warcraft' }),
    ],
    [],
    { ...games, maxPerPoll: 5 },
  );
  assert.deepEqual(picks.map((m) => m.id).sort(), ['fn', 'gta']);
  assert.equal(skipped['other-game'], 1);
});

test('a moment whose game cannot be told is skipped, not guessed', () => {
  const { picks, skipped } = select([moment({ game: null })], [], { games: ['Fortnite'] });
  assert.deepEqual(picks, []);
  assert.equal(skipped['unknown-game'], 1);
});

test('the defaults now allow far more shorts an hour', () => {
  const defaults = autoclipConfig({});
  assert.equal(defaults.perHour, 30);
  assert.equal(defaults.perChannelPerHour, 6);
  assert.equal(defaults.maxPerPoll, 4);
  assert.deepEqual(defaults.games, ['Grand Theft Auto VI', 'Fortnite']);
});

// --- across copies of the app --------------------------------------------------

test('the same moment is claimed once, even by a different copy under a different id', () => {
  const store = new Store(':memory:');
  // Measured before this: lirik cut twice, six seconds apart, by two copies.
  assert.equal(store.recordAutoclip({ momentId: 'chat:lirik:1', vodId: '2932444934', offsetSeconds: 12077, broadcaster: 'lirik' }), true);
  assert.equal(store.recordAutoclip({ momentId: 'chat:lirik:2', vodId: 'v2932444934', offsetSeconds: 12083, broadcaster: 'lirik' }), false);
  // Well apart on the same recording is a different moment.
  assert.equal(store.recordAutoclip({ momentId: 'chat:lirik:3', vodId: '2932444934', offsetSeconds: 12200, broadcaster: 'lirik' }), true);
  store.close();
});

test("the meter's verdict is kept with each short", () => {
  const store = new Store(':memory:');
  store.recordAutoclip({ momentId: 'm1', vodId: '1', offsetSeconds: 10, broadcaster: 'x' });
  store.finishAutoclip('m1', {
    status: 'done',
    path: 'ready/x.mp4',
    caption: '"Are you crazy?" 😳',
    review: { score: 62, funny: 40, redone: true, before: 38, weak: false, reasons: ['a 12 dB burst at the payoff'] },
  });
  const [row] = store.listAutoclips();
  assert.equal(row.score, 62);
  assert.equal(row.funny, 40);
  assert.equal(row.redone, 1);
  assert.equal(row.weak, 0);
  assert.deepEqual(JSON.parse(row.review).reasons, ['a 12 dB burst at the payoff']);
  store.close();
});
