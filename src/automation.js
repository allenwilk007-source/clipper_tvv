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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { AutoClipper, autoclipConfig } from './autoclip.js';
import { config } from './config.js';

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

// Each chat socket carries 18 channels; this keeps it to three.
export const MAX_CHANNELS = 50;

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
export function applyChange(settings, { enabled, add, remove } = {}) {
  const next = { enabled: settings.enabled, channels: [...settings.channels] };

  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    next.enabled = enabled;
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
      if (exists) {
        try {
          postText = await readFile(join(dir, file.replace(/\.mp4$/, '.txt')), 'utf8');
        } catch {
          /* the video without its copy is still worth showing */
        }
      }
      return {
        momentId: row.momentId,
        broadcaster: row.broadcaster,
        caption: row.caption,
        status: row.status,
        error: row.error,
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
        // Served at /shorts/<file>. Null once moved or deleted from the folder.
        file: exists ? file : null,
        postText,
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
    });
    this.clipper = clipper || new AutoClipper({ store: feed.store, log, cfg: autoclipConfig(env) });
    this.clipper.setChannels(this.settings.channels);
    this.timer = null;
    this.seen = null;
  }

  get dir() {
    return this.clipper.cfg.dir;
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

    if (channelsChanged) {
      this.clipper.setChannels(next.channels);
      // Chat-only listens to exactly these. The full feed watches the whole
      // category, and there the list only decides what automation cuts.
      if (this.feed.chatOnly && this.feed.started) this.feed.setWatchList(next.channels);
      else this.feed.watchChannels = [...next.channels];
    }
    if (change.enabled !== undefined) this.log(`autocollect: automation ${next.enabled ? 'on' : 'off'}`);
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
    return {
      enabled: this.settings.enabled,
      mode: this.feed.chatOnly ? 'chat-only' : 'full',
      channels: this.settings.channels.map((login) => ({ login, state: this.channelState(login) })),
      status: this.clipper.status(),
      shorts: await listShorts(this.feed.store, this.dir),
    };
  }
}
