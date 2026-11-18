import { config } from './config.js';
import { ChatWatcher } from './chat.js';
import {
  chatCandidateMoments,
  clusterClips,
  mergeChatCandidates,
  publicMoments,
  scoreMoments,
} from './moments.js';
import { HORIZONS, openStore } from './store.js';
import { Twitch } from './twitch.js';

const stamp = () => new Date().toISOString().slice(11, 19);
const defaultLog = (message) => console.log(`[${stamp()}] ${message}`);

/**
 * Owns the polling loops and the current feed state.
 *
 * Two loops at different rates: clips every 30s because that's the signal, and
 * live channels every couple of minutes because the top of a category barely
 * moves and each refresh costs several requests.
 */
export class Feed {
  constructor({ log = defaultLog } = {}) {
    this.log = log;
    this.twitch = new Twitch({ log });
    this.chat = config.chatEnabled ? new ChatWatcher({ log }) : null;

    this.store = config.storeEnabled ? openStore(config.storePath, { log }) : null;

    this.game = null;
    this.moments = [];
    this.streams = new Map();
    this.previousSaturation = new Map();
    // login -> {broadcasterId, vodId, startedAt, ...}. The VOD id is looked up
    // once per spiking channel and kept for the length of that broadcast.
    this.channels = new Map();
    this.outcomeCursor = 0;
    this.lastPruneAt = Date.now();

    this.lastClipPoll = null;
    this.lastStreamPoll = null;
    this.lastError = null;
    this.clipCount = 0;
    this.truncated = false;
    this.timers = [];
    this.started = false;
  }

  get configured() {
    return this.twitch.configured;
  }

  async init() {
    if (this.game) return this.game;
    this.game = config.gameId
      ? await this.twitch.gameById(config.gameId)
      : await this.twitch.resolveGame(config.gameName);
    this.log(`watching "${this.game.name}" (id ${this.game.id})`);
    return this.game;
  }

  async pollStreams() {
    const streams = await this.twitch.liveStreams(this.game.id, 100);
    this.streams = new Map(streams.map((s) => [s.user_id, s]));
    this.lastStreamPoll = new Date().toISOString();

    // Keep what a chat-only moment needs to describe itself, and keep any VOD
    // id already resolved for a channel that is still on the same broadcast.
    const next = new Map();
    for (const stream of streams) {
      const login = (stream.user_login || '').toLowerCase();
      if (!login) continue;
      const known = this.channels.get(login);
      next.set(login, {
        broadcasterId: stream.user_id,
        displayName: stream.user_name || login,
        startedAt: stream.started_at,
        title: stream.title,
        viewers: stream.viewer_count,
        vodId: known?.startedAt === stream.started_at ? known.vodId : null,
      });
    }
    this.channels = next;

    if (this.chat) {
      const logins = streams
        .slice(0, config.chatChannels)
        .map((s) => s.user_login)
        .filter(Boolean);
      this.chat.setChannels(logins);
    }

    this.log(`${streams.length} live channels`);
    return streams;
  }

  async pollClips() {
    const now = Date.now();
    const startedAt = new Date(now - config.clipWindowMinutes * 60_000).toISOString();

    const { clips, truncated } = await this.twitch.recentClips({
      gameId: this.game.id,
      startedAt,
      endedAt: new Date(now).toISOString(),
      maxPages: config.clipMaxPages,
    });

    const clustered = clusterClips(clips, { gapSeconds: config.clusterGapSeconds });

    // Chat spikes that nothing has been clipped from yet. These are the only
    // rows in the feed that can beat the crowd rather than merely keep up with
    // it, so they are folded in before scoring, not bolted on after.
    const candidates = this.chat ? this.chat.candidates({ now }) : [];
    await this.resolveVodIds(candidates);
    const withChat = mergeChatCandidates(
      clustered,
      chatCandidateMoments(candidates, { channels: this.channels }),
      { beforeSeconds: 60, afterSeconds: 180 },
    );

    const scored = scoreMoments(withChat, {
      now,
      chatSpikes: this.chat ? this.chat.spikes() : new Map(),
      streams: this.streams,
      previous: this.previousSaturation,
      leadInSeconds: config.leadInSeconds,
    });

    // Remember this round's sizes so the next one can report "+N just now",
    // dropping ids that have aged out so the map can't grow without bound.
    const nextPrevious = new Map();
    for (const moment of scored) nextPrevious.set(moment.id, moment.saturation);
    this.previousSaturation = nextPrevious;

    this.moments = scored;
    this.clipCount = clips.length;
    this.truncated = truncated;
    this.lastClipPoll = new Date(now).toISOString();
    this.lastError = null;

    if (this.store) {
      try {
        this.store.recordPoll({
          moments: scored,
          clipsById: new Map(clips.map((clip) => [clip.id, clip])),
          gameId: this.game?.id || null,
          at: new Date(now),
        });
      } catch (err) {
        // Bookkeeping must never take the feed down with it.
        this.log(`store write failed: ${err.message}`);
      }
    }

    if (truncated) {
      this.log(
        `clip window truncated at ${config.clipMaxPages} pages — raise CLIP_MAX_PAGES or shorten CLIP_WINDOW_MINUTES`,
      );
    }
    this.log(`${clips.length} clips -> ${scored.length} moments`);
    return scored;
  }

  /**
   * Give spiking channels a real VOD id so a chat-sourced moment can be
   * clipped like any other. Only the handful of channels with a live candidate
   * are looked up, and only once per broadcast, because this is a request per
   * channel and the rate limit is shared with the thing that matters.
   */
  async resolveVodIds(candidates) {
    for (const candidate of candidates) {
      const channel = this.channels.get(candidate.login);
      if (!channel || channel.vodId || channel.vodId === false) continue;
      if (!channel.broadcasterId) continue;
      try {
        const video = await this.twitch.archiveVideo(channel.broadcasterId);
        // false, not null: a channel that does not store broadcasts should be
        // asked once, not on every poll for the rest of the stream.
        channel.vodId = video?.id || false;
      } catch (err) {
        this.log(`vod lookup failed for ${candidate.login}: ${err.message}`);
        channel.vodId = false;
      }
    }
  }

  /**
   * What became of the moments we saw earlier.
   *
   * This is the whole reason the store exists: without an outcome, the ranking
   * is an opinion. One horizon per tick, round-robin, with a small batch —
   * nothing here is urgent and the live feed owns the rate limit.
   */
  async pollOutcomes() {
    if (!this.store) return 0;
    const horizon = HORIZONS[this.outcomeCursor % HORIZONS.length];
    this.outcomeCursor += 1;

    // Observations are the only table that grows without bound, so trim them
    // on a slow cycle rather than on a timer of their own.
    if (Date.now() - this.lastPruneAt > 6 * 3600_000) {
      this.lastPruneAt = Date.now();
      const pruned = this.store.pruneOlderThan();
      if (pruned.observations) this.log(`pruned ${pruned.observations} old observations`);
    }

    const due = this.store.dueForOutcome(horizon, { limit: config.outcomeBatch });
    let checked = 0;

    for (const momentId of due) {
      const clipIds = this.store.clipIdsFor(momentId);
      // A chat-only moment that never attracted a clip has nothing to re-poll,
      // and that emptiness is itself the outcome worth recording.
      const clips = clipIds.length ? await this.twitch.clipsByIds(clipIds) : [];
      this.store.recordOutcome({ momentId, horizon, clips });
      checked += 1;
    }

    if (checked) this.log(`outcomes: checked ${checked} moments at ${horizon.name}`);
    return checked;
  }

  async tick(kind) {
    try {
      if (kind === 'streams') await this.pollStreams();
      else if (kind === 'outcomes') await this.pollOutcomes();
      else await this.pollClips();
    } catch (err) {
      this.lastError = { at: new Date().toISOString(), message: err.message };
      this.log(`${kind} poll failed: ${err.message}`);
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;

    await this.init();
    this.chat?.start();

    await this.tick('streams');
    await this.tick('clips');

    this.timers.push(
      setInterval(() => this.tick('clips'), config.clipPollSeconds * 1000),
      setInterval(() => this.tick('streams'), config.streamPollSeconds * 1000),
    );
    if (this.store) {
      this.timers.push(
        setInterval(() => this.tick('outcomes'), config.outcomePollSeconds * 1000),
      );
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.chat?.stop();
    this.store?.close();
    this.started = false;
  }

  snapshot() {
    const counts = { early: 0, fresh: 0, warm: 0, flooded: 0 };
    for (const moment of this.moments) counts[moment.state] += 1;

    return {
      game: this.game ? { id: this.game.id, name: this.game.name } : null,
      moments: publicMoments(this.moments),
      meta: {
        counts,
        totalMoments: this.moments.length,
        clipsScanned: this.clipCount,
        truncated: this.truncated,
        windowMinutes: config.clipWindowMinutes,
        liveChannels: this.streams.size,
        lastClipPoll: this.lastClipPoll,
        lastStreamPoll: this.lastStreamPoll,
        pollSeconds: config.clipPollSeconds,
        chat: this.chat ? this.chat.status() : { enabled: false },
        store: this.store ? this.store.counts() : null,
        lastError: this.lastError,
      },
    };
  }
}
