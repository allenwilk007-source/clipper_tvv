// node --test src/eval.test.js    (or: npm test)
//
// The scoreboard has to be trustworthy before anything it says is worth
// acting on, so the metric itself gets tested: a ranking that knows nothing
// must score like chance, and a ranking that knows everything must not.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store, HORIZONS } from './store.js';
import { evaluate, leadTimeSeconds, loadRows } from './eval.js';

const BASE = Date.parse('2026-11-19T20:00:00Z');
const at = (seconds) => new Date(BASE + seconds * 1000).toISOString();

test('lead time is measured against a different clipper, not the same one', () => {
  // One person firing off four clips of their own moment is one person.
  // Counting that as competition would flatter every number downstream.
  const sameGuy = [
    { creator_name: 'alice', created_at: at(0) },
    { creator_name: 'alice', created_at: at(20) },
    { creator_name: 'alice', created_at: at(40) },
  ];
  assert.equal(leadTimeSeconds(sameGuy), null);

  const rival = [...sameGuy, { creator_name: 'bob', created_at: at(90) }];
  assert.equal(leadTimeSeconds(rival), 90);
});

test('lead time is null when nobody else ever turned up', () => {
  assert.equal(leadTimeSeconds([]), null);
  assert.equal(leadTimeSeconds([{ creator_name: 'alice', created_at: at(0) }]), null);
});

const rows = (pairs) =>
  pairs.map(([momentId, opportunity, views], i) => ({
    momentId,
    opportunity,
    views,
    source: i % 2 ? 'chat' : 'clips',
    leadTimeSeconds: 60,
  }));

test('a ranking that knows nothing scores like chance', () => {
  // Opportunity is uncorrelated with views here, so lift must sit near 1.
  const data = rows(
    Array.from({ length: 100 }, (_, i) => [`m${i}`, i % 10, ((i * 37) % 100) * 10]),
  );
  const result = evaluate(data, { topN: 20 });
  assert.ok(result.enough);
  assert.ok(result.lift < 2, `a blind ranking should not show lift, got ${result.lift}`);
});

test('a ranking that is right scores far above chance', () => {
  const data = rows(Array.from({ length: 100 }, (_, i) => [`m${i}`, i, i * 10]));
  const result = evaluate(data, { topN: 20 });
  assert.equal(result.precision, 0.5); // the 10 winners all sit inside the top 20
  assert.ok(result.lift > 4, `expected strong lift, got ${result.lift}`);
});

test('too little history says so instead of printing a confident zero', () => {
  assert.equal(evaluate([]).enough, false);
  assert.equal(evaluate(rows([['m1', 1, 1]])).enough, false);
});

test('the store round-trips a poll and an outcome', () => {
  const store = new Store(':memory:');
  const moment = {
    id: 'm1',
    broadcasterId: '1',
    broadcaster: 'streamer',
    vodId: 'v1',
    offsetSeconds: 1000,
    source: 'clips',
    title: 'a moment',
    saturation: 2,
    uniqueClippers: 2,
    clipViews: 10,
    chatZ: 3,
    opportunity: 4.2,
    firstClipAt: at(0),
    clipIds: ['c1', 'c2'],
  };
  const clipsById = new Map([
    ['c1', { id: 'c1', creator_name: 'alice', created_at: at(0), view_count: 4 }],
    ['c2', { id: 'c2', creator_name: 'bob', created_at: at(120), view_count: 6 }],
  ]);

  store.recordPoll({ moments: [moment], clipsById, at: new Date(BASE) });
  // A second poll of the same moment must not duplicate it.
  store.recordPoll({ moments: [moment], clipsById, at: new Date(BASE + 30_000) });

  const counts = store.counts();
  assert.equal(counts.moments, 1);
  assert.equal(counts.clips, 2);
  assert.equal(counts.observations, 2);

  store.recordOutcome({
    momentId: 'm1',
    horizon: HORIZONS[0],
    clips: [
      { id: 'c1', creator_name: 'alice', created_at: at(0), view_count: 400 },
      { id: 'c2', creator_name: 'bob', created_at: at(120), view_count: 600 },
    ],
    at: new Date(BASE + 900_000),
  });

  const [row] = loadRows(store, '15m');
  assert.equal(row.momentId, 'm1');
  assert.equal(row.views, 1000);
  // Earliest observation wins: what the feed said when it was still actionable.
  assert.equal(row.opportunity, 4.2);
  assert.equal(row.leadTimeSeconds, 120);
  store.close();
});

test('a moment is only due for a horizon it has not been checked at', () => {
  const store = new Store(':memory:');
  store.recordPoll({
    moments: [{ id: 'm1', broadcaster: 'x', saturation: 1, clipIds: [] }],
    at: new Date(BASE),
  });

  const horizon = HORIZONS[0]; // 15m
  assert.deepEqual(store.dueForOutcome(horizon, { now: BASE + 60_000 }), []);
  assert.deepEqual(store.dueForOutcome(horizon, { now: BASE + 20 * 60_000 }), ['m1']);

  store.recordOutcome({ momentId: 'm1', horizon, clips: [] });
  assert.deepEqual(store.dueForOutcome(horizon, { now: BASE + 20 * 60_000 }), []);
  // Later horizons are still owed.
  assert.deepEqual(store.dueForOutcome(HORIZONS[1], { now: BASE + 2 * 3600_000 }), ['m1']);
  store.close();
});

test('a moment first seen in chat and later confirmed is recorded as both', () => {
  const store = new Store(':memory:');
  store.recordPoll({
    moments: [{ id: 'm1', broadcaster: 'x', source: 'chat', saturation: 0, clipIds: [] }],
    at: new Date(BASE),
  });
  store.recordPoll({
    moments: [{ id: 'm1', broadcaster: 'x', source: 'clips', saturation: 2, clipIds: [] }],
    at: new Date(BASE + 60_000),
  });

  const [row] = store.all('select source, detected_at from moments where id = ?', 'm1');
  assert.equal(row.source, 'both');
  // detected_at is when WE first saw it and must never be overwritten — it is
  // the number the whole product is judged on.
  assert.equal(row.detected_at, new Date(BASE).toISOString());
  store.close();
});
