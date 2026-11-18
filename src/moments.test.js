// node --test src/moments.test.js    (or: npm test)
//
// These cover the two things that have to be right for the feed to mean
// anything: clips from one moment cluster together, and ranking prefers
// unsaturated moments over merely popular ones.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatCandidateMoments,
  clusterClips,
  mergeChatCandidates,
  saturationState,
  scoreMoments,
} from './moments.js';

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

// ---------- chat-sourced moments (the only way to be first) ----------

const candidate = ({
  login = 'streamer',
  peakMinutes = 0,
  reaction = 8,
  shared = false,
  clipit = 0,
} = {}) => ({
  login,
  startedAt: BASE + peakMinutes * 60_000,
  peakAt: BASE + peakMinutes * 60_000,
  lastAt: BASE + peakMinutes * 60_000,
  buckets: 1,
  reaction,
  shared,
  chat: {
    z: 4,
    reaction,
    shared,
    classes: { clipit: { count: clipit, z: clipit ? 4 : 0 } },
    copypasta: 0.4,
  },
});

const CHANNELS = new Map([
  [
    'streamer',
    {
      broadcasterId: '1',
      displayName: 'streamer',
      startedAt: new Date(BASE - 3600_000).toISOString(),
      vodId: 'v99',
      title: 'live',
    },
  ],
]);

test('a chat spike becomes a moment with no clips in it', () => {
  const [moment] = chatCandidateMoments([candidate({})], { channels: CHANNELS });
  assert.equal(moment.saturation, 0);
  assert.equal(moment.source, 'chat');
  assert.equal(moment.vodId, 'v99');
  // Estimated from stream uptime: one hour in.
  assert.equal(moment.offsetSeconds, 3600);
  assert.equal(moment.offsetEstimated, true);
});

test('an unconfirmed moment ranks as early, and says so', () => {
  const [moment] = scoreMoments(chatCandidateMoments([candidate({})], { channels: CHANNELS }), {
    now: BASE + 30_000,
  });
  assert.equal(moment.state, 'early');
  assert.equal(moment.unconfirmed, true);
  assert.ok(moment.opportunity > 0);
});

test('a chat spike on the same channel at the same time is the same moment', () => {
  // Chat fires first and clips follow a minute later. Showing both would be
  // the feed lying about how many moments there are.
  const clips = clusterClips([clip({ offset: 1000 }), clip({ offset: 1010, createdMinutes: 1 })]);
  const merged = mergeChatCandidates(clips, chatCandidateMoments([candidate({})], { channels: CHANNELS }));

  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'both');
  assert.equal(merged[0].saturation, 2);
  // The clips win on identity, because they carry a real VOD offset.
  assert.equal(merged[0].offsetSeconds, 1000);
});

test('a chat spike nowhere near any clips stays its own moment', () => {
  const clips = clusterClips([clip({ offset: 1000 })]);
  const merged = mergeChatCandidates(
    clips,
    chatCandidateMoments([candidate({ peakMinutes: 45 })], { channels: CHANNELS }),
  );
  assert.equal(merged.length, 2);
  assert.ok(merged.some((m) => m.source === 'chat'));
});

test('an unconfirmed moment is discounted for being a guess', () => {
  // Zero saturation takes no crowding penalty at all, so a chat-only moment
  // gets a flat haircut for the chance that nothing actually happened.
  //
  // Note what this test does NOT claim: that a confirmed moment should
  // outrank an unconfirmed one. By the thesis, unclipped beats clipped — so
  // how big this discount ought to be is exactly the kind of question
  // `npm run eval` exists to answer, and it is left open on purpose.
  const [moment] = scoreMoments(chatCandidateMoments([candidate({})], { channels: CHANNELS }), {
    now: BASE,
  });

  assert.equal(moment.saturation, 0);
  assert.equal(moment.unconfirmed, true);
  // reaction 8, recency 1 at zero age, no saturation penalty, 0.75 discount.
  assert.ok(
    Math.abs(moment.opportunity - 8 * 0.75) < 0.01,
    `expected the discount to be applied, got ${moment.opportunity}`,
  );
});

test('a category-wide spike is discounted against a single channel popping', () => {
  // Three channels at once means the game did something and every clipper
  // watching the category already has it.
  const alone = scoreMoments(chatCandidateMoments([candidate({})], { channels: CHANNELS }), {
    now: BASE + 30_000,
  })[0];
  const everyone = scoreMoments(
    chatCandidateMoments([candidate({ shared: true })], { channels: CHANNELS }),
    { now: BASE + 30_000 },
  )[0];
  assert.ok(alone.opportunity > everyone.opportunity);
});

test('the reaction score drives ranking, with the old z-score as a fallback', () => {
  const clips = clusterClips([clip({ offset: 1000 }), clip({ offset: 1010 })]);
  const rich = scoreMoments(clips, {
    now: BASE + 60_000,
    chatSpikes: new Map([['streamer', { z: 1, reaction: 9, spiking: true }]]),
  })[0];
  const plain = scoreMoments(clips, {
    now: BASE + 60_000,
    chatSpikes: new Map([['streamer', { z: 1, spiking: true }]]),
  })[0];

  // Same volume z, far richer reaction: it has to matter.
  assert.equal(rich.chatZ, 1);
  assert.equal(plain.chatZ, 1);
  assert.ok(rich.opportunity > plain.opportunity);
});

test('a spike keeps one id as its peak moves', () => {
  // The peak shifts as a spike grows. Keying the moment on it would file one
  // spike under several ids and quietly multiply rows in the store.
  const base = { login: 'streamer', startedAt: BASE, lastAt: BASE + 20_000, buckets: 3, chat: {} };
  const early = chatCandidateMoments([{ ...base, peakAt: BASE, reaction: 5 }], {
    channels: CHANNELS,
  })[0];
  const later = chatCandidateMoments([{ ...base, peakAt: BASE + 20_000, reaction: 9 }], {
    channels: CHANNELS,
  })[0];

  assert.equal(early.id, later.id);
  // The offset still tracks the peak, which is where the moment actually is.
  assert.ok(later.offsetSeconds > early.offsetSeconds);
});
