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

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';

import { config, root } from './config.js';
import { extractClip } from './clip.js';
import { renderShort } from './shortform.js';

const jobs = new Map();
const waiting = [];
let running = 0;

// Keep the newest jobs and forget the rest, so a long session doesn't grow a
// list nobody will ever look at again.
const MAX_JOBS = 200;

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
    auto: Boolean(job.short?.auto),
    durationSeconds: job.durationSeconds,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function pump() {
  while (running < Math.max(1, config.clipConcurrency) && waiting.length) {
    const job = waiting.shift();
    running += 1;
    job.state = 'running';
    job.startedAt = new Date().toISOString();

    extractClip({
      vodId: job.vodId,
      offsetSeconds: job.offsetSeconds,
      pre: job.pre,
      post: job.post,
      vertical: job.vertical,
      broadcaster: job.broadcaster,
      dir: job.dir,
      onProgress: ({ stage, percent, seconds, message }) => {
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
      },
    })
      .then(async (result) => {
        job.path = result.path;
        job.verticalPath = result.verticalPath;
        job.durationSeconds = result.durationSeconds;

        // A third stage, run inside the same job so it shares the same
        // concurrency budget: the captioned 9:16 short, plus its post copy.
        if (job.short) {
          job.stage = 'short';
          job.progress = 0;
          const made = await renderShort({
            input: result.path,
            output: join(job.short.dir, `${basename(result.path, extname(result.path))}.mp4`),
            moment: job.short.moment,
            start: result.start,
            onProgress: ({ seconds, message }) => {
              if (Number.isFinite(seconds) && job.expectedSeconds > 0) {
                job.progress = Math.min(99, Math.round((seconds / job.expectedSeconds) * 100));
              }
              if (message) job.message = message;
            },
          });
          job.shortPath = made.path;
          job.textPath = made.textPath;
          job.caption = made.caption;
          // The landscape cut was only ever an intermediate for this job.
          if (!job.short.keepSource) {
            await rm(result.path, { force: true });
            job.path = null;
          }
        }

        job.state = 'done';
        job.progress = 100;
        job.message = job.shortPath
          ? `short ready (${result.durationSeconds}s)`
          : `${result.durationSeconds}s saved`;
      })
      .catch((err) => {
        job.state = 'failed';
        job.message = err.message;
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
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
    shortPath: null,
    textPath: null,
    caption: null,
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
