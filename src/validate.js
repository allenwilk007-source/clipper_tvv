// Checking a finished short before anyone can see it.
//
// A short is only moved into the ready folder after this passes, so a broken
// file is never one click away from being posted. Two kinds of fault, handled
// differently:
//
//   render   the file itself is wrong: it does not decode cleanly, is the
//            wrong size or length, or lost its audio or video stream. These
//            are usually transient — a process killed mid-write, a starved
//            encoder — so the short is rendered once more.
//   content  the file is fine but what is in it is not: mostly black, a
//            stream that froze, no sound at all. Rendering the same footage
//            again gives the same result, so these are rejected outright.
//
// Everything that decides is a pure function over ffprobe's JSON and ffmpeg's
// log, so each rule is tested; validateShort is the only part that runs
// anything.

import { run } from './clip.js';
import { config } from './config.js';

// A stream that froze for most of the clip is broken, not a still scene: the
// engagement meter already marks merely static clips down.
const MAX_FROZEN = 0.8;
const MAX_BLACK = 0.5;

const problem = (kind, text) => ({ kind, text });

/** What is wrong with the streams, from ffprobe's JSON. */
export function judgeStreams(data, { expectSeconds = 30, hasAudio = true, width = 1080, height = 1920 } = {}) {
  const problems = [];
  const streams = data?.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data?.format?.duration);

  if (!video) problems.push(problem('render', 'no video stream'));
  else {
    if (video.codec_name !== 'h264') problems.push(problem('render', `video is ${video.codec_name}, not h264`));
    if (Number(video.width) !== width || Number(video.height) !== height) {
      problems.push(problem('render', `video is ${video.width}x${video.height}, not ${width}x${height}`));
    }
  }
  if (hasAudio) {
    if (!audio) problems.push(problem('render', 'audio stream missing'));
    else if (Number(audio.sample_rate) !== 48000) problems.push(problem('render', `audio at ${audio.sample_rate} Hz, not 48000`));
  }
  if (!Number.isFinite(duration)) problems.push(problem('render', 'no duration: the file is unreadable or truncated'));
  else if (Math.abs(duration - expectSeconds) > 1.5) {
    problems.push(problem('render', `${duration.toFixed(1)}s long, expected ${expectSeconds}s`));
  }
  return problems;
}

/**
 * Seconds of frozen, black and silent footage, and any decode errors, from
 * one ffmpeg pass's log. A detection still open when the file ends runs to
 * the end.
 */
export function parseChecks(log, duration) {
  const sum = { frozen: 0, black: 0, silent: 0, errors: [] };
  let freezeOpen = null;
  let silenceOpen = null;
  for (const line of String(log ?? '').split(/\r?\n/)) {
    const freezeStart = /freeze_start: *([\d.]+)/.exec(line);
    if (freezeStart) freezeOpen = Number(freezeStart[1]);
    const freeze = /freeze_duration: *([\d.]+)/.exec(line);
    if (freeze) {
      sum.frozen += Number(freeze[1]);
      freezeOpen = null;
    }
    const black = /black_duration: *([\d.]+)/.exec(line);
    if (black) sum.black += Number(black[1]);
    const silenceStart = /silence_start: *(-?[\d.]+)/.exec(line);
    if (silenceStart) silenceOpen = Math.max(0, Number(silenceStart[1]));
    const silence = /silence_duration: *([\d.]+)/.exec(line);
    if (silence) {
      sum.silent += Number(silence[1]);
      silenceOpen = null;
    }
    if (
      /error|corrupt|invalid data|non-existing|missing picture|concealing/i.test(line) &&
      !/freezedetect|blackdetect|silencedetect/.test(line)
    ) {
      sum.errors.push(line.trim());
    }
  }
  if (freezeOpen !== null && Number.isFinite(duration)) sum.frozen += Math.max(0, duration - freezeOpen);
  if (silenceOpen !== null && Number.isFinite(duration)) sum.silent += Math.max(0, duration - silenceOpen);
  return sum;
}

/** What is wrong with what is in the file. */
export function judgeChecks(checks, duration, { hasAudio = true } = {}) {
  const problems = [];
  if (checks.errors.length) problems.push(problem('render', `decode errors: ${checks.errors[0].slice(0, 120)}`));
  if (!(duration > 0)) return problems;
  if (checks.frozen / duration > MAX_FROZEN) problems.push(problem('content', `frozen for ${Math.round(checks.frozen)}s of ${Math.round(duration)}s`));
  if (checks.black / duration > MAX_BLACK) problems.push(problem('content', `black for ${Math.round(checks.black)}s of ${Math.round(duration)}s`));
  if (hasAudio && checks.silent >= duration - 0.5) problems.push(problem('content', 'no audible sound'));
  return problems;
}

/** Probe and fully decode a finished short. {ok, problems, retry, duration}. */
export async function validateShort(path, { expectSeconds = 30, hasAudio = true } = {}) {
  let data = null;
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate:format=duration',
        '-of', 'json',
        path,
      ],
      { cwd: config.root, label: 'ffprobe' },
    );
    data = JSON.parse(stdout);
  } catch (err) {
    const problems = [problem('render', `unreadable: ${String(err.message).split(/\r?\n/)[0]}`)];
    return { ok: false, problems, retry: true, duration: null };
  }

  const duration = Number(data?.format?.duration);
  const problems = judgeStreams(data, { expectSeconds, hasAudio });

  // One full decode: finds corrupt frames, and measures freeze, black and
  // silence on the way through.
  try {
    const { stderr } = await run(
      'ffmpeg',
      [
        '-hide_banner', '-nostdin', '-v', 'info', '-i', path,
        '-vf', 'freezedetect=n=0.003:d=2,blackdetect=d=1:pix_th=0.1',
        ...(hasAudio ? ['-af', 'silencedetect=n=-50dB:d=2'] : ['-an']),
        '-f', 'null', '-',
      ],
      { cwd: config.root, label: 'ffmpeg' },
    );
    problems.push(...judgeChecks(parseChecks(stderr, duration), duration, { hasAudio }));
  } catch (err) {
    problems.push(problem('render', `does not decode: ${String(err.message).split(/\r?\n/)[0]}`));
  }

  return {
    ok: problems.length === 0,
    problems,
    // Worth rendering again only if every fault is the render's own.
    retry: problems.length > 0 && problems.every((p) => p.kind === 'render'),
    duration,
  };
}
