// Does audio loudness know anything, or is it just noise?
//
//   node src/audiocontrol.js [--db <path>] [--pairs N] [--window 30]
//
// audiolag.js asked where the audio peak sits relative to chat. This asks the
// prior question: whether the audio around a chat-nominated moment looks any
// different from the audio anywhere else in the same stream.
//
// The design is a matched pair. For every moment chat nominated, a second
// probe is taken at a random offset in the SAME VOD, far enough away to be a
// different part of the broadcast. Both are measured identically. Then the
// only question is how often the nominated one stands higher above its own
// background than the control does.
//
// Under the null — audio carrying no information about moments — that is a
// coin flip. So 50% is again the number to beat, and the comparison being
// paired means the usual confounds cancel: same streamer, same game, same
// microphone, same mix, same night.
//
// This cannot tell you whether a moment was worth clipping; nothing here can,
// without clip outcomes. It can tell you whether audio is measuring anything
// at all, which is the question that has to pass first.

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { probeLoudnessAt } from './audio.js';
import { config } from './config.js';

// A control has to be a different part of the broadcast. Too close and it
// lands inside the same event, which would be testing the probe against
// itself.
const MIN_GAP = 300;
const MIN_SEPARATION = 120;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function loadMoments(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `select broadcaster, vod_id, offset_seconds
         from moments
        where vod_id is not null and offset_seconds is not null and source = 'chat'
        order by first_clip_at desc`,
    )
    .all();
  db.close();
  return rows;
}

/**
 * A random offset in the same VOD that is not near any nominated moment.
 *
 * Bounded by the largest offset actually observed on that VOD rather than by
 * its true length, because an offset past the end downloads nothing and a
 * failed probe is not a control. Everything below a known-good offset exists.
 */
export function pickControl(offsets, random = Math.random) {
  const ceiling = Math.max(...offsets);
  if (ceiling < MIN_GAP * 2) return null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = Math.round(60 + random() * (ceiling - 60));
    if (offsets.every((offset) => Math.abs(offset - candidate) >= MIN_GAP)) return candidate;
  }
  return null;
}

/** Independent moments, as in audiolag.js: overlapping windows are one sample. */
function independent(rows, limit) {
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

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100;
};

async function main() {
  const dbPath = resolve(arg('db', config.storePath));
  const pairs = Number(arg('pairs', 30));
  const half = Number(arg('window', 30));

  const rows = loadMoments(dbPath);
  const offsetsByVod = new Map();
  for (const row of rows) {
    if (!offsetsByVod.has(row.vod_id)) offsetsByVod.set(row.vod_id, []);
    offsetsByVod.get(row.vod_id).push(row.offset_seconds);
  }

  const moments = independent(rows, pairs);

  console.log('');
  console.log(`matched pairs from ${dbPath}`);
  console.log('each nominated moment is compared with a random offset in the SAME VOD,');
  console.log(`at least ${MIN_GAP}s away. Under the null that is a coin flip, so 50% is`);
  console.log('the number to beat.');
  console.log('');

  const nominatedZ = [];
  const controlZ = [];
  let wins = 0;
  let usable = 0;
  let skipped = 0;

  for (const [index, moment] of moments.entries()) {
    const control = pickControl(offsetsByVod.get(moment.vod_id) || [moment.offset_seconds]);
    if (control === null) {
      skipped += 1;
      continue;
    }

    // Sequential. Concurrency here is what broke process creation earlier.
    const hit = await probeLoudnessAt({
      vodId: moment.vod_id,
      offsetSeconds: moment.offset_seconds,
      before: half,
      after: half,
    });
    const miss = await probeLoudnessAt({
      vodId: moment.vod_id,
      offsetSeconds: control,
      before: half,
      after: half,
    });

    if (!hit.ok || !miss.ok || hit.peak?.z == null || miss.peak?.z == null) {
      skipped += 1;
      console.log(`  ${String(index + 1).padStart(3)}. ${moment.broadcaster.padEnd(16)} skipped`);
      continue;
    }

    usable += 1;
    nominatedZ.push(hit.peak.z);
    controlZ.push(miss.peak.z);
    const won = hit.peak.z > miss.peak.z;
    if (won) wins += 1;

    console.log(
      `  ${String(index + 1).padStart(3)}. ${moment.broadcaster.padEnd(16)}` +
        `moment z ${String(hit.peak.z).padStart(6)}   control z ${String(miss.peak.z).padStart(6)}` +
        `   ${won ? 'moment louder' : '.'}`,
    );
  }

  if (!usable) {
    console.log('');
    console.log('  No usable pairs, so there is nothing to conclude.');
    return;
  }

  const share = wins / usable;
  const sigmas = (share - 0.5) / Math.sqrt(0.25 / usable);

  console.log('');
  console.log(`  ${usable} pairs${skipped ? `, ${skipped} skipped` : ''}`);
  console.log(`  the nominated moment was the louder of the pair in ${wins}/${usable} (${Math.round(share * 100)}%)`);
  console.log(`  that is ${sigmas.toFixed(1)} sigma from a coin flip`);
  console.log(`  median z at nominated moments ${median(nominatedZ)} · at random offsets ${median(controlZ)}`);
  console.log('');

  if (sigmas < 2) {
    console.log('  NOT SHOWN. Audio around a nominated moment looks like audio anywhere');
    console.log('  else in the same stream. As a ranking signal it would be adding a');
    console.log('  random number to the score. Do not wire it in.');
  } else {
    console.log('  Audio around a nominated moment is measurably louder than elsewhere in');
    console.log('  the same stream, and the comparison is paired so the streamer, game and');
    console.log('  mix are held constant. It is detecting something chat also noticed.');
    console.log('  That still is not evidence it detects moments worth CLIPPING — only');
    console.log('  clip outcomes can show that — but it earns a place in the ranking.');
  }
  console.log('');
}

// Only run when invoked as a script. Without this, importing the module to
// test one of its pure helpers starts the whole experiment — which is how the
// first version of audiocontrol.test.js came to spawn yt-dlp.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('');
    console.error(`${err.name}: ${err.message}`);
    process.exitCode = 1;
  });
}
