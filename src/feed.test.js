import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Feed } from './feed.js';

/**
 * A chat watcher that opens no sockets and returns exactly what it is told to.
 *
 * The real one connects to Twitch the moment it is handed a channel, which
 * would make this file a test of Twitch rather than of the feed.
 */
class FakeChat {
  constructor(candidates = []) {
    this.candidatesList = candidates;
    this.channels = [];
    this.started = false;
    this.stopped = false;
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }

  setChannels(logins) {
    this.channels = [...logins];
  }

  candidates() {
    return this.candidatesList;
  }

  spikes() {
    return new Map();
  }

  status() {
    return { enabled: true, channels: this.channels.length, shards: 1, connectedShards: 1 };
  }
}

/** Any Helix call at all is a failure in chat-only mode. */
const forbiddenTwitch = {
  configured: false,
  gameById: () => assert.fail('called Helix in chat-only mode'),
  resolveGame: () => assert.fail('called Helix in chat-only mode'),
  liveStreams: () => assert.fail('called Helix in chat-only mode'),
  recentClips: () => assert.fail('called Helix in chat-only mode'),
  clipsByIds: () => assert.fail('called Helix in chat-only mode'),
  archiveVideo: () => assert.fail('called Helix in chat-only mode'),
};

const candidate = (login, { reaction = 8, shared = false, at = Date.now() } = {}) => ({
  login,
  startedAt: at - 10_000,
  peakAt: at,
  lastAt: at,
  buckets: 2,
  reaction,
  shared,
  chat: {
    z: 4.1,
    reaction,
    shared,
    messagesPerSecond: 40,
    baseline: 12,
    chatters: 180,
    copypasta: 0.3,
    spiking: true,
    classes: { clipit: { count: 7, z: 4 }, funny: { count: 22, z: 5 } },
  },
});

// The real recording lookup runs yt-dlp against Twitch. By default nobody is
// recording, which is the state every test above this line was written for.
const nobodyRecording = async () => null;

function chatOnlyFeed(candidates, watchChannels = ['caseoh_', 'xqc'], findArchive = nobodyRecording) {
  const chat = new FakeChat(candidates);
  const feed = new Feed({
    log: () => {},
    chat,
    store: null,
    watchChannels,
    findArchive,
  });
  feed.twitch = forbiddenTwitch;
  return { feed, chat };
}

let open = null;
afterEach(() => {
  open?.stop();
  open = null;
});

describe('chat-only mode', () => {
  it('runs without credentials and never touches Helix', async () => {
    const { feed } = chatOnlyFeed([candidate('caseoh_')]);
    open = feed;

    assert.equal(feed.chatOnly, true);
    await feed.start();

    assert.equal(feed.game.id, null);
    assert.match(feed.game.name, /2 watched channels/);
    assert.equal(feed.lastError, null);
  });

  it('watches the channels it was given, not a category', async () => {
    const { feed, chat } = chatOnlyFeed([], ['Shroud', 'summit1g']);
    open = feed;

    await feed.start();

    // Lowercased, because IRC channel names are.
    assert.deepEqual(chat.channels.sort(), ['shroud', 'summit1g']);
    assert.deepEqual([...feed.channels.keys()].sort(), ['shroud', 'summit1g']);
    assert.equal(chat.started, true);
  });

  it('turns a chat spike into an unconfirmed moment at zero saturation', async () => {
    const { feed } = chatOnlyFeed([candidate('caseoh_', { reaction: 11.4 })]);
    open = feed;

    await feed.start();

    assert.equal(feed.moments.length, 1);
    const [moment] = feed.moments;
    assert.equal(moment.broadcaster, 'caseoh_');
    assert.equal(moment.source, 'chat');
    assert.equal(moment.saturation, 0);
    assert.equal(moment.uniqueClippers, 0);
    assert.equal(moment.unconfirmed, true);
    assert.equal(moment.state, 'early');
    assert.ok(moment.reaction > 0);
  });

  it('links to the live channel when there is no VOD to point at', async () => {
    const { feed } = chatOnlyFeed([candidate('caseoh_')]);
    open = feed;

    await feed.start();

    const [moment] = feed.moments;
    // Helix supplies stream start and VOD id, so neither is knowable here.
    // Guessing an offset would put a wrong timestamp in front of the user.
    assert.equal(moment.vodId, null);
    assert.equal(moment.offsetSeconds, null);
    assert.equal(moment.deepLink, 'https://www.twitch.tv/caseoh_');
  });

  it('ranks a lone spike above one the whole watch list shared', async () => {
    const now = Date.now();
    const { feed } = chatOnlyFeed([
      candidate('summit1g', { reaction: 10, shared: true, at: now }),
      candidate('caseoh_', { reaction: 8, shared: false, at: now }),
    ]);
    open = feed;

    await feed.start();

    assert.equal(feed.moments.length, 2);
    // Everyone spiking at once is the game, not the streamer: every clipper in
    // the category will have it within minutes.
    assert.equal(feed.moments[0].broadcaster, 'caseoh_');
    assert.equal(feed.moments[1].shared, true);
  });

  it('reports the mode in the snapshot rather than faking live channels', async () => {
    const { feed } = chatOnlyFeed([candidate('caseoh_')]);
    open = feed;

    await feed.start();
    const snapshot = feed.snapshot();

    assert.equal(snapshot.meta.chatOnly, true);
    assert.equal(snapshot.meta.watchedChannels, 2);
    // Watched is not live, and without Helix there is no way to tell which of
    // them is actually broadcasting.
    assert.equal(snapshot.meta.liveChannels, 0);
    assert.equal(snapshot.meta.clipsScanned, 0);
    assert.equal(snapshot.meta.counts.early, 1);
  });

  it('keeps the bookkeeping fields out of what the browser gets', async () => {
    const { feed } = chatOnlyFeed([candidate('caseoh_')]);
    open = feed;

    await feed.start();
    const [moment] = feed.snapshot().moments;

    assert.equal('clipIds' in moment, false);
    assert.equal('chatCandidate' in moment, false);
    // The evidence that put the row on screen still has to survive.
    assert.ok(moment.chat);
    assert.equal(moment.chat.classes.clipit.count, 7);
  });
});

describe('chat-only mode with a recording in progress', () => {
  it('places a moment on the live recording, so it can be cut', async () => {
    const now = Date.now();
    const lookups = [];
    const { feed } = chatOnlyFeed([candidate('caseoh_', { at: now })], ['caseoh_', 'xqc'], async (login) => {
      lookups.push(login);
      // Recording for the last hour.
      return { vodId: '77', startedAt: now - 3600_000 };
    });
    open = feed;

    await feed.start();

    const [moment] = feed.moments;
    assert.equal(moment.vodId, '77');
    // The peak, measured from the recording's own start.
    assert.ok(Math.abs(moment.offsetSeconds - 3600) <= 1, `offset ${moment.offsetSeconds}`);
    assert.equal(moment.reactionOffsetSeconds, moment.offsetSeconds);
    assert.match(moment.deepLink, /^https:\/\/www\.twitch\.tv\/videos\/77\?t=/);
    // Only the channel that spiked was looked up.
    assert.deepEqual(lookups, ['caseoh_']);
  });

  it('looks a channel up once per broadcast, not once per poll', async () => {
    let asked = 0;
    const { feed } = chatOnlyFeed([candidate('caseoh_')], ['caseoh_'], async () => {
      asked += 1;
      return null;
    });
    open = feed;

    await feed.start();
    await feed.pollChat();
    await feed.pollChat();
    assert.equal(asked, 1);
  });

  it('keeps a recording it already found when the watch list is edited', async () => {
    const now = Date.now();
    const { feed } = chatOnlyFeed([candidate('caseoh_', { at: now })], ['caseoh_'], async () => ({
      vodId: '77',
      startedAt: now - 60_000,
    }));
    open = feed;

    await feed.start();
    feed.setWatchList(['caseoh_', 'lirik']);
    assert.equal(feed.channels.get('caseoh_').vodId, '77');
    assert.equal(feed.channels.get('lirik').vodId, null);
    assert.deepEqual(feed.watchChannels, ['caseoh_', 'lirik']);
  });
});

describe('the full feed with credentials', () => {
  it('watches every configured game and tags each moment with its own', async () => {
    const asked = { streams: [], clips: [] };
    const clip = (id, gameId, broadcaster, offset) => ({
      id,
      game_id: gameId,
      broadcaster_id: broadcaster,
      broadcaster_name: broadcaster,
      creator_name: `${id}-maker`,
      video_id: `vod-${broadcaster}`,
      vod_offset: offset,
      duration: 30,
      view_count: 1,
      created_at: new Date(Date.now() - 60_000).toISOString(),
      title: `${broadcaster} moment`,
    });
    const twitch = {
      configured: true,
      resolveGame: async (name) => ({ id: name === 'Fortnite' ? '33214' : '1234', name }),
      liveStreams: async (gameId) => {
        asked.streams.push(gameId);
        return gameId === '33214'
          ? [{ user_id: 'clix', user_login: 'clix', user_name: 'Clix', viewer_count: 9, game_name: 'Fortnite' }]
          : [{ user_id: 'lirik', user_login: 'lirik', user_name: 'LIRIK', viewer_count: 5, game_name: 'Grand Theft Auto VI' }];
      },
      recentClips: async ({ gameId }) => {
        asked.clips.push(gameId);
        return gameId === '33214'
          ? { clips: [clip('f1', '33214', 'clix', 500)], truncated: false }
          : { clips: [clip('g1', '1234', 'lirik', 900)], truncated: false };
      },
      clipsByIds: async () => [],
      archiveVideo: async () => null,
    };
    const feed = new Feed({ log: () => {}, chat: null, store: null, findArchive: null });
    feed.twitch = twitch;
    open = feed;

    await feed.start();

    assert.deepEqual(asked.streams.sort(), ['1234', '33214']);
    assert.deepEqual(asked.clips.sort(), ['1234', '33214']);
    assert.equal(feed.game.name, 'Grand Theft Auto VI + Fortnite');
    const byChannel = Object.fromEntries(feed.moments.map((m) => [m.broadcaster, m.game]));
    assert.deepEqual(byChannel, { clix: 'Fortnite', lirik: 'Grand Theft Auto VI' });
  });
});

describe('when a recording lookup fails', () => {
  it('keeps the recording already known, and tries again soon', async () => {
    const now = Date.now();
    let fail = false;
    const { feed } = chatOnlyFeed([candidate('caseoh_', { at: now })], ['caseoh_'], async () => {
      if (fail) throw new Error('downloader exited with code 3221225794');
      return { vodId: '77', startedAt: now - 3600_000, chapters: [{ title: 'Fortnite', start: 0 }] };
    });
    open = feed;
    await feed.start();
    const channel = feed.channels.get('caseoh_');
    assert.equal(channel.vodId, '77');

    // Five minutes on, the re-check fails.
    fail = true;
    channel.archiveCheckedAt = now - 6 * 60_000;
    await feed.pollChat();

    // One failed lookup used to wipe this, leaving every moment on the
    // channel without a game, so all of them were skipped.
    assert.equal(channel.vodId, '77');
    assert.deepEqual(channel.chapters, [{ title: 'Fortnite', start: 0 }]);
    assert.equal(feed.moments[0].game, 'Fortnite');
    assert.equal(channel.lookupFailures, 1);
    assert.ok(channel.retryAt - Date.now() <= 30_000 && channel.retryAt - Date.now() > 25_000);
    assert.equal(feed.lookups.consecutive, 1);
    assert.match(feed.lookups.lastError, /3221225794/);
  });

  it('counts the failures in a row, and clears them once a lookup answers', async () => {
    let fail = true;
    const { feed } = chatOnlyFeed([candidate('caseoh_')], ['caseoh_'], async () => {
      if (fail) throw new Error('ETIMEDOUT');
      return null;
    });
    open = feed;
    await feed.start();
    const channel = feed.channels.get('caseoh_');
    channel.retryAt = 0;
    await feed.pollChat();
    assert.equal(feed.lookups.consecutive, 2);
    assert.equal(channel.lookupFailures, 2);

    fail = false;
    channel.retryAt = 0;
    await feed.pollChat();
    assert.equal(feed.lookups.consecutive, 0);
    assert.equal(channel.lookupFailures, 0);
    assert.equal(channel.retryAt, null);
  });

  it('notes a lookup that can never succeed once, instead of retrying it', async () => {
    let asked = 0;
    const { feed } = chatOnlyFeed([candidate('zerator')], ['zerator'], async () => {
      asked += 1;
      throw new Error('You must be logged into an account that has access to this subscriber-only content');
    });
    open = feed;
    await feed.start();
    await feed.pollChat();
    await feed.pollChat();
    assert.equal(asked, 1);
    const channel = feed.channels.get('zerator');
    assert.equal(channel.vodId, null);
    assert.equal(channel.retryAt, null);
    assert.match(channel.lookupError, /subscriber-only/);
    // An answer, not a failure: it does not count against lookup health.
    assert.equal(feed.lookups.consecutive, 0);
  });
});

describe('lookup timing', () => {
  it('backs off from 30s to 5 minutes, and no further', async () => {
    const { retryDelay } = await import('./feed.js');
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelay), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  it('a retry comes before the ordinary re-check', async () => {
    const { lookupDueAt } = await import('./feed.js');
    assert.equal(lookupDueAt({}), 0);
    assert.equal(lookupDueAt({ archiveCheckedAt: 1000, vodId: '7' }), 1000 + 5 * 60_000);
    assert.equal(lookupDueAt({ archiveCheckedAt: 1000, vodId: null }), 1000 + 10 * 60_000);
    assert.equal(lookupDueAt({ archiveCheckedAt: 1000, vodId: '7', retryAt: 5000 }), 5000);
  });
});
