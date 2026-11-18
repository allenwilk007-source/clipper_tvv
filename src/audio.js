// What the stream itself sounded like.
//
// Chat is the only signal this feed has that fires before anybody clips, but
// it has a structural flaw as a *position*: chat reacts after the thing
// happens. A moment nominated by chat carries offsetEstimated: true, and the
// cut is built around when people finished typing rather than around the
// event. Stream audio has the opposite property — it moves during.
//
// So this fetches the audio around a nominated offset and reports where it was
// loudest. Audio-only is the cheapest thing Twitch serves: ~214kbit/s, so a
// 60-second window is under 2MB and arrives in about a second. That is cheap
// enough to run per moment rather than per channel, which matters — a
// persistent decoder for every watched channel is a process per channel, and
// this machine has already shown it stops being able to spawn them under load.
//
// Nothing here claims audio identifies a moment. It measures. Whether the
// measurement means anything is what audiolag.js is for.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from './config.js';
import { run, splitCommand } from './clip.js';

// ebur128 reports roughly -120 LUFS for digital silence. Those samples are not
// quiet, they are absent, and leaving them in drags the median toward a value
// no audible passage ever takes.
const SILENCE_FLOOR = -70;

// Converts MAD to a standard-deviation-equivalent for a normal distribution,
// so a z computed here is comparable to the one chat.js computes. Same
// constant, same reason.
const MAD_SCALE = 1.4826;

/** The window to fetch, clamped so a moment near the start of a VOD still works. */
export function audioWindow(offsetSeconds, { before = 30, after = 30 } = {}) {
  const offset = Math.max(0, Math.round(Number(offsetSeconds) || 0));
  const start = Math.max(0, offset - before);
  const end = offset + after;
  return { start, end, offset, seconds: end - start };
}

/**
 * Pull `t:` and `M:` out of ebur128's log.
 *
 * M is momentary loudness over a 400ms window, emitted every 100ms. Kept
 * separate from the spawning so it can be tested against a captured log
 * instead of against Twitch.
 */
export function parseLoudness(text) {
  const samples = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /t:\s*([0-9.]+).*?M:\s*(-?[0-9.]+)/.exec(line);
    if (!match) continue;
    const t = Number(match[1]);
    const m = Number(match[2]);
    if (!Number.isFinite(t) || !Number.isFinite(m)) continue;
    if (m <= SILENCE_FLOOR) continue;
    samples.push({ t, m });
  }
  return samples;
}

/**
 * Median and MAD rather than mean and standard deviation.
 *
 * A single explosion is exactly the thing being looked for, and it would drag
 * a mean up far enough to hide itself. The median does not move.
 */
export function robustStats(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { median: null, mad: null, count: 0 };
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  return { median, mad, count: sorted.length };
}

/**
 * The loudest moment in the window, and how far it stands above the room.
 *
 * `lag` is the headline: seconds between the audio peak and the offset chat
 * nominated. Positive means the audio came first, which is the direction the
 * whole idea depends on.
 */
export function peakOf(samples, { windowStart = 0, chatOffset = null } = {}) {
  if (!samples.length) return null;
  const stats = robustStats(samples.map((s) => s.m));
  // A window of near-constant loudness has MAD 0, and dividing by it would
  // report every tiny wobble as an infinite spike.
  const scale = stats.mad && stats.mad > 0.05 ? stats.mad * MAD_SCALE : null;

  let peak = samples[0];
  for (const sample of samples) if (sample.m > peak.m) peak = sample;

  const at = windowStart + peak.t;
  return {
    at: Math.round(at * 10) / 10,
    loudness: Math.round(peak.m * 10) / 10,
    z: scale ? Math.round(((peak.m - stats.median) / scale) * 100) / 100 : null,
    median: Math.round(stats.median * 10) / 10,
    mad: Math.round(stats.mad * 100) / 100,
    samples: stats.count,
    lag: Number.isFinite(chatOffset) ? Math.round((chatOffset - at) * 10) / 10 : null,
  };
}

const YTDLP_FORMAT = 'Audio_Only/audio_only/worstaudio/worst';

/**
 * Fetch the audio around an offset and measure it.
 *
 * Two processes, run one after the other rather than piped: yt-dlp writing to
 * stdout and ffmpeg reading it works until a fixup step runs, and then it
 * silently produces nothing. A temp file costs a megabyte and removes the
 * failure mode entirely.
 */
export async function probeLoudnessAt({
  vodId,
  offsetSeconds,
  before = 30,
  after = 30,
  log = () => {},
} = {}) {
  const id = String(vodId || '').replace(/^v/i, '');
  if (!/^\d+$/.test(id)) return { ok: false, reason: 'no vod id' };

  const window = audioWindow(offsetSeconds, { before, after });
  const dir = await mkdtemp(join(tmpdir(), 'loudness-'));
  const target = join(dir, 'a.%(ext)s');

  try {
    const { file, prefix } = splitCommand(config.ytdlpCmd);
    await run(
      file,
      [
        ...prefix,
        '-f',
        YTDLP_FORMAT,
        '--download-sections',
        `*${window.start}-${window.end}`,
        '--no-warnings',
        '--no-playlist',
        '-o',
        target,
        `https://www.twitch.tv/videos/${id}`,
      ],
      { cwd: config.root, label: 'yt-dlp' },
    );

    // yt-dlp picks the extension, and the fixup step may change it.
    const { readdir } = await import('node:fs/promises');
    const found = (await readdir(dir)).filter((name) => !name.endsWith('.part'));
    if (!found.length) return { ok: false, reason: 'nothing downloaded' };
    const audioPath = join(dir, found[0]);

    // ebur128 writes to stderr; -f null throws the decoded audio away.
    const { stderr } = await run(
      'ffmpeg',
      ['-hide_banner', '-nostats', '-i', audioPath, '-af', 'ebur128', '-f', 'null', '-'],
      { cwd: config.root, label: 'ffmpeg' },
    ).catch((err) => ({ stderr: err.message, failed: true }));

    const samples = parseLoudness(stderr);
    if (!samples.length) return { ok: false, reason: 'no loudness samples' };

    const peak = peakOf(samples, { windowStart: window.start, chatOffset: window.offset });
    return { ok: true, window, peak, samples };
  } catch (err) {
    log(`loudness probe failed for ${id}@${window.offset}: ${err.message}`);
    return { ok: false, reason: err.message, window };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const _internal = { SILENCE_FLOOR, MAD_SCALE, YTDLP_FORMAT, readFile };
