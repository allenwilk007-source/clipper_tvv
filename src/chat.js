// Chat: the only signal that fires before a clip exists.
//
// Clip creation tells you a moment happened, but only after someone had time
// to act on it — which means a clip-only feed can never be first, structurally.
// `saturation = 1` already means somebody beat you. Chat is the one input in
// this building that can fire at saturation ZERO, so it is no longer only a
// tiebreaker: a spike here nominates a moment of its own (see `candidates()`),
// which the feed carries as unconfirmed until clips show up to confirm it.
//
// Scoring is a robust z-score against each channel's OWN recent pace:
// (count - median) / MAD. Median and MAD both ignore the spikes themselves, so
// a channel that pops repeatedly doesn't quietly raise its own bar. Because the
// score is in units of that channel's volatility, one threshold works for a
// 200k-viewer channel and a 2k-viewer one at the same time.
//
// That machinery is now run per reaction CLASS as well as on raw volume — see
// reactions.js for why the kind of reaction matters as much as the size.

import { config } from './config.js';
import {
  CLASS_NAMES,
  addMessage,
  createBucket,
  reactionScore,
  summarizeBucket,
} from './reactions.js';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
// :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :message
const PRIVMSG = /^:([^!]+)![^ ]* PRIVMSG #([^ ]+) :(.*)$/;

const CHANNELS_PER_SOCKET = 18;
const JOINS_PER_WAVE = 15;
const JOIN_WAVE_MS = 10_000;
const BUCKET_MS = 10_000;
const HISTORY_BUCKETS = 30; // 30 x 10s = 5 minutes of context
const WARMUP_BUCKETS = 6;
const MAD_SCALE = 0.6745; // makes MAD comparable to a standard deviation
// Absolute minimum per bucket, to kill dead-chat noise.
//
// This was 20 (2 messages/second), and live chat showed what that costs:
// summit1g jumped to five times its own baseline — z=5.85, an unmistakable
// reaction — and was thrown away for having "only" 16 messages in the bucket.
// Meanwhile xQc, the one channel big enough to clear the bar, never spiked at
// all, because a chat doing 11 messages a second has a baseline far too stable
// to move.
//
// That is precisely backwards for this product. The whole thesis is that
// unsaturated moments live on channels that are NOT enormous, so a threshold
// that only admits the enormous ones can only ever surface moments that are
// already flooded. The floor is now low enough for a mid-size channel to
// nominate a moment, and tunable, because the right value is a question for
// `npm run eval` rather than for taste.
const FLOOR_MESSAGES = config.chatFloorMessages;
const MIN_RISE = config.chatMinRise; // must also be this multiple of the median
const SPIKE_Z = config.chatSpikeZ;
const CALLOUT_MINIMUM = 2; // "clip that" said at least twice

// Spikes on this many channels in the same bucket mean the game did something,
// not the streamer. High volume, near-zero uniqueness, flooded within minutes.
const SHARED_CHANNELS = 3;

/**
 * The spike gates, published so a caller can report what it is measuring
 * against instead of restating the numbers and drifting out of sync.
 *
 * The volume path ANDs three conditions, which means a run that finds nothing
 * is ambiguous unless you can see which one held it back.
 */
export const THRESHOLDS = {
  floorMessages: FLOOR_MESSAGES,
  minRise: MIN_RISE,
  spikeZ: SPIKE_Z,
  calloutMinimum: CALLOUT_MINIMUM,
  sharedChannels: SHARED_CHANNELS,
};

// A second spike this soon after the last one is the same moment still going.
const CANDIDATE_GAP_MS = 40_000;
const CANDIDATE_TTL_MS = 30 * 60_000;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One counted thing, scored against its own past. Volume is one of these;
 * so is every reaction class, the unique-chatter count and the copypasta
 * ratio. Each gets its own baseline, because a chat that says "LUL" constantly
 * should not get credit for saying it again.
 */
export class Series {
  constructor() {
    this.history = [];
    this.z = 0;
    this.value = 0;
    this.baseline = 0;
  }

  push(value) {
    const warm = this.history.length >= WARMUP_BUCKETS;
    const baseline = warm ? median(this.history) : 0;
    const mad = warm ? median(this.history.map((b) => Math.abs(b - baseline))) : 0;

    let z = 0;
    if (warm && mad > 0) {
      z = (MAD_SCALE * (value - baseline)) / mad;
    } else if (warm && value > Math.max(baseline * 2, 1)) {
      // A perfectly flat series has MAD 0, which would divide by zero. Any
      // real jump out of flat is notable, so give it a fixed score.
      z = 3;
    }

    this.history.push(value);
    if (this.history.length > HISTORY_BUCKETS) this.history.shift();

    this.value = value;
    this.baseline = baseline;
    this.z = z;
    return z;
  }
}

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

class ChannelCounter {
  constructor(login) {
    this.login = login;

    this.volume = new Series();
    this.chatters = new Series();
    this.copypasta = new Series();
    this.classes = new Map(CLASS_NAMES.map((name) => [name, new Series()]));

    this.resetBucket();

    this.reaction = 0;
    this.spiking = false;
    this.shared = false;
  }

  resetBucket() {
    this.bucket = createBucket();
  }

  bump(nick, message) {
    addMessage(this.bucket, nick, message);
  }

  /** Close the bucket, score every series against its history, fold it in. */
  roll() {
    const { messages: count, chatters, copypasta: pasta, classes: classCounts } =
      summarizeBucket(this.bucket);
    // The bucket, and every message in it, is dropped here.
    this.resetBucket();

    const volumeZ = this.volume.push(count);
    const chattersZ = this.chatters.push(chatters);
    // Scaled up because the ratio lives in 0..1 and MAD on raw fractions is
    // tiny enough to make the z-score jumpy.
    const pastaZ = this.copypasta.push(pasta * 100);

    const parts = { volume: volumeZ, chatters: chattersZ, copypasta: pastaZ };
    for (const [name, series] of this.classes) {
      parts[name] = series.push(classCounts.get(name));
    }

    this.reaction = reactionScore(parts);
    this.parts = parts;
    this.classCountsLast = classCounts;
    this.chattersLast = chatters;
    this.copypastaLast = pasta;

    const baseline = this.volume.baseline;
    const hasFloor = count >= FLOOR_MESSAGES;
    const volumeSpike = hasFloor && count >= baseline * MIN_RISE && volumeZ >= SPIKE_Z;

    // A small chat saying "clip that" three times is a real nomination even
    // though its message rate barely moved. This is the whole reason the class
    // breakdown exists, so it gets its own path to spiking.
    const callout = classCounts.get('clipit') >= CALLOUT_MINIMUM && parts.clipit >= SPIKE_Z;

    this.spiking = volumeSpike || callout;
    return this.reaction;
  }

  snapshot() {
    const classes = {};
    for (const name of CLASS_NAMES) {
      classes[name] = {
        count: this.classCountsLast?.get(name) ?? 0,
        z: round(this.parts?.[name] ?? 0),
      };
    }
    return {
      // Kept as the raw volume z-score under its original name, because that
      // is what it has always meant to callers.
      z: round(this.volume.z),
      // The bucket's raw count. Exposed so the floor and the rise-over-median
      // gates can be checked from outside rather than inferred from the rate.
      messages: this.volume.value ?? 0,
      reaction: round(this.reaction),
      messagesPerSecond: round(this.volume.value / (BUCKET_MS / 1000), 1),
      baseline: Math.round(this.volume.baseline),
      spiking: this.spiking,
      shared: this.shared,
      chatters: this.chattersLast ?? 0,
      chattersZ: round(this.parts?.chatters ?? 0),
      copypasta: round(this.copypastaLast ?? 0),
      classes,
    };
  }
}

/** One anonymous IRC connection carrying many channels. */
class Shard {
  constructor(index, { onMessage, log }) {
    this.index = index;
    this.onMessage = onMessage;
    this.log = log;
    this.channels = new Set();
    this.joinQueue = [];
    this.ws = null;
    this.ready = false;
    this.stopped = false;
  }

  get capacity() {
    return CHANNELS_PER_SOCKET - this.channels.size;
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(IRC_URL);
    } catch (err) {
      this.log(`shard ${this.index} could not open: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.ready = false;

    ws.addEventListener('open', () => {
      // justinfan* is Twitch's anonymous read-only nick. No account, no token.
      const nick = `justinfan${Math.floor(Math.random() * 90000) + 10000}`;
      ws.send(`NICK ${nick}`);
      this.ready = true;
      this.joinQueue = [...this.channels]; // rejoin everything after a drop
      this.drain();
    });

    ws.addEventListener('message', (event) => this.handle(String(event.data)));

    ws.addEventListener('close', () => {
      this.ready = false;
      this.scheduleReconnect();
    });

    // Without a listener a socket error becomes an unhandled rejection.
    ws.addEventListener('error', () => {});
  }

  scheduleReconnect() {
    if (this.stopped) return;
    setTimeout(() => this.connect(), 3000 + Math.random() * 2000);
  }

  handle(raw) {
    for (const line of raw.split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) {
        this.send('PONG :tmi.twitch.tv');
        continue;
      }
      const match = PRIVMSG.exec(line);
      if (match) this.onMessage(match[2], match[1], match[3]);
    }
  }

  send(payload) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(payload);
  }

  add(login) {
    if (this.channels.has(login)) return;
    this.channels.add(login);
    if (this.ready) this.joinQueue.push(login);
  }

  remove(login) {
    if (!this.channels.delete(login)) return;
    this.joinQueue = this.joinQueue.filter((c) => c !== login);
    this.send(`PART #${login}`);
  }

  /** Twitch allows ~20 JOINs per 10s per connection, so joins are paced. */
  drain() {
    if (!this.ready) return;
    const wave = this.joinQueue.splice(0, JOINS_PER_WAVE);
    for (const login of wave) this.send(`JOIN #${login}`);
  }

  stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

export class ChatWatcher {
  /**
   * `connect: false` tracks channels and scores them without opening any
   * sockets, so the scoring can be exercised offline. Without it a unit test
   * would open real IRC connections to Twitch, which is slow, flaky, and
   * testing Twitch rather than this file.
   */
  constructor({ log = () => {}, connect = true } = {}) {
    this.log = log;
    this.connecting = connect;
    this.counters = new Map();
    this.shards = [];
    this.timers = [];
    this.running = false;
    this.candidatesByLogin = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timers.push(setInterval(() => this.rollAll(), BUCKET_MS));
    this.timers.push(
      setInterval(() => {
        for (const shard of this.shards) shard.drain();
      }, JOIN_WAVE_MS),
    );
  }

  stop() {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const shard of this.shards) shard.stop();
    this.shards = [];
    this.counters.clear();
    this.candidatesByLogin.clear();
  }

  /**
   * Close every bucket, then decide what the spikes mean together.
   *
   * Simultaneity is the point of doing this in one pass: three channels
   * popping in the same ten seconds is the game doing something, which is a
   * different product entirely from one streamer doing something. The first
   * will be flooded within minutes; the second is what this feed is for.
   */
  rollAll(now = Date.now()) {
    const spiking = [];
    for (const counter of this.counters.values()) {
      counter.roll();
      if (counter.spiking) spiking.push(counter);
    }

    const shared = spiking.length >= SHARED_CHANNELS;
    for (const counter of this.counters.values()) counter.shared = counter.spiking && shared;

    for (const counter of spiking) this.noteCandidate(counter, now);
    this.expireCandidates(now);
    return spiking.length;
  }

  /** A spike becomes a candidate, or extends the one already running. */
  noteCandidate(counter, now) {
    const snapshot = counter.snapshot();
    const open = this.candidatesByLogin.get(counter.login);

    if (open && now - open.lastAt <= CANDIDATE_GAP_MS) {
      open.lastAt = now;
      open.buckets += 1;
      open.shared = open.shared || snapshot.shared;
      if (snapshot.reaction > open.reaction) {
        open.reaction = snapshot.reaction;
        open.peakAt = now;
        open.chat = snapshot;
      }
      return;
    }

    this.candidatesByLogin.set(counter.login, {
      login: counter.login,
      startedAt: now,
      peakAt: now,
      lastAt: now,
      buckets: 1,
      reaction: snapshot.reaction,
      shared: snapshot.shared,
      chat: snapshot,
    });
  }

  expireCandidates(now) {
    for (const [login, candidate] of this.candidatesByLogin) {
      if (now - candidate.lastAt > CANDIDATE_TTL_MS) this.candidatesByLogin.delete(login);
    }
  }

  /**
   * Chat spikes with no clip attached yet. The feed turns these into
   * unconfirmed moments — the only way anything here is ever first.
   */
  candidates({ now = Date.now(), maxAgeMs = CANDIDATE_TTL_MS } = {}) {
    const out = [];
    for (const candidate of this.candidatesByLogin.values()) {
      if (now - candidate.peakAt > maxAgeMs) continue;
      out.push({ ...candidate });
    }
    return out.sort((a, b) => b.reaction - a.reaction);
  }

  record(login, nick, message) {
    const counter = this.counters.get(login);
    if (counter) counter.bump(nick, message);
  }

  /** Reconcile the watch list: join what's new, part what dropped off. */
  setChannels(logins) {
    const target = new Set(logins.map((l) => l.toLowerCase()));

    for (const login of [...this.counters.keys()]) {
      if (target.has(login)) continue;
      this.counters.delete(login);
      for (const shard of this.shards) shard.remove(login);
    }

    for (const login of target) {
      if (this.counters.has(login)) continue;
      this.counters.set(login, new ChannelCounter(login));
      this.assign(login);
    }

    if (this.running) {
      for (const shard of this.shards) shard.drain();
    }
  }

  assign(login) {
    if (!this.connecting) return;
    let shard = this.shards.find((s) => s.capacity > 0);
    if (!shard) {
      shard = new Shard(this.shards.length, {
        onMessage: (channel, nick, message) => this.record(channel, nick, message),
        log: this.log,
      });
      this.shards.push(shard);
      shard.connect();
    }
    shard.add(login);
  }

  /** login -> snapshot */
  spikes() {
    const out = new Map();
    for (const [login, counter] of this.counters) out.set(login, counter.snapshot());
    return out;
  }

  status() {
    const connected = this.shards.filter((s) => s.ready).length;
    return {
      enabled: true,
      channels: this.counters.size,
      shards: this.shards.length,
      connectedShards: connected,
      spiking: [...this.counters.values()].filter((c) => c.spiking).length,
      candidates: this.candidatesByLogin.size,
    };
  }
}
