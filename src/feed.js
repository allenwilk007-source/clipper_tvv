import { config } from './config.js';
import { ChatWatcher } from './chat.js';
import { clusterClips, scoreMoments } from './moments.js';
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

    this.game = null;
    this.moments = [];
    this.streams = new Map();
    this.previousSaturation = new Map();

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
    const scored = scoreMoments(clustered, {
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

    if (truncated) {
      this.log(
        `clip window truncated at ${config.clipMaxPages} pages — raise CLIP_MAX_PAGES or shorten CLIP_WINDOW_MINUTES`,
      );
    }
    this.log(`${clips.length} clips -> ${scored.length} moments`);
    return scored;
  }

  async tick(kind) {
    try {
      if (kind === 'streams') await this.pollStreams();
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
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.chat?.stop();
    this.started = false;
  }

  snapshot() {
    const counts = { fresh: 0, warm: 0, flooded: 0 };
    for (const moment of this.moments) counts[moment.state] += 1;

    return {
      game: this.game ? { id: this.game.id, name: this.game.name } : null,
      moments: this.moments,
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
        lastError: this.lastError,
      },
    };
  }
}
