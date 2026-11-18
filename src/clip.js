// Cutting a moment out of a VOD, locally.
//
// The feed's job is to point at a moment; this file's job is to get that
// moment onto disk so it can be edited. Nothing here uploads, publishes, or
// rehosts anything — the footage lands in the operator's own clips/ directory
// and stops there, which is ordinary clipper workflow and keeps the project on
// the right side of the line the rest of the design is built around.
//
// Twitch VODs are HLS, so we pull only the segments covering the window
// instead of the whole seven-hour archive. yt-dlp does that with
// --download-sections; --force-keyframes-at-cuts makes it re-encode the edges
// so the cut lands on the requested second rather than on the nearest
// keyframe, which on Twitch can be two seconds away.

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from './config.js';

// Somebody fat-fingering pre=100000 should not kick off a two-hour download.
export const MAX_CLIP_SECONDS = 600;

const MEDIA_EXT = /\.(mp4|mkv|webm|ts|mov)$/i;

/**
 * yt-dlp accepts raw seconds in --download-sections, but a human has to read
 * these in logs and error messages, so emit hh:mm:ss.
 */
export function formatClipTimestamp(totalSeconds) {
  const safe = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * Where to cut, relative to the moment's timestamp.
 *
 * The window is deliberately lopsided — 25s before, 5s after by default.
 * Both of the signals that put a moment in the feed are *reactions*: chat
 * types after the thing lands, and a clipper hits the hotkey after they have
 * already seen it. So the timestamp the feed hands us is the tail of the
 * moment, not its start, and a symmetric window would centre on the crowd's
 * response while clipping off the cause.
 *
 * start clamps at zero and the total is capped, because this arrives from a
 * browser.
 */
export function clipWindow({
  offsetSeconds,
  pre = config.clipPre,
  post = config.clipPost,
} = {}) {
  const offset = Number(offsetSeconds);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error('offsetSeconds must be a number of seconds into the VOD');
  }

  const preSeconds = Number.isFinite(Number(pre)) ? Math.max(0, Number(pre)) : config.clipPre;
  const postSeconds = Number.isFinite(Number(post)) ? Math.max(0, Number(post)) : config.clipPost;

  const start = Math.max(0, Math.round(offset - preSeconds));
  const end = Math.round(offset + postSeconds);
  const duration = end - start;

  if (duration <= 0) throw new Error('pre + post must add up to more than zero seconds');
  if (duration > MAX_CLIP_SECONDS) {
    throw new Error(`clip window is ${duration}s; the cap is ${MAX_CLIP_SECONDS}s`);
  }

  return { start, end, duration, pre: preSeconds, post: postSeconds, offset };
}

/** Twitch VOD ids are numeric; the UI and the API both sometimes carry a "v" prefix. */
export function normalizeVodId(vodId) {
  const raw = String(vodId ?? '')
    .trim()
    .replace(/^v/i, '');
  if (!/^\d+$/.test(raw)) throw new Error(`not a Twitch VOD id: ${JSON.stringify(vodId)}`);
  return raw;
}

/**
 * CLIP_QUALITY is a height cap ("1080"), a word ("source"), or — as an escape
 * hatch for anyone who knows yt-dlp — a format string passed through as-is.
 */
export function formatSelector(quality = config.clipQuality) {
  const value = String(quality ?? '').trim();
  if (!value || value === 'source' || value === 'best') return 'bv*+ba/b';
  if (/^\d+p?$/.test(value)) {
    const height = parseInt(value, 10);
    return `bv*[height<=${height}]+ba/b[height<=${height}]/b`;
  }
  return value;
}

/** A name that sorts usefully and says what it is without opening it. */
export function clipBasename({ vodId, offsetSeconds, broadcaster = '', now = new Date() }) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const who = String(broadcaster)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 24);
  const at = formatClipTimestamp(offsetSeconds).replace(/:/g, '');
  return [who || 'vod', normalizeVodId(vodId), `t${at}`, stamp].join('-');
}

/**
 * Built as an argv array, never a shell string: vodId and the window arrive
 * over HTTP, and a concatenated command line is one bad character away from
 * being a shell injection.
 */
export function ytDlpArgs({ vodId, start, end, outTemplate, quality }) {
  return [
    '--download-sections',
    `*${formatClipTimestamp(start)}-${formatClipTimestamp(end)}`,
    // Cut on the exact second instead of the nearest keyframe.
    '--force-keyframes-at-cuts',
    '--no-playlist',
    '--no-part',
    '--newline',
    // Without this there is nothing to show the operator for the length of the
    // cut. (--print would have given us the output path directly, but it
    // implies --quiet, which silences both yt-dlp's progress and the ffmpeg
    // doing the actual work. The path is recovered from the log instead.)
    '--progress',
    '-f',
    formatSelector(quality),
    '--merge-output-format',
    'mp4',
    '-o',
    outTemplate,
    `https://www.twitch.tv/videos/${normalizeVodId(vodId)}`,
  ];
}

/**
 * 9:16 for Shorts/TikTok.
 *
 * A straight centre crop of a 16:9 frame to 9:16 throws away about two thirds
 * of the width, and in GTA the thing worth clipping is as often at the edge of
 * frame as in the middle. So instead: a zoomed, blurred copy fills the tall
 * canvas and the whole original frame sits centred on top of it at full width.
 * Nothing is cropped out of the actual footage, and it still reads as a
 * vertical video.
 */
export function verticalFilter({ width = 1080, height = 1920, sigma = 24 } = {}) {
  return [
    'split=2[bg][fg]',
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${sigma}[bgblur]`,
    `[fg]scale=${width}:-2[fgscaled]`,
    '[bgblur][fgscaled]overlay=(W-w)/2:(H-h)/2',
  ].join(';');
}

export function ffmpegVerticalArgs({ input, output, width = 1080, height = 1920 }) {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-filter_complex',
    verticalFilter({ width, height }),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    output,
  ];
}

/** "python -m yt_dlp" and friends: the configured command may carry its own args. */
export function splitCommand(command) {
  const parts = String(command ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) throw new Error('empty command');
  return { file: parts[0], prefix: parts.slice(1) };
}

/**
 * yt-dlp's own errors are readable; its tracebacks are not. Prefer the ERROR:
 * line, fall back to the last thing it said, and never hand a raw stack to the
 * browser.
 */
export function readableFailure(stderr = '', stdout = '', code = null) {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const error = [...lines].reverse().find((line) => /^ERROR:/i.test(line));
  if (error) return error.replace(/^ERROR:\s*/i, '');

  // The two failure modes that are a setup problem rather than a Twitch
  // problem, and so the ones most likely to be hit on a fresh machine.
  if (/No module named yt_dlp/i.test(stderr)) {
    return 'yt-dlp is not installed for this Python. Run: python -m pip install yt-dlp';
  }
  if (/ENOENT|not recognized|cannot find the (file|path)/i.test(stderr)) {
    return 'Could not run the downloader. Check YTDLP_CMD in .env (default: python -m yt_dlp).';
  }

  return lines[lines.length - 1] || `downloader exited with code ${code}`;
}

/**
 * Which file yt-dlp is writing. "Destination:" is the single-format case;
 * "Merging formats into" is what you get when video and audio arrive
 * separately and the merged mp4 is the one worth keeping.
 */
export function parseOutputPath(line) {
  const merged = /^\[Merger\].*?Merging formats into "(.+)"$/.exec(line);
  if (merged) return merged[1];
  const destination = /^\[download\] Destination:\s*(.+)$/.exec(line);
  if (destination) return destination[1].trim();
  return null;
}

/** yt-dlp --newline progress, e.g. "[download]  42.1% of ~12.00MiB at ...". */
export function parseProgress(line) {
  const download = /^\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (download) return { stage: 'download', percent: Number(download[1]) };
  // --force-keyframes-at-cuts means ffmpeg does the actual cut, and its
  // progress lines are the only sign of life during a long re-encode.
  const encode = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (encode) {
    const seconds = Number(encode[1]) * 3600 + Number(encode[2]) * 60 + Number(encode[3]);
    return { stage: 'cut', seconds };
  }
  return null;
}

function run(file, args, { cwd, onLine, label }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) {
        const failure = new Error(readableFailure(stderr, stdout, err.code));
        failure.label = label;
        failure.exitCode = err.code ?? null;
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });

    const feed = (chunk) => {
      for (const line of String(chunk).split(/\r?\n|\r/)) {
        if (line.trim() && onLine) onLine(line.trim());
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
  });
}

// Last resort if --print gave us nothing: the job's basename is unique, so a
// prefix match in the clip directory can only be our own output.
async function newestVideoIn(dir, basename) {
  const names = await readdir(dir);
  const candidates = names.filter((name) => name.startsWith(basename) && MEDIA_EXT.test(name));
  if (!candidates.length) return null;
  const stats = await Promise.all(
    candidates.map(async (name) => {
      const path = join(dir, name);
      return { path, mtime: (await stat(path)).mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].path;
}

/**
 * Download the window around a moment and, optionally, render a vertical copy.
 * onProgress is called with {stage, percent|seconds, message} as the two
 * subprocesses talk.
 */
export async function extractClip({
  vodId,
  offsetSeconds,
  pre,
  post,
  vertical = false,
  broadcaster = '',
  dir = config.clipDir,
  quality = config.clipQuality,
  onProgress = () => {},
} = {}) {
  const id = normalizeVodId(vodId);
  const window = clipWindow({ offsetSeconds, pre, post });
  const basename = clipBasename({ vodId: id, offsetSeconds, broadcaster });

  await mkdir(dir, { recursive: true });

  const { file, prefix } = splitCommand(config.ytdlpCmd);
  const args = [
    ...prefix,
    ...ytDlpArgs({
      vodId: id,
      start: window.start,
      end: window.end,
      outTemplate: join(dir, `${basename}.%(ext)s`),
      quality,
    }),
  ];

  onProgress({
    stage: 'download',
    percent: 0,
    message: `cutting ${window.duration}s from ${formatClipTimestamp(window.start)}`,
  });

  let reported = null;
  await run(file, args, {
    cwd: config.root,
    label: 'yt-dlp',
    onLine: (line) => {
      const output = parseOutputPath(line);
      // A merge happens after the download, so a later line always wins.
      if (output) reported = output;
      const progress = parseProgress(line);
      if (progress) onProgress(progress);
    },
  });

  // The basename is unique to this job, so a prefix match in the clip
  // directory can only be our own file — which makes the directory the
  // authority and the log line merely a shortcut.
  const path = (await newestVideoIn(dir, basename)) || reported;

  if (!path) throw new Error('the download finished but no file turned up in the clip directory');

  const result = {
    path,
    verticalPath: null,
    vodId: id,
    offsetSeconds: window.offset,
    start: window.start,
    end: window.end,
    durationSeconds: window.duration,
    pre: window.pre,
    post: window.post,
  };

  if (vertical) {
    const output = `${path.replace(/\.[^.]+$/, '')}-vertical.mp4`;
    onProgress({ stage: 'vertical', percent: 0, message: 'rendering 9:16' });
    await run('ffmpeg', ffmpegVerticalArgs({ input: path, output }), {
      cwd: config.root,
      label: 'ffmpeg',
      onLine: (line) => {
        const progress = parseProgress(line);
        if (progress) onProgress({ ...progress, stage: 'vertical' });
      },
    });
    result.verticalPath = output;
  }

  return result;
}
