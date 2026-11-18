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

function chatOnlyFeed(candidates, watchChannels = ['caseoh_', 'xqc']) {
  const chat = new FakeChat(candidates);
  const feed = new Feed({
    log: () => {},
    chat,
    store: null,
    watchChannels,
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
