// Does stream audio actually lead chat?
//
//   node src/audiolag.js [--db <path>] [--limit N] [--window 30]
//
// The whole case for probing audio rests on one claim: that the loud part of a
// moment happens BEFORE chat finishes reacting to it. That claim is cheap to
// state and easy to believe, which is exactly why it needs a test that can
// come back negative.
//
// The test: take moments chat nominated, fetch a window of audio centred on
// the nominated offset, and record where the loudest point fell.
//
// The window is SYMMETRIC on purpose. Centring it means that if audio and chat
// were unrelated — the peak landing wherever game noise happened to put it —
// the peak would fall before the chat offset about half the time. So 50% is
// the number to beat, and an asymmetric window would have manufactured the
// result instead of testing it.
//
// Samples on one VOD within MIN_SEPARATION of each other are dropped, because
// overlapping windows can share the same peak and would count one piece of
// evidence twice.

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

import { probeLoudnessAt } from './audio.js';
import { config } from './config.js';

const MIN_SEPARATION = 120;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

/** Chat-nominated moments that can actually be probed, spread across VODs. */
function loadMoments(dbPath, limit) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `select broadcaster, vod_id, offset_seconds, first_clip_at
         from moments
        where vod_id is not null
          and offset_seconds is not null
          and source = 'chat'
        order by first_clip_at desc`,
    )
    .all();
  db.close();

  const kept = [];
  const byVod = new Map();
  for (const row of rows) {
    const taken = byVod.get(row.vod_id) || [];
    if (taken.some((offset) => Math.abs(offset - row.offset_seconds) < MIN_SEPARATION)) continue;
    taken.push(row.offset_seconds);
    byVod.set(row.vod_id, taken);
    kept.push(row);
    if (kept.length >= limit) break;
  }
  return kept;
}

function histogram(lags, windowSeconds) {
  const width = 10;
  const buckets = new Map();
  for (const lag of lags) {
    const bucket = Math.floor(lag / width) * width;
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const max = Math.max(...buckets.values(), 1);
  console.log('');
  console.log('  lag = chat offset minus audio peak (positive means audio came first)');
  console.log('');
  for (const key of keys) {
    const count = buckets.get(key);
    const label = `${key >= 0 ? '+' : ''}${key}..${key + width}s`;
    console.log(`    ${label.padStart(12)}  ${'#'.repeat(Math.round((count / max) * 40))} ${count}`);
  }
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function main() {
  const dbPath = resolve(arg('db', config.storePath));
  const limit = Number(arg('limit', 40));
  const half = Number(arg('window', 30));

  const moments = loadMoments(dbPath, limit);
  console.log('');
  console.log(`testing ${moments.length} chat-nominated moments from ${dbPath}`);
  console.log(`window: ${half}s either side, so a peak lands before the chat offset`);
  console.log('by chance 50% of the time. That is the number to beat.');
  console.log('');

  const lags = [];
  const zs = [];
  let failed = 0;

  for (const [index, moment] of moments.entries()) {
    // Sequential, never parallel: four concurrent yt-dlp/ffmpeg pairs is
    // enough to make Windows stop creating processes altogether.
    const result = await probeLoudnessAt({
      vodId: moment.vod_id,
      offsetSeconds: moment.offset_seconds,
      before: half,
      after: half,
    });

    if (!result.ok || !result.peak) {
      failed += 1;
      console.log(
        `  ${String(index + 1).padStart(3)}. ${moment.broadcaster.padEnd(18)} skipped — ${result.reason}`,
      );
      continue;
    }

    const { lag, z, loudness, median: med } = result.peak;
    lags.push(lag);
    if (Number.isFinite(z)) zs.push(z);
    console.log(
      `  ${String(index + 1).padStart(3)}. ${moment.broadcaster.padEnd(18)}` +
        `lag ${String(lag).padStart(6)}s   peak ${String(loudness).padStart(6)} LUFS   ` +
        `median ${String(med).padStart(6)}   z ${z === null ? '   -' : String(z).padStart(5)}`,
    );
  }

  if (!lags.length) {
    console.log('');
    console.log('  No probes succeeded, so there is nothing to conclude.');
    return;
  }

  const leading = lags.filter((lag) => lag > 0).length;
  const share = leading / lags.length;
  // Normal approximation to the binomial under p = 0.5. Rough, but enough to
  // tell "clearly more than half" from "could easily be chance".
  const sigma = Math.sqrt(0.25 / lags.length);
  const sigmas = (share - 0.5) / sigma;

  histogram(lags, half);

  console.log('');
  console.log(`  probed ${lags.length}${failed ? `, ${failed} failed` : ''}`);
  console.log(`  audio peak came first in ${leading}/${lags.length} (${Math.round(share * 100)}%)`);
  console.log(`  that is ${sigmas.toFixed(1)} sigma from the 50% a coin would give`);
  console.log(`  median lag ${median(lags)}s · median peak z ${median(zs) ?? '-'}`);
  console.log('');

  if (sigmas < 2) {
    console.log('  NOT SHOWN. This is consistent with the audio peak falling wherever');
    console.log('  game noise put it. Centring a cut on it would be superstition.');
  } else if ((median(zs) ?? 0) < 2) {
    console.log('  Audio leads chat more often than chance, but the peaks are shallow');
    console.log('  against their own background, so the position is real and the');
    console.log('  confidence per moment is not. Usable as a nudge, not as a verdict.');
  } else {
    console.log('  Audio leads chat, and the peaks stand clear of their background.');
    console.log('  Worth handing the cut point downstream.');
  }
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error(`${err.name}: ${err.message}`);
  process.exitCode = 1;
});
