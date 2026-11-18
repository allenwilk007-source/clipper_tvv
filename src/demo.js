// Synthetic feed for /api/feed?demo=1
//
// Until the game is out the category is empty, so without this there is no way
// to see whether the feed works until the exact night it matters. The fixture
// is pushed through the real clusterClips/scoreMoments path rather than being
// hand-written output, so it exercises the actual pipeline.

import {
  chatCandidateMoments,
  clusterClips,
  mergeChatCandidates,
  publicMoments,
  scoreMoments,
} from './moments.js';

const STREAMERS = [
  ['xqc', '1', 184_000],
  ['kaicenat', '2', 212_000],
  ['caseoh_', '3', 96_000],
  ['jynxzi', '4', 71_000],
  ['shroud', '5', 28_000],
  ['summit1g', '6', 14_000],
];

const TITLES = [
  'first heist goes wrong',
  'cop chase through the causeway',
  'ran into the alligator',
  'physics bug launches the car',
  'jason meets lucia',
  'beach shootout',
  'stole a plane',
  'npc says something unhinged',
];

// A fixed seed keeps the demo stable between reloads, so you can tell a layout
// change from a data change.
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export function demoSnapshot(now = Date.now()) {
  const rand = seeded(20261119);
  const clips = [];
  const streams = new Map();

  for (const [login, id, viewers] of STREAMERS) {
    streams.set(id, { user_id: id, user_name: login, viewer_count: viewers, title: 'GTA VI' });

    const momentCount = 2 + Math.floor(rand() * 3);
    for (let m = 0; m < momentCount; m += 1) {
      // A realistic spread: most moments have a couple of clippers, a few have
      // been found by everyone.
      const roll = rand();
      const saturation = roll > 0.82 ? 14 + Math.floor(rand() * 30) : 1 + Math.floor(rand() * 6);
      const offset = 600 + Math.floor(rand() * 9000);
      const minutesAgo = rand() * 20;
      const title = TITLES[Math.floor(rand() * TITLES.length)];

      for (let c = 0; c < saturation; c += 1) {
        clips.push({
          id: `${login}-${m}-${c}`,
          broadcaster_id: id,
          broadcaster_name: login,
          creator_name: `clipper${Math.floor(rand() * 900) + 100}`,
          video_id: `v${id}${m}`,
          vod_offset: offset + Math.floor(rand() * 20),
          view_count: Math.floor(rand() * 400),
          created_at: new Date(now - minutesAgo * 60_000 + c * 4_000).toISOString(),
          url: `https://clips.twitch.tv/${login}-${m}-${c}`,
          title,
        });
      }
    }
  }

  const chatSpikes = new Map([
    ['kaicenat', { z: 6.4, messagesPerSecond: 71.2, baseline: 22, spiking: true }],
    ['xqc', { z: 2.1, messagesPerSecond: 40.8, baseline: 31, spiking: false }],
    ['jynxzi', { z: 4.8, messagesPerSecond: 33.5, baseline: 12, spiking: true }],
  ]);

  // Chat spikes nobody has clipped yet. Without these the demo cannot show the
  // one row type that exists to beat the crowd rather than keep up with it.
  const channels = new Map(
    STREAMERS.map(([login, id, viewers]) => [
      login,
      {
        broadcasterId: id,
        displayName: login,
        startedAt: new Date(now - 2 * 3600_000).toISOString(),
        vodId: `v${id}demo`,
        title: 'GTA VI',
        viewers,
      },
    ]),
  );

  const candidate = (login, minutesAgo, reaction, classes, shared = false) => {
    const peakAt = now - minutesAgo * 60_000;
    return {
      login,
      startedAt: peakAt - 10_000,
      peakAt,
      lastAt: peakAt,
      buckets: 2,
      reaction,
      shared,
      chat: {
        z: 4.2,
        reaction,
        shared,
        messagesPerSecond: 58.1,
        baseline: 19,
        chatters: 240,
        chattersZ: 3.8,
        copypasta: 0.44,
        spiking: true,
        classes: Object.fromEntries(
          ['clipit', 'funny', 'hype', 'tension', 'shock'].map((name) => [
            name,
            { count: classes[name] || 0, z: classes[name] ? 4 : 0 },
          ]),
        ),
      },
    };
  };

  const candidates = [
    candidate('caseoh_', 0.5, 11.4, { clipit: 9, funny: 31 }),
    candidate('shroud', 2, 7.2, { hype: 26, shock: 11 }),
    // Everyone at once: a game event, not a streamer moment.
    candidate('summit1g', 4, 9.1, { hype: 40 }, true),
  ];

  const withChat = mergeChatCandidates(
    clusterClips(clips, { gapSeconds: 30 }),
    chatCandidateMoments(candidates, { channels }),
  );

  const moments = scoreMoments(withChat, {
    now,
    chatSpikes,
    streams,
    previous: new Map(),
    leadInSeconds: 20,
  });

  const counts = { early: 0, fresh: 0, warm: 0, flooded: 0 };
  for (const moment of moments) counts[moment.state] += 1;

  // Growth since the last poll isn't meaningful in a one-shot fixture, so give
  // the newest few a plausible number rather than claiming every clip is new.
  for (const moment of moments) {
    moment.newClips = moment.minutesSinceLastClip < 3 ? Math.min(moment.saturation, 1 + Math.floor(rand() * 3)) : 0;
  }

  return {
    game: { id: '0', name: 'Grand Theft Auto VI (demo data)' },
    moments: publicMoments(moments),
    meta: {
      counts,
      totalMoments: moments.length,
      clipsScanned: clips.length,
      truncated: false,
      windowMinutes: 25,
      liveChannels: STREAMERS.length,
      lastClipPoll: new Date(now).toISOString(),
      lastStreamPoll: new Date(now).toISOString(),
      pollSeconds: 30,
      chat: { enabled: true, channels: 80, shards: 5, connectedShards: 5, spiking: 2 },
      lastError: null,
      demo: true,
    },
  };
}
