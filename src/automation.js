// Channel automation: pick channels once, and every moment they produce is cut
// into a finished short with nobody clicking anything.
//
// The shape is the one clippers already know from channel-automation tools:
// add a channel, switch it on, shorts appear. The difference is where the
// moments come from. Those tools wait for a creator to upload and then cut the
// upload; here a moment is found while the stream is still live — from chat,
// before anybody has clipped it — and cut from the recording as it is made.
//
// The server owns one of these. It watches the feed for new polls, hands them
// to the AutoClipper when switched on, and keeps the panel's settings in
// data/automation.json so they survive a restart.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { AutoClipper, autoclipConfig } from './autoclip.js';
import { config } from './config.js';
import { listTracks, shortformConfig } from './shortform.js';

const LOGIN = /^[a-z0-9_]{1,25}$/;

// Paths on twitch.tv that look like a channel name and are not one.
const NOT_CHANNELS = new Set([
  'videos',
  'directory',
  'settings',
  'search',
  'p',
  'subscriptions',
  'inventory',
  'wallet',
  'drops',
  'following',
  'prime',
  'turbo',
  'jobs',
  'downloads',
]);

// Each chat socket carries 18 channels, so this is six sockets: plenty of
// channels across two games without hammering Twitch's chat servers.
export const MAX_CHANNELS = 100;

// With credentials, where automation finds its moments: only the channels on
// the list, or every live channel in the games.
export const SCOPES = ['channels', 'category'];

/** A channel login from whatever gets pasted: "xqc", "@xQc", or a twitch.tv link. */
export function normalizeLogin(raw) {
  let text = String(raw ?? '').trim().toLowerCase();
  const url = /(?:^|\/\/)(?:www\.|m\.)?twitch\.tv\/([^/?#\s]+)/.exec(text);
  if (url) text = url[1];
  text = text.replace(/^@/, '');
  return LOGIN.test(text) && !NOT_CHANNELS.has(text) ? text : null;
}

export function sanitizeSettings(raw, fallback) {
  const channels = Array.isArray(raw?.channels)
    ? [...new Set(raw.channels.map(normalizeLogin).filter(Boolean))].slice(0, MAX_CHANNELS)
    : [...fallback.channels];
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    channels,
    music: typeof raw?.music === 'boolean' ? raw.music : Boolean(fallback.music),
    scope: SCOPES.includes(raw?.scope) ? raw.scope : fallback.scope || 'channels',
  };
}

export function loadSettings(path, fallback) {
  try {
    return sanitizeSettings(JSON.parse(readFileSync(path, 'utf8')), fallback);
  } catch {
    return sanitizeSettings(null, fallback);
  }
}

function saveSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.tmp`;
  writeFileSync(partial, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(partial, path);
}

/** One change from the panel, applied to the settings. Throws a readable error on bad input. */
export function applyChange(settings, { enabled, add, remove, music, scope } = {}) {
  const next = { ...settings, channels: [...settings.channels] };

  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    next.enabled = enabled;
  }
  if (music !== undefined) {
    if (typeof music !== 'boolean') throw new Error('music must be true or false');
    next.music = music;
  }
  if (scope !== undefined) {
    if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
    next.scope = scope;
  }
  if (add !== undefined) {
    const login = normalizeLogin(add);
    if (!login) throw new Error(`"${String(add).slice(0, 40)}" is not a Twitch channel name`);
    if (!next.channels.includes(login)) {
      if (next.channels.length >= MAX_CHANNELS) throw new Error(`at most ${MAX_CHANNELS} channels`);
      next.channels.push(login);
    }
  }
  if (remove !== undefined) {
    const login = normalizeLogin(remove);
    next.channels = next.channels.filter((channel) => channel !== login);
  }
  return next;
}

// Exactly the names clipBasename produces. Anything else is not served, which
// is what keeps /shorts/ from becoming a way to read arbitrary files.
export const SHORT_FILE = /^[a-z0-9_]+-\d+-t\d+-\d{8}T\d{6}Z\.(mp4|txt)$/;

/**
 * A byte range from a Range header, or null to send the whole file.
 * A <video> element needs this to seek at all.
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    // "bytes=-500" is the last 500 bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

/** Newest shorts for the panel, with their post copy if the file is still there. */
export async function listShorts(store, dir, { limit = 24 } = {}) {
  if (!store) return [];
  return Promise.all(
    store.listAutoclips({ limit }).map(async (row) => {
      const file = row.path ? basename(row.path) : null;
      const exists = Boolean(file && SHORT_FILE.test(file) && existsSync(join(dir, file)));
      let postText = null;
      let post = null;
      if (exists) {
        try {
          postText = await readFile(join(dir, file.replace(/\.mp4$/, '.txt')), 'utf8');
        } catch {
          /* the video without its copy is still worth showing */
        }
        try {
          // The pieces each platform button assembles in its own order.
          post = JSON.parse(await readFile(join(dir, file.replace(/\.mp4$/, '.json')), 'utf8'));
        } catch {
          /* older shorts have only the .txt */
        }
      }
      let review = null;
      try {
        review = row.review ? JSON.parse(row.review) : null;
      } catch {
        review = null;
      }
      return {
        momentId: row.momentId,
        broadcaster: row.broadcaster,
        caption: row.caption,
        status: row.status,
        // The engagement meter's verdict, for shorts made since it existed.
        score: Number.isFinite(row.score) ? row.score : null,
        funny: Number.isFinite(row.funny) ? row.funny : null,
        redone: row.redone === 1,
        weak: row.weak === 1,
        reasons: review?.reasons || [],
        before: review?.before ?? null,
        error: row.error,
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
        // Served at /shorts/<file>. Null once moved or deleted from the folder.
        file: exists ? file : null,
        postText,
        post,
      };
    }),
  );
}

export class Automation {
  constructor({
    feed,
    log = () => {},
    path = join(config.root, 'data', 'automation.json'),
    clipper,
    env = process.env,
  } = {}) {
    this.feed = feed;
    this.log = log;
    this.path = path;
    this.settings = loadSettings(path, {
      // Off until someone switches it on: a fresh checkout should not start
      // re-encoding the moment it is run. AUTOCLIP=on starts it on.
      enabled: env.AUTOCLIP === 'on',
      channels: [...(feed.watchChannels || [])],
      music: env.SHORTS_MUSIC === 'on',
      scope: 'channels',
    });
    this.clipper = clipper || new AutoClipper({ store: feed.store, log, cfg: autoclipConfig(env) });
    this.applyToClipper();
    this.timer = null;
    this.seen = null;
  }

  get dir() {
    return this.clipper.cfg.dir;
  }

  /**
   * Which channels automation cuts. Chat-only can only hear the list, so the
   * list it is; with credentials, "category" means every live channel the
   * feed finds in the games.
   */
  applyToClipper() {
    const everywhere = this.settings.scope === 'category' && this.feed.chatOnly === false;
    this.clipper.setChannels(everywhere ? [] : this.settings.channels);
    this.clipper.setMusic?.(this.settings.music);
  }

  /**
   * Show a finished short in the file manager, selected, ready to drag into an
   * upload page. Only names the renderer makes, only from the shorts folder.
   */
  reveal(name) {
    if (!SHORT_FILE.test(name)) throw new Error('not a short');
    const path = join(this.dir, name);
    if (!existsSync(path)) throw new Error('that short is no longer in the folder');
    const [command, args] =
      process.platform === 'win32'
        ? ['explorer.exe', [`/select,${path.replace(/\//g, '\\')}`]]
        : process.platform === 'darwin'
          ? ['open', ['-R', path]]
          : ['xdg-open', [this.dir]];
    // explorer.exe exits non-zero even when it worked, so the result is ignored.
    execFile(command, args, () => {});
    return path;
  }

  /** Before feed.start(): in chat-only mode these channels ARE the watch list. */
  prepare() {
    if (this.settings.channels.length) this.feed.watchChannels = [...this.settings.channels];
    this.clipper.load();
  }

  start() {
    // The feed replaces its moments array on every poll, so a new array is a
    // new poll. Watching for that keeps the feed unaware of automation.
    this.timer = setInterval(() => {
      const moments = this.feed.moments;
      if (!moments || moments === this.seen) return;
      this.seen = moments;
      if (!this.settings.enabled) return;
      this.clipper
        .onPoll(moments)
        .catch((err) => this.log(`autocollect: poll failed: ${err.message}`));
    }, 2000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  update(change = {}) {
    const next = applyChange(this.settings, change);
    const channelsChanged = next.channels.join() !== this.settings.channels.join();
    this.settings = next;
    saveSettings(this.path, next);

    this.applyToClipper();
    if (channelsChanged) {
      // Chat-only listens to exactly these. The full feed watches the whole
      // category, and there the list only decides what automation cuts.
      if (this.feed.chatOnly && this.feed.started) this.feed.setWatchList(next.channels);
      else this.feed.watchChannels = [...next.channels];
    }
    if (change.enabled !== undefined) this.log(`autocollect: automation ${next.enabled ? 'on' : 'off'}`);
    if (change.music !== undefined) this.log(`autocollect: background music ${next.music ? 'on' : 'off'}`);
    return next;
  }

  /** What one channel is doing, as far as the feed can tell. */
  channelState(login) {
    const channel = this.feed.channels?.get(login);
    if (!this.feed.chatOnly) return channel ? 'live' : 'not live in category';
    if (channel?.vodId) return 'recording';
    if (channel?.archiveCheckedAt) return 'not recording';
    return 'listening';
  }

  async view() {
    const musicDir = shortformConfig().musicDir;
    return {
      enabled: this.settings.enabled,
      mode: this.feed.chatOnly ? 'chat-only' : 'full',
      scope: this.settings.scope,
      games: [...config.games],
      music: this.settings.music,
      musicTracks: (await listTracks(musicDir)).length,
      musicDir: relative(config.root, musicDir) || musicDir,
      channels: this.settings.channels.map((login) => ({ login, state: this.channelState(login) })),
      status: this.clipper.status(),
      shorts: await listShorts(this.feed.store, this.dir, { limit: 48 }),
    };
  }
}
