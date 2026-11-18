// In-memory clip job queue.
//
// A cut takes seconds to a minute, which is far too long to hold an HTTP
// request open while the browser's own fetch timeout runs out, so POST hands
// back a job id and the card polls it.
//
// Jobs live in a Map and die with the process. That is the right trade here:
// the artefact worth keeping is the mp4 on disk, not the record of having
// downloaded it, and persisting a queue would mean resuming half-written files
// after a restart for no benefit.
//
// Concurrency is capped because each running job is an ffmpeg re-encode. Two
// saturates a normal machine's upstream-and-CPU budget; more just makes every
// clip slower while someone is waiting on the first one.
//
// An automated short goes through three steps in one job:
//
//   cut      the window from the recording, retried when it fails for a reason
//            that passes (a process Windows could not start, a dropped
//            connection, a recording that has not caught up yet)
//   review   the engagement meter; below KEEP_SCORE, one redo from a wider
//            cut re-centred on where the action is, kept only if it scores
//            higher
//   render   the short itself, which checks its own output before it can
//            reach the ready folder

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

import { config, root } from './config.js';
import { extractClip } from './clip.js';
import { FLOOR_SCORE, KEEP_SCORE, bestWindow, measureCut, scoreWindow, shiftWords } from './engagement.js';
import { cutFromSnapshot } from './live.js';
import { probe, renderShort, shortformConfig, speechIn } from './shortform.js';

const jobs = new Map();
const waiting = [];
let running = 0;

// Keep the newest jobs and forget the rest, so a long session doesn't grow a
// list nobody will ever look at again.
const MAX_JOBS = 200;

// A redo cuts this much around the moment and picks the best 30s inside it.
const WIDE_PRE = 55;
const WIDE_POST = 15;

function trim() {
  if (jobs.size <= MAX_JOBS) return;
  for (const id of [...jobs.keys()].slice(0, jobs.size - MAX_JOBS)) {
    const job = jobs.get(id);
    if (job.state === 'done' || job.state === 'failed') jobs.delete(id);
  }
}

// Absolute paths in the browser are noise; relative to the repo is what the
// operator will type into their editor.
const show = (path) => (path ? relative(root, path) || path : null);
const firstLine = (message) => String(message ?? '').split(/\r?\n/)[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Failures that pass. Each one here was seen for real: 3221225794
 * (0xC0000142) is Windows refusing to start a process while too many start at
 * once; "list index out of range" came from yt-dlp mid-run; "not recorded yet"
 * is a cut that came back shorter than asked because the recording had not
 * caught up.
 */
export function isTransient(message) {
  return /3221225794|0xC0000142|ETIMEDOUT|ECONNRESET|EAI_AGAIN|timed out|HTTP Error 5\d\d|Unable to download|fragment|list index out of range|Connection reset|not recorded yet/i.test(
    String(message ?? ''),
  );
}

/** Run `fn`, trying again after a pause when it fails for a reason that passes. */
export async function withRetry(fn, { tries = 3, delays = [5000, 20000], retryable = isTransient, onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= tries || !retryable(err.message)) throw err;
      onRetry(err, attempt);
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    }
  }
}

/**
 * A cut, checked for length. One that comes back shorter than asked missed
 * part of the moment — measured: a 28.0s short from a 30s window — so it is
 * thrown away and, being transient, tried again once the recording catches up.
 */
async function cutChecked(options) {
  const result = await extractClip(options);
  const actual = (await probe(result.path)).duration;
  if (actual < result.durationSeconds - 1.5) {
    await rm(result.path, { force: true });
    throw new Error(`the recording held only ${actual.toFixed(1)}s of ${result.durationSeconds}s: not recorded yet`);
  }
  return { ...result, measured: actual };
}

/**
 * One window of a job's moment: from the VOD, or, for a channel with no VOD,
 * from the snapshot of its live recording taken when the moment was claimed.
 * Both come back the same shape, so nothing after the cut can tell them apart.
 */
async function cutWindow(job, { pre, post, onProgress = () => {}, onRetry = () => {} }) {
  if (job.live) {
    const result = await cutFromSnapshot(job.live.snapshot, {
      anchorAt: job.live.anchorAt,
      pre,
      post,
      dir: job.dir || config.clipDir,
      name: `${job.live.name}-${pre}-${post}`,
    });
    const actual = (await probe(result.path)).duration;
    // Either way off is wrong: a stream ffmpeg misreads can claim hours.
    if (!(Math.abs(actual - result.durationSeconds) <= 1.5)) {
      await rm(result.path, { force: true });
      throw new Error(`the live recording gave ${actual.toFixed(1)}s of ${result.durationSeconds}s`);
    }
    return { ...result, verticalPath: null, measured: actual };
  }
  return withRetry(
    () =>
      cutChecked({
        vodId: job.vodId,
        offsetSeconds: job.offsetSeconds,
        pre,
        post,
        vertical: job.vertical,
        broadcaster: job.broadcaster,
        dir: job.dir,
        onProgress,
      }),
    { onRetry },
  );
}

/**
 * Speech and signals for one cut, for the meter. One after the other, not at
 * once: in parallel this started transcription (python and ffmpeg) and two
 * more ffmpeg passes together, and with two jobs running that burst of eight
 * or more processes is what made Windows refuse to start any (3221225794)
 * under sustained load. Sequential costs about a second a short.
 */
async function analyse(path, settings) {
  const speech = await speechIn(path, settings);
  const measured = await measureCut(path);
  return { ...speech, measured };
}

export function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    vodId: job.vodId,
    offsetSeconds: job.offsetSeconds,
    momentId: job.momentId,
    vertical: job.vertical,
    progress: job.progress,
    message: job.message,
    path: show(job.path),
    verticalPath: show(job.verticalPath),
    shortPath: show(job.shortPath),
    textPath: show(job.textPath),
    caption: job.caption,
    review: job.review,
    auto: Boolean(job.short?.auto),
    durationSeconds: job.durationSeconds,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/** The review step: score the cut, and redo it once if it scores low. */
async function review(job, result, settings) {
  const length = result.measured;
  const chat = job.short.moment?.chat || null;
  let cut = {
    path: result.path,
    trim: null,
    start: result.start,
    reactionAt: result.offsetSeconds - result.start,
  };

  job.message = 'reviewing the cut';
  let analysis = await analyse(result.path, settings);
  let verdict = {
    ...scoreWindow({ ...analysis.measured, words: analysis.words, chat, start: 0, end: length, payoffAt: cut.reactionAt }),
    redone: false,
  };

  if (verdict.score < KEEP_SCORE) {
    const before = verdict.score;
    job.message = `scored ${before}, under ${KEEP_SCORE}: re-cutting a wider window`;
    try {
      const wide = await cutWindow(job, { pre: WIDE_PRE, post: WIDE_POST });
      const wideAnalysis = await analyse(wide.path, settings);
      const anchor = wide.offsetSeconds - wide.start;
      const best = bestWindow({ ...wideAnalysis.measured, words: wideAnalysis.words, chat, duration: wide.measured, anchor, length });
      if (best && best.score > before) {
        await rm(result.path, { force: true });
        cut = { path: wide.path, trim: { start: best.start, duration: length }, start: wide.start + best.start, reactionAt: anchor - best.start };
        analysis = { ...wideAnalysis, words: wideAnalysis.words ? shiftWords(wideAnalysis.words, best.start, length) : null };
        verdict = { ...best, redone: true, before };
      } else {
        await rm(wide.path, { force: true });
        verdict.redoTried = true;
      }
    } catch (err) {
      verdict.redoError = firstLine(err.message);
    }
  }

  verdict.weak = verdict.score < FLOOR_SCORE;
  return { cut, analysis, verdict };
}

async function runJob(job) {
  const progress = ({ stage, percent, seconds, message }) => {
    job.stage = stage;
    if (Number.isFinite(percent) && percent > 0) job.progress = Math.round(percent);
    // --force-keyframes-at-cuts hands the download to ffmpeg, which never
    // reports a percentage — only how far into the clip it has got. That
    // is a better progress number anyway, since we know how long the clip
    // is meant to be. Hold it below 100 so only completion says 100.
    else if (Number.isFinite(seconds) && job.expectedSeconds > 0) {
      job.progress = Math.min(99, Math.round((seconds / job.expectedSeconds) * 100));
    }
    if (message) job.message = message;
    else if (stage === 'vertical') job.message = 'rendering 9:16';
    else if (Number.isFinite(seconds)) job.message = `cutting ${Math.round(seconds)}s`;
  };

  const result = await cutWindow(job, {
    pre: job.pre,
    post: job.post,
    onProgress: progress,
    onRetry: (err, attempt) => (job.message = `retrying the cut (${attempt}): ${firstLine(err.message).slice(0, 80)}`),
  });
  job.path = result.path;
  job.verticalPath = result.verticalPath;
  job.durationSeconds = result.durationSeconds;

  if (job.short) {
    const settings = shortformConfig();
    job.stage = 'short';
    job.progress = 0;
    const { cut, analysis, verdict } = await review(job, result, settings);
    job.review = verdict;

    const made = await withRetry(
      () =>
        renderShort({
          input: cut.path,
          trim: cut.trim,
          // Named after the original cut, so a redo does not change the file.
          output: join(
            job.short.dir,
            `${job.live ? job.live.name : basename(result.path, extname(result.path))}.mp4`,
          ),
          moment: job.short.moment,
          start: cut.start,
          reactionAt: cut.reactionAt,
          words: analysis.words,
          speechError: analysis.speechError,
          avoid: job.short.avoid || [],
          music: Boolean(job.short.music),
          settings,
          onProgress: ({ seconds, message }) => {
            if (Number.isFinite(seconds) && job.expectedSeconds > 0) {
              job.progress = Math.min(99, Math.round((seconds / job.expectedSeconds) * 100));
            }
            if (message) job.message = message;
          },
        }),
      { tries: 2 },
    );
    job.shortPath = made.path;
    job.textPath = made.textPath;
    job.caption = made.caption;
    job.description = made.description || null;
    job.words = made.words;
    job.speechError = made.speechError;
    job.track = made.track;
    job.cam = made.cam;
    // The cuts were only ever intermediates for this job.
    if (!job.short.keepSource) {
      await rm(cut.path, { force: true });
      await rm(result.path, { force: true });
      job.path = null;
    }
  }

  job.state = 'done';
  job.progress = 100;
  job.message = job.shortPath
    ? `short ready (${result.durationSeconds}s, score ${job.review?.score ?? '—'})`
    : `${result.durationSeconds}s saved`;
}

function pump() {
  while (running < Math.max(1, config.clipConcurrency) && waiting.length) {
    const job = waiting.shift();
    running += 1;
    job.state = 'running';
    job.startedAt = new Date().toISOString();

    runJob(job)
      .catch((err) => {
        job.state = 'failed';
        job.message = firstLine(err.message);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        // A live moment's copy of the recording, kept or failed alike.
        if (job.live?.snapshotDir) rm(job.live.snapshotDir, { recursive: true, force: true }).catch(() => {});
        running -= 1;
        trim();
        pump();
        if (job.onSettled) {
          try {
            job.onSettled(job);
          } catch {
            /* a broken listener must not jam the queue */
          }
        }
      });
  }
}

/** Throws on bad input (the caller turns that into a 400) rather than queueing junk. */
export function enqueueClip({
  vodId,
  offsetSeconds,
  pre,
  post,
  vertical = false,
  broadcaster = '',
  momentId = null,
  dir = undefined,
  short = null,
  onSettled = null,
  live = null,
}) {
  const job = {
    id: randomUUID(),
    state: 'queued',
    vodId,
    offsetSeconds,
    pre,
    post,
    vertical: Boolean(vertical),
    broadcaster,
    momentId,
    dir,
    short,
    onSettled,
    live,
    shortPath: null,
    textPath: null,
    caption: null,
    review: null,
    // What the clip should come out as, used to turn ffmpeg's position into a
    // percentage. The pre-roll is clamped by the start of the VOD.
    expectedSeconds: Math.min(Number(pre) || 0, Number(offsetSeconds) || 0) + (Number(post) || 0),
    stage: 'queued',
    progress: 0,
    message: 'queued',
    path: null,
    verticalPath: null,
    durationSeconds: null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };

  jobs.set(job.id, job);
  waiting.push(job);
  pump();
  return job;
}

export const getClipJob = (id) => jobs.get(id) || null;

export const clipQueueStatus = () => ({
  running,
  queued: waiting.length,
  concurrency: Math.max(1, config.clipConcurrency),
});
