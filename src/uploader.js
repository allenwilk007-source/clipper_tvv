// Automatic upload, YouTube first.
//
// The pipeline makes shorts far faster than any platform will take them:
// YouTube's default quota is about six uploads a day, against dozens of
// shorts. So this is a selector as much as a sender. Each day it posts the
// best few — highest engagement score first, only shorts above the keep line,
// never one flagged weak — evenly spaced, and leaves the rest.
//
// With nobody looking at a short before it goes out, the checks here are the
// last line: the video is checked again at post time, its game must be one
// this channel clips, and its tags are rebuilt from its own recorded game, so
// a mislabelled short cannot reach the channel. clips/rejected is never read.
//
// Three modes per platform, off by default:
//   off      nothing happens
//   dry-run  everything happens except the upload: the full choice, title and
//            description are logged (data/upload-dry-run.jsonl) at the real
//            cadence, so what a day looks like can be seen before it is real
//   on       uploads, through the owner's own app and sign-in
//
// Nothing here tries to look human. Spacing is even and documented, the API
// is the platform's own, and a refusal is an answer, not something to route
// around.

import { existsSync } from 'node:fs';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { config } from './config.js';
import { KEEP_SCORE } from './engagement.js';
import { recopy } from './recopy.js';
import { probe } from './shortform.js';
import { validateShort } from './validate.js';
import * as youtube from './youtube.js';

const num = (value, fallback) => (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : fallback);

export const uploadConfig = (env = process.env) => ({
  youtube: {
    // Each upload costs 1,600 of the default 10,000 daily units; 5 leaves
    // room for a failed attempt, which spends quota too.
    perDay: num(env.YOUTUBE_PER_DAY, 5),
    // Even spacing: 5 a day, three hours apart.
    spacingMinutes: num(env.YOUTUBE_SPACING_MINUTES, 180),
    privacy: ['public', 'unlisted', 'private'].includes(env.YOUTUBE_PRIVACY) ? env.YOUTUBE_PRIVACY : 'public',
  },
});

export const MODES = ['off', 'dry-run', 'on'];

/**
 * Midnight in Pacific time at or before `now`: when YouTube's quota resets.
 * A calendar day, not a rolling 24 hours.
 */
export function pacificDayStart(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const sinceMidnight = (Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return Math.floor(now / 1000) * 1000 - sinceMidnight;
}

// Statuses that spent quota: every real attempt, whatever came of it.
const SPENT = new Set(['uploading', 'done', 'failed', 'refused', 'uncertain', 'retry', 'dry-run']);

/**
 * What can be posted, best first. Only finished shorts still in the ready
 * folder with their post copy, above the keep line, not weak, in a game this
 * channel clips, and never posted (or tried) on this platform before.
 */
export async function candidates({ store, dir, platform, games = config.games, keep = KEEP_SCORE, limit = 500 }) {
  const done = store.uploadedFiles(platform);
  const wanted = new Set(games.map((g) => g.toLowerCase()));
  const out = [];
  for (const row of store.listAutoclips({ limit })) {
    if (row.status !== 'done' || !row.path) continue;
    const file = basename(row.path);
    if (done.has(file) || !/\.mp4$/.test(file)) continue;
    if (!Number.isFinite(row.score) || row.score < keep || row.weak === 1) continue;
    const video = join(dir, file);
    const jsonPath = video.replace(/\.mp4$/, '.json');
    if (!existsSync(video) || !existsSync(jsonPath)) continue;
    let saved;
    try {
      saved = JSON.parse(await readFile(jsonPath, 'utf8'));
    } catch {
      continue;
    }
    // The game this short recorded about itself must be one this channel is for.
    if (!saved.game || !wanted.has(String(saved.game).toLowerCase())) continue;
    out.push({ file, video, saved, score: row.score, finishedAt: row.finishedAt, momentId: row.momentId });
  }
  return out.sort((a, b) => b.score - a.score || String(b.finishedAt).localeCompare(String(a.finishedAt)));
}

/**
 * The YouTube post for a short, rebuilt now from its own record rather than
 * trusted from a file written hours ago. Throws if the tags name a game other
 * than the one the short was recorded in.
 */
export function youtubePost(candidate, { avoid = [] } = {}) {
  // `avoid`: titles already posted, so a day is not one sentence five times.
  const parts = recopy({ file: candidate.file, saved: candidate.saved, avoid });
  const [title, ...rest] = parts.platforms.youtube.split('\n');
  const description = rest.join('\n').trim();
  const text = `${title}\n${description}`.toLowerCase();
  const game = String(candidate.saved.game).toLowerCase();
  const otherGame = (game.includes('fortnite') && /#gta/.test(text)) || (game.includes('grand theft auto') && /#fortnite/.test(text));
  if (otherGame) throw new Error(`tags name another game than ${candidate.saved.game}`);
  const tags = [...new Set(text.match(/#[a-z0-9_]+/g) || [])].map((t) => t.slice(1)).slice(0, 15);
  return { title, description, tags };
}

export class Uploader {
  constructor({
    store,
    dir,
    log = () => {},
    cfg = uploadConfig(),
    env = process.env,
    settingsPath = join(config.root, 'data', 'uploads.json'),
    dryRunLog = join(config.root, 'data', 'upload-dry-run.jsonl'),
    now = () => Date.now(),
    yt = youtube,
    check = async (video) => {
      const { duration } = await probe(video);
      return validateShort(video, { expectSeconds: duration });
    },
  } = {}) {
    Object.assign(this, { store, dir, log, cfg, settingsPath, dryRunLog, now, yt, check });
    this.keys = yt.youtubeKeys(env);
    this.settings = { youtube: { mode: 'off' } };
    this.state = { youtube: { blockedUntil: 0, blockedReason: null, lastError: null, connected: false } };
    this.busy = false;
    this.timer = null;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.settingsPath, 'utf8'));
      if (MODES.includes(saved?.youtube?.mode)) this.settings.youtube.mode = saved.youtube.mode;
    } catch {
      /* first run: off */
    }
    this.state.youtube.connected = Boolean((await this.yt.loadToken())?.refreshToken);
    const interrupted = this.store?.markInterruptedUploads() || 0;
    if (interrupted) this.log(`upload: ${interrupted} upload(s) were cut off by a restart — not retried, check the channel`);
  }

  async setMode(platform, mode) {
    if (platform !== 'youtube') throw new Error(`${platform} is not built yet`);
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    if (mode === 'on' && !this.yt.hasKeys(this.keys)) throw new Error('add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to .env first');
    if (mode === 'on' && !this.state.youtube.connected) throw new Error('connect YouTube first');
    this.settings.youtube.mode = mode;
    const temp = `${this.settingsPath}.tmp`;
    await writeFile(temp, JSON.stringify(this.settings, null, 2), 'utf8');
    await rename(temp, this.settingsPath);
    this.log(`upload: YouTube is now ${mode}`);
  }

  start(intervalMs = 60_000) {
    this.timer = setInterval(() => this.tick().catch((err) => this.log(`upload: ${err.message}`)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  platformKey(mode) {
    return mode === 'dry-run' ? 'youtube:dry' : 'youtube';
  }

  /** When the next upload may go, and why not sooner. */
  schedule(mode = this.settings.youtube.mode) {
    const key = this.platformKey(mode);
    const now = this.now();
    const dayStart = pacificDayStart(now);
    const today = this.store.uploadsSince(key, dayStart).filter((r) => SPENT.has(r.status)).length;
    // 26 hours on always lands in the next Pacific day, DST or not.
    const resetAt = pacificDayStart(dayStart + 26 * 3600_000);
    const last = this.store.lastUpload(key);
    const spacingAt = last ? Date.parse(last.started_at) + this.cfg.youtube.spacingMinutes * 60_000 : 0;
    let nextAt = Math.max(now, spacingAt, this.state.youtube.blockedUntil);
    let why = spacingAt > now ? 'spacing' : null;
    if (this.state.youtube.blockedUntil > now) why = this.state.youtube.blockedReason;
    if (today >= this.cfg.youtube.perDay) {
      nextAt = Math.max(nextAt, resetAt);
      why = `today's ${this.cfg.youtube.perDay} are done`;
    }
    return { today, perDay: this.cfg.youtube.perDay, nextAt, why, resetAt };
  }

  async tick() {
    const mode = this.settings.youtube.mode;
    if (mode === 'off' || this.busy || !this.store) return null;
    const plan = this.schedule(mode);
    if (plan.nextAt > this.now()) return null;
    this.busy = true;
    try {
      return await this.postOne(mode);
    } finally {
      this.busy = false;
    }
  }

  async postOne(mode) {
    const key = this.platformKey(mode);
    const state = this.state.youtube;
    const avoid = this.store
      .uploadsSince(key, this.now() - 3 * 24 * 3600_000)
      .map((r) => String(r.title || '').replace(/\s#.*$/, ''))
      .filter(Boolean);
    for (const candidate of await candidates({ store: this.store, dir: this.dir, platform: key })) {
      // The checks first: a short that fails them is set aside for good.
      let post;
      try {
        post = youtubePost(candidate, { avoid });
        const checked = await this.check(candidate.video);
        if (!checked.ok) throw new Error(`failed its checks: ${checked.problems.map((p) => p.text).join('; ')}`);
      } catch (err) {
        if (this.store.claimUpload({ file: candidate.file, platform: key, score: candidate.score, at: new Date(this.now()) })) {
          this.store.finishUpload({ file: candidate.file, platform: key, status: 'skipped', error: err.message, at: new Date(this.now()) });
        }
        this.log(`upload: skipped ${candidate.file} — ${err.message}`);
        continue;
      }

      if (mode === 'dry-run') {
        if (!this.store.claimUpload({ file: candidate.file, platform: key, title: post.title, score: candidate.score, at: new Date(this.now()) })) continue;
        this.store.finishUpload({ file: candidate.file, platform: key, status: 'dry-run', at: new Date(this.now()) });
        await appendFile(
          this.dryRunLog,
          `${JSON.stringify({ at: new Date(this.now()).toISOString(), platform: 'youtube', file: candidate.file, score: candidate.score, privacy: this.cfg.youtube.privacy, ...post })}\n`,
        );
        this.log(`upload (dry run): would post ${candidate.file} (score ${candidate.score}) as "${post.title}"`);
        return { file: candidate.file, status: 'dry-run', title: post.title };
      }

      // Signed in before anything is claimed: a lapsed sign-in spends nothing.
      let token;
      try {
        const kept = await this.yt.loadToken();
        if (!kept?.refreshToken) throw new youtube.UploadError('not connected', 'auth');
        token = await this.yt.accessToken(this.keys, kept.refreshToken);
      } catch (err) {
        return this.stopFor(err);
      }

      if (!this.store.claimUpload({ file: candidate.file, platform: key, title: post.title, score: candidate.score, at: new Date(this.now()) })) continue;
      this.log(`upload: posting ${candidate.file} (score ${candidate.score}) to YouTube as "${post.title}"`);
      try {
        const videoId = await this.yt.uploadVideo({ token, file: candidate.video, privacy: this.cfg.youtube.privacy, ...post });
        this.store.finishUpload({ file: candidate.file, platform: key, status: 'done', videoId, at: new Date(this.now()) });
        state.lastError = null;
        this.log(`upload: posted ${candidate.file} → https://youtube.com/shorts/${videoId}`);
        return { file: candidate.file, status: 'done', videoId };
      } catch (err) {
        const status = { transient: 'retry', refused: 'refused', uncertain: 'uncertain' }[err.kind] || 'failed';
        this.store.finishUpload({ file: candidate.file, platform: key, status, error: err.message, at: new Date(this.now()) });
        if (err.kind === 'refused') this.log(`upload: YouTube refused ${candidate.file} — ${err.message}; not retried`);
        if (err.kind === 'uncertain') this.log(`upload: ${candidate.file} may or may not have posted — ${err.message}; not retried, check the channel`);
        if (err.kind === 'transient') this.log(`upload: ${candidate.file} did not go (${err.message}); will try again after the spacing`);
        if (err.kind === 'quota' || err.kind === 'auth') this.stopFor(err);
        state.lastError = err.message;
        return { file: candidate.file, status, error: err.message };
      }
    }
    return null;
  }

  /** Quota or sign-in: stop, and say so, rather than keep trying. */
  stopFor(err) {
    const state = this.state.youtube;
    state.lastError = err.message;
    if (err.kind === 'quota') {
      state.blockedUntil = this.schedule().resetAt;
      state.blockedReason = "YouTube's daily quota is spent";
      this.log(`upload: YouTube quota spent — stopped until midnight Pacific`);
    } else if (err.kind === 'auth') {
      state.connected = false;
      state.blockedUntil = Number.POSITIVE_INFINITY;
      state.blockedReason = 'sign-in expired: connect YouTube again';
      this.log(`upload: YouTube sign-in no longer works (${err.message}) — connect again in the page`);
    } else {
      state.blockedUntil = this.now() + 10 * 60_000;
      state.blockedReason = err.message;
    }
    return { status: 'stopped', error: err.message };
  }

  /** Called after a successful Connect. */
  connected() {
    Object.assign(this.state.youtube, { connected: true, blockedUntil: 0, blockedReason: null, lastError: null });
  }

  async view() {
    const mode = this.settings.youtube.mode;
    const plan = this.store ? this.schedule(mode) : null;
    const key = this.platformKey(mode);
    const next = this.store ? (await candidates({ store: this.store, dir: this.dir, platform: key })).slice(0, 5) : [];
    const recent = this.store ? this.store.uploadsSince(key, this.now() - 7 * 24 * 3600_000).reverse().slice(0, 8) : [];
    return {
      youtube: {
        keys: this.yt.hasKeys(this.keys),
        connected: this.state.youtube.connected,
        mode,
        privacy: this.cfg.youtube.privacy,
        spacingMinutes: this.cfg.youtube.spacingMinutes,
        today: plan?.today ?? 0,
        perDay: this.cfg.youtube.perDay,
        nextAt: plan && mode !== 'off' ? new Date(plan.nextAt).toISOString() : null,
        waitingFor: plan?.why || null,
        lastError: this.state.youtube.lastError,
        next: next.map((c) => ({ file: c.file, score: c.score, title: c.saved.platforms?.youtube?.split('\n')[0] || c.saved.caption })),
        recent: recent.map((r) => ({ file: r.file, status: r.status, title: r.title, videoId: r.video_id, error: r.error, at: r.started_at })),
      },
      instagram: { built: false },
      tiktok: { built: false },
    };
  }
}
