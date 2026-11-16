// node --test src/moments.test.js    (or: npm test)
//
// These cover the two things that have to be right for the feed to mean
// anything: clips from one moment cluster together, and ranking prefers
// unsaturated moments over merely popular ones.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clusterClips, saturationState, scoreMoments } from './moments.js';

const BASE = Date.parse('2026-11-19T20:00:00Z');

function clip({
  id = Math.random().toString(36).slice(2),
  broadcaster = 'streamer',
  broadcasterId = '1',
  offset = 100,
  createdMinutes = 0,
  views = 0,
  creator = 'clipper',
  video = 'v1',
}) {
  return {
    id,
    broadcaster_id: broadcasterId,
    broadcaster_name: broadcaster,
    creator_name: creator,
    video_id: video,
    vod_offset: offset,
    view_count: views,
    created_at: new Date(BASE + createdMinutes * 60_000).toISOString(),
    url: `https://clips.twitch.tv/${id}`,
    title: 'a moment',
  };
}

test('clips near the same VOD position become one moment', () => {
  const moments = clusterClips(
    [
      clip({ offset: 1000, creator: 'a' }),
      clip({ offset: 1012, creator: 'b' }),
      clip({ offset: 1025, creator: 'c' }),
    ],
    { gapSeconds: 30 },
  );

  assert.equal(moments.length, 1);
  assert.equal(moments[0].saturation, 3);
  assert.equal(moments[0].uniqueClippers, 3);
  assert.equal(moments[0].offsetSeconds, 1000);
});

test('a gap larger than the threshold splits moments', () => {
  const moments = clusterClips([clip({ offset: 1000 }), clip({ offset: 1100 })], {
    gapSeconds: 30,
  });
  assert.equal(moments.length, 2);
});

test('single-linkage keeps one long moment together', () => {
  // Each clip is within 25s of the previous one, so the run should not split
  // even though the first and last are 75s apart.
  const moments = clusterClips(
    [clip({ offset: 1000 }), clip({ offset: 1025 }), clip({ offset: 1050 }), clip({ offset: 1075 })],
    { gapSeconds: 30 },
  );
  assert.equal(moments.length, 1);
  assert.equal(moments[0].saturation, 4);
});

test('different broadcasters never merge', () => {
  const moments = clusterClips(
    [
      clip({ broadcasterId: '1', broadcaster: 'alice', offset: 1000 }),
      clip({ broadcasterId: '2', broadcaster: 'bob', offset: 1000 }),
    ],
    { gapSeconds: 30 },
  );
  assert.equal(moments.length, 2);
});

test('clips without a VOD position still cluster, flagged as pending', () => {
  const moments = clusterClips([
    { ...clip({ createdMinutes: 0 }), vod_offset: null, video_id: null },
    { ...clip({ createdMinutes: 0.2 }), vod_offset: null, video_id: null },
  ]);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].basis, 'created');
  assert.equal(moments[0].offsetSeconds, null);
});

test('deep link starts before the moment, because chat reacts late', () => {
  const [moment] = scoreMoments(clusterClips([clip({ offset: 3700 })]), {
    now: BASE + 60_000,
    leadInSeconds: 20,
  });
  // 3700 - 20 = 3680s = 1h01m20s
  assert.match(moment.deepLink, /\?t=1h01m20s$/);
});

test('lead-in never produces a negative timestamp', () => {
  const [moment] = scoreMoments(clusterClips([clip({ offset: 5 })]), {
    now: BASE + 60_000,
    leadInSeconds: 20,
  });
  assert.match(moment.deepLink, /\?t=0h00m00s$/);
});

test('saturation states draw the lines the UI colours on', () => {
  assert.equal(saturationState(1), 'fresh');
  assert.equal(saturationState(2), 'fresh');
  assert.equal(saturationState(3), 'warm');
  assert.equal(saturationState(6), 'warm');
  assert.equal(saturationState(7), 'flooded');
});

test('an unsaturated moment outranks a busier, more flooded one', () => {
  // The flooded moment is genuinely hotter: 40 clips in a minute against 2.
  // It must still rank below, or the feed is just a popularity chart.
  const quiet = Array.from({ length: 2 }, (_, i) =>
    clip({ broadcasterId: '1', broadcaster: 'quiet', offset: 1000 + i, createdMinutes: i * 0.5 }),
  );
  const flooded = Array.from({ length: 40 }, (_, i) =>
    clip({ broadcasterId: '2', broadcaster: 'flooded', offset: 2000 + i, createdMinutes: i * 0.025 }),
  );

  const moments = scoreMoments(clusterClips([...quiet, ...flooded], { gapSeconds: 30 }), {
    now: BASE + 60_000,
  });

  const quietMoment = moments.find((m) => m.broadcaster === 'quiet');
  const floodedMoment = moments.find((m) => m.broadcaster === 'flooded');

  assert.equal(quietMoment.state, 'fresh');
  assert.equal(floodedMoment.state, 'flooded');
  assert.ok(
    quietMoment.opportunity > floodedMoment.opportunity,
    `expected fresh (${quietMoment.opportunity}) to outrank flooded (${floodedMoment.opportunity})`,
  );
});

test('a chat spike lifts a moment without inventing one', () => {
  const clips = clusterClips([clip({ offset: 1000 }), clip({ offset: 1010 })]);
  const cold = scoreMoments(clips, { now: BASE + 60_000 })[0];
  const hot = scoreMoments(clips, {
    now: BASE + 60_000,
    chatSpikes: new Map([['streamer', { z: 5, spiking: true, messagesPerSecond: 40, baseline: 8 }]]),
  })[0];

  assert.equal(cold.chatZ, 0);
  assert.equal(hot.chatZ, 5);
  assert.ok(hot.opportunity > cold.opportunity);
});

test('newClips reports growth since the previous poll', () => {
  const clips = clusterClips([clip({ offset: 1000 }), clip({ offset: 1010 }), clip({ offset: 1020 })]);
  const [moment] = scoreMoments(clips, {
    now: BASE + 60_000,
    previous: new Map([[clips[0].id, 1]]),
  });
  assert.equal(moment.saturation, 3);
  assert.equal(moment.newClips, 2);
});

test('staleness pushes an old moment down', () => {
  const clips = clusterClips([clip({ offset: 1000 }), clip({ offset: 1010 })]);
  const recent = scoreMoments(clips, { now: BASE + 60_000 })[0];
  const stale = scoreMoments(clips, { now: BASE + 45 * 60_000 })[0];
  assert.ok(stale.opportunity < recent.opportunity);
});
