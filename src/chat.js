// Chat velocity: the lead signal.
//
// Clip creation tells you a moment happened, but only after people have had
// time to act on it. Chat moves first. It is a far noisier signal — typing is
// free — so it is used here to rank moments earlier, never to declare one on
// its own.
//
// Scoring is a robust z-score against each channel's OWN recent pace:
// (count - median) / MAD. Median and MAD both ignore the spikes themselves, so
// a channel that pops repeatedly doesn't quietly raise its own bar. Because the
// score is in units of that channel's volatility, one threshold works for a
// 200k-viewer channel and a 2k-viewer one at the same time.

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const PRIVMSG = /^:[^ ]+ PRIVMSG #([^ ]+) :/;

const CHANNELS_PER_SOCKET = 18;
const JOINS_PER_WAVE = 15;
const JOIN_WAVE_MS = 10_000;
const BUCKET_MS = 10_000;
const HISTORY_BUCKETS = 30; // 30 x 10s = 5 minutes of context
const WARMUP_BUCKETS = 6;
const MAD_SCALE = 0.6745; // makes MAD comparable to a standard deviation
const FLOOR_MESSAGES = 20; // absolute minimum, kills dead-chat noise
const MIN_RISE = 1.5; // must also be this multiple of the median

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

class ChannelCounter {
  constructor(login) {
    this.login = login;
    this.current = 0;
    this.history = [];
    this.z = 0;
    this.rate = 0;
    this.baseline = 0;
    this.spiking = false;
  }

  bump() {
    this.current += 1;
  }

  /** Close the bucket, score it against history, then fold it in. */
  roll() {
    const count = this.current;
    this.current = 0;

    const warm = this.history.length >= WARMUP_BUCKETS;
    const baseline = warm ? median(this.history) : 0;
    const mad = warm ? median(this.history.map((b) => Math.abs(b - baseline))) : 0;

    let z = 0;
    if (warm && mad > 0) {
      z = (MAD_SCALE * (count - baseline)) / mad;
    } else if (warm && count > Math.max(baseline * 2, FLOOR_MESSAGES)) {
      // A perfectly flat chat has MAD 0, which would divide by zero. Any real
      // jump out of a flat baseline is notable, so give it a fixed score.
      z = 3;
    }

    this.history.push(count);
    if (this.history.length > HISTORY_BUCKETS) this.history.shift();

    this.z = z;
    this.baseline = baseline;
    this.rate = count / (BUCKET_MS / 1000);
    this.spiking = count >= FLOOR_MESSAGES && count >= baseline * MIN_RISE && z >= 3;
    return this.z;
  }

  snapshot() {
    return {
      z: Math.round(this.z * 100) / 100,
      messagesPerSecond: Math.round(this.rate * 10) / 10,
      baseline: Math.round(this.baseline),
      spiking: this.spiking,
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
      if (match) this.onMessage(match[1]);
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
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.counters = new Map();
    this.shards = [];
    this.timers = [];
    this.running = false;
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
  }

  rollAll() {
    for (const counter of this.counters.values()) counter.roll();
  }

  record(login) {
    const counter = this.counters.get(login);
    if (counter) counter.bump();
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
    let shard = this.shards.find((s) => s.capacity > 0);
    if (!shard) {
      shard = new Shard(this.shards.length, {
        onMessage: (channel) => this.record(channel),
        log: this.log,
      });
      this.shards.push(shard);
      shard.connect();
    }
    shard.add(login);
  }

  /** login -> { z, messagesPerSecond, baseline, spiking } */
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
    };
  }
}
