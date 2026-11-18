// Autocollect: the feed decides, this cuts.
//
// After every poll the ranked moments go through the rules below, and the ones
// that pass are cut, captioned and rendered into a folder of finished shorts
// with no one clicking anything. Each rule is here because of a specific way
// this goes wrong without it:
//
//   * a VOD and a position in it — without both there is nothing to cut
//   * early or fresh only — a flooded moment is already on everyone's feed
//   * settled — the end of the cut must be SETTLE seconds in the past, or the
//     archive may not hold it yet. Measured on a live, still-recording
//     archive: a cut ending 15s behind the live edge came back full length
//     with moving footage. The default of 30 is double that.
//   * not stale — after MAX_AGE someone else has posted it
//   * not already cut — by id, and ALSO by position on the same VOD, because
//     a chat spike that clips later confirm can come back under a new id
//   * rate caps, overall and per channel — every cut is a re-encode, and a
//     folder of one streamer is not a feed anybody wants
//
// The caps are the real control. AUTOCLIP_MIN_SCORE exists but defaults to 0
// because nothing has calibrated the opportunity scale yet; that is what
// `npm run eval` is for, and until it has spoken a threshold would be a guess
// presented as a setting.

import { join, relative, resolve } from 'node:path';

import { run, splitCommand } from './clip.js';
import { config, root } from './config.js';
import { enqueueClip } from './clipjobs.js';
import { captionFor } from './shortform.js';

const HOUR = 3_600_000;

const num = (value, fallback) => {
  if (value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function autoclipConfig(source = process.env) {
  return {
    minScore: num(source.AUTOCLIP_MIN_SCORE, 0),
    states: String(source.AUTOCLIP_STATES ?? 'early,fresh')
      .split(',')
      .map((state) => state.trim())
      .filter(Boolean),
    perHour: num(source.AUTOCLIP_PER_HOUR, 6),
    perChannelPerHour: num(source.AUTOCLIP_PER_CHANNEL_PER_HOUR, 2),
    maxPerPoll: num(source.AUTOCLIP_MAX_PER_POLL, 2),
    settleSeconds: num(source.AUTOCLIP_SETTLE_SECONDS, 30),
    maxAgeMinutes: num(source.AUTOCLIP_MAX_AGE_MINUTES, 20),
    dedupeSeconds: num(source.AUTOCLIP_DEDUPE_SECONDS, 45),
    pre: config.clipPre,
    post: config.clipPost,
    dir: resolve(root, source.AUTOCLIP_DIR || join(config.clipDir, 'ready')),
    workDir: join(config.clipDir, '.work'),
  };
}

/** The VOD position a cut is built around: where people reacted. */
export function cutOffset(moment) {
  const value = moment?.reactionOffsetSeconds ?? moment?.offsetSeconds;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export const toCut = (moment, at) => ({
  momentId: moment.id,
  vodId: moment.vodId,
  offsetSeconds: cutOffset(moment),
  broadcaster: moment.broadcaster,
  at,
});

const vodKey = (id) => String(id || '').replace(/^v/, '');
const who = (name) => String(name || '').toLowerCase();

/**
 * Which moments to cut this poll. Pure, so every rule above is tested.
 *
 * `cuts` is what has already been cut: [{momentId, vodId, offsetSeconds,
 * broadcaster, at}]. Moments are considered best first, so when a cap bites
 * it is the weaker moments that lose out.
 */
export function selectForAutoclip(moments, { now = Date.now(), cuts = [], cfg = autoclipConfig() } = {}) {
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };
  const picks = [];
  const recent = cuts.filter((cut) => now - cut.at < HOUR);
  const ids = new Set(cuts.map((cut) => cut.momentId));

  const ranked = [...moments].sort((a, b) => (b.opportunity ?? 0) - (a.opportunity ?? 0));

  for (const moment of ranked) {
    const offset = cutOffset(moment);
    const reactedAt = Date.parse(moment.firstClipAt);
    const taken = [...cuts, ...picks.map((pick) => toCut(pick, now))];
    const takenRecently = [...recent, ...picks.map((pick) => toCut(pick, now))];

    if (!moment.vodId) skip('no-vod');
    else if (offset == null) skip('no-offset');
    else if (!cfg.states.includes(moment.state)) skip('state');
    else if ((moment.opportunity ?? 0) < cfg.minScore) skip('score');
    else if (!Number.isFinite(reactedAt)) skip('no-time');
    else if (now - reactedAt > cfg.maxAgeMinutes * 60_000) skip('stale');
    else if (now < reactedAt + (cfg.post + cfg.settleSeconds) * 1000) skip('settling');
    else if (
      ids.has(moment.id) ||
      taken.some(
        (cut) =>
          vodKey(cut.vodId) === vodKey(moment.vodId) &&
          Math.abs(cut.offsetSeconds - offset) <= cfg.dedupeSeconds,
      )
    ) {
      skip('already-cut');
    } else if (picks.length >= cfg.maxPerPoll) skip('poll-limit');
    else if (takenRecently.length >= cfg.perHour) skip('hourly-limit');
    else if (
      takenRecently.filter((cut) => who(cut.broadcaster) === who(moment.broadcaster)).length >=
      cfg.perChannelPerHour
    ) {
      skip('channel-limit');
    } else picks.push(moment);
  }

  return { picks, skipped };
}

// ---------------------------------------------------------------------------
// Placing a chat moment on its VOD without credentials
// ---------------------------------------------------------------------------
//
// With no Twitch app the feed cannot look up a channel's VOD, so a chat moment
// arrives with no vodId and no offset and would be passed over as 'no-vod'
// for ever — autocollect would run all day and make nothing. yt-dlp finds
// both with no credentials, in two calls per broadcast:
//
//   1. the channel's newest archive id
//   2. that archive's live_status and timestamp
//
// The newest archive is only trusted if it is still RECORDING: a streamer
// with archiving off has an old VOD at the top of the list, and cutting at
// "today's offset" into yesterday's broadcast is a random clip, not this
// moment. Measured on a live channel: the current archive reported is_live,
// its timestamp was 5s after the stream went live (the VOD's own zero point,
// which is what offsets are measured from), and its duration matched
// wall-clock time to within 3s. A finished archive reported was_live.

const LOGIN = /^[a-z0-9_]{1,25}$/;

/** The channel login of a chat moment, from its id (`chat:<login>:<ts>`). */
export function loginOf(moment) {
  const login = /^chat:([^:]+):/.exec(String(moment?.id || ''))?.[1]?.toLowerCase();
  return login && LOGIN.test(login) ? login : null;
}

/** An archive is usable only while it is recording the broadcast in progress. */
export function liveArchiveFrom({ id, timestamp, liveStatus }) {
  const vodId = String(id || '').trim();
  if (liveStatus !== 'is_live' || !/^v?\d+$/.test(vodId)) return null;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return { vodId, startedAt: timestamp * 1000 };
}

/** A copy of a chat moment with its position in the recording filled in. */
export function placeOnVod(moment, archive) {
  const peak = Date.parse(moment?.firstClipAt);
  if (!archive || !Number.isFinite(peak) || peak < archive.startedAt) return null;
  const offset = Math.round((peak - archive.startedAt) / 1000);
  return {
    ...moment,
    vodId: archive.vodId,
    offsetSeconds: offset,
    reactionOffsetSeconds: offset,
    offsetEstimated: true,
  };
}

export async function findLiveArchive(login) {
  if (!LOGIN.test(login)) return null;
  const { file, prefix } = splitCommand(config.ytdlpCmd);
  const first = async (args) =>
    (await run(file, [...prefix, ...args], { cwd: config.root, label: 'yt-dlp' })).stdout.trim().split(/\r?\n/)[0] || '';

  const id = await first([
    '--flat-playlist',
    '--playlist-end',
    '1',
    '--print',
    '%(id)s',
    `https://www.twitch.tv/${login}/videos?filter=archives&sort=time`,
  ]);
  if (!/^v?\d+$/.test(id)) return null;

  const [timestamp, liveStatus] = (
    await first(['--print', '%(timestamp)s|%(live_status)s', `https://www.twitch.tv/videos/${id.replace(/^v/, '')}`])
  ).split('|');
  return liveArchiveFrom({ id, timestamp: Number(timestamp), liveStatus });
}

// What the render needs from a moment, copied so a later poll replacing the
// feed's state cannot change a caption halfway through a job.
const snapshotOf = (moment) => ({
  id: moment.id,
  source: moment.source,
  broadcaster: moment.broadcaster,
  vodId: moment.vodId,
  title: moment.title,
  chat: moment.chat ? { classes: moment.chat.classes } : null,
});

export class AutoClipper {
  constructor({
    store = null,
    log = () => {},
    enqueue = enqueueClip,
    now = () => Date.now(),
    cfg = autoclipConfig(),
    findArchive = findLiveArchive,
  } = {}) {
    this.store = store;
    this.log = log;
    this.enqueue = enqueue;
    this.now = now;
    this.cfg = cfg;
    this.findArchive = findArchive;
    // login -> {archive|null, checkedAt}. Looked up once per broadcast, not
    // once per poll: it is two subprocesses and a request to Twitch each time.
    this.archives = new Map();
    this.busy = false;
    this.cuts = [];
    this.totals = { queued: 0, done: 0, failed: 0 };
    this.lastSkipped = {};
  }

  /** Remember what earlier runs cut, so a restart does not cut it again. */
  load() {
    if (!this.store) {
      this.log('autocollect: no store, so a restart will forget what was already cut');
      return 0;
    }
    const interrupted = this.store.markInterruptedAutoclips();
    if (interrupted) this.log(`autocollect: ${interrupted} cut(s) were interrupted by the last shutdown`);
    this.cuts = this.store
      .recentAutoclips({ since: this.now() - 24 * HOUR })
      .map((row) => ({ ...row, at: Date.parse(row.createdAt) }));
    return this.cuts.length;
  }

  async onPoll(moments) {
    // A lookup can outlast the gap between polls. Skipping beats stacking:
    // the next poll carries the same moments.
    if (this.busy) return [];
    this.busy = true;
    try {
      const now = this.now();
      this.cuts = this.cuts.filter((cut) => now - cut.at < 24 * HOUR);
      const placed = await this.place(moments, now);
      const { picks, skipped } = selectForAutoclip(placed, { now, cuts: this.cuts, cfg: this.cfg });
      this.lastSkipped = skipped;
      return picks.map((moment) => this.cut(moment, now)).filter(Boolean);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Fill in the VOD position of chat moments the feed could not place. Only
   * moments that could otherwise be cut are looked up, at most three channels
   * a poll, so a burst of spikes cannot turn into a burst of requests.
   */
  async place(moments, now) {
    if (!this.findArchive) return moments;
    let lookups = 0;
    const placed = [];

    for (const moment of moments) {
      const login = loginOf(moment);
      const reactedAt = Date.parse(moment.firstClipAt);
      const worthIt =
        login &&
        (!moment.vodId || cutOffset(moment) == null) &&
        this.cfg.states.includes(moment.state) &&
        Number.isFinite(reactedAt) &&
        now - reactedAt <= this.cfg.maxAgeMinutes * 60_000;
      if (!worthIt) {
        placed.push(moment);
        continue;
      }

      let entry = this.archives.get(login);
      // A channel without a recording is asked again after ten minutes, in
      // case it starts one; one with a recording is re-checked every thirty,
      // in case the stream ended and a new one began.
      const ttl = entry?.archive ? 30 * 60_000 : 10 * 60_000;
      if ((!entry || now - entry.checkedAt > ttl) && lookups < 3) {
        lookups += 1;
        let archive = null;
        try {
          archive = await this.findArchive(login);
        } catch (err) {
          this.log(`autocollect: archive lookup for ${login} failed: ${String(err.message).split('\n')[0]}`);
        }
        entry = { archive, checkedAt: now };
        this.archives.set(login, entry);
        this.log(
          archive
            ? `autocollect: ${login} is recording to ${archive.vodId}`
            : `autocollect: ${login} has no archive recording right now, so its moments cannot be cut`,
        );
      }

      placed.push((entry?.archive && placeOnVod(moment, entry.archive)) || moment);
    }
    return placed;
  }

  cut(moment, now) {
    const caption = captionFor(moment);
    const cut = toCut(moment, now);

    // Claimed BEFORE it is queued. If the process dies mid-render the row
    // survives, and the next run knows not to cut this moment again.
    if (this.store) {
      try {
        if (!this.store.recordAutoclip({ ...cut, caption, at: new Date(now) })) return null;
      } catch (err) {
        this.log(`autocollect: could not record ${moment.id}: ${err.message}`);
      }
    }
    this.cuts.push(cut);
    this.totals.queued += 1;

    this.log(`autocollect: cutting ${moment.broadcaster} at ${cut.offsetSeconds}s — "${caption}"`);
    return this.enqueue({
      vodId: moment.vodId,
      offsetSeconds: cut.offsetSeconds,
      pre: this.cfg.pre,
      post: this.cfg.post,
      broadcaster: moment.broadcaster,
      momentId: moment.id,
      dir: this.cfg.workDir,
      short: { dir: this.cfg.dir, moment: snapshotOf(moment), auto: true },
      onSettled: (job) => this.settled(moment, job),
    });
  }

  settled(moment, job) {
    const ok = job.state === 'done';
    this.totals[ok ? 'done' : 'failed'] += 1;
    try {
      this.store?.finishAutoclip(moment.id, {
        status: ok ? 'done' : 'failed',
        path: job.shortPath,
        error: ok ? null : job.message,
      });
    } catch (err) {
      this.log(`autocollect: could not record the result for ${moment.id}: ${err.message}`);
    }
    this.log(
      ok
        ? `autocollect: ready -> ${relative(root, job.shortPath)}`
        : `autocollect: ${moment.broadcaster} failed — ${job.message}`,
    );
  }

  status() {
    const now = this.now();
    return {
      ...this.totals,
      lastHour: this.cuts.filter((cut) => now - cut.at < HOUR).length,
      dir: relative(root, this.cfg.dir),
      skipped: this.lastSkipped,
    };
  }
}
