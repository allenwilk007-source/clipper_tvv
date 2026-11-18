// npm run recopy  — rewrite the post copy beside every short in clips/ready.
//
// For shorts made before the per-platform copy existed. Only the .txt and
// .json beside each video are rewritten; the video is never touched, and
// clips/rejected is never read. Each file is written to a temporary name and
// renamed over the old one, so a failure leaves the old copy as it was rather
// than an empty or half-written one.
//
// The game comes from what each short recorded about itself (its .json), or
// failing that the game id stored with its moment. Nothing is defaulted: a
// short whose game cannot be established gets no game tag.

import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { config } from './config.js';
import { describe, postPartsFor, postTextFor, reactionFromEmoji } from './shortform.js';

// Twitch's category ids for the two clipped games, as the feed polls them.
const GAME_BY_ID = { 1867279146: 'Grand Theft Auto VI', 33214: 'Fortnite' };

async function writeAtomically(path, text) {
  const temp = `${path}.recopy-tmp`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** What the store knows about each short, keyed by its file name. */
function recordsFromStore(dbPath) {
  if (!existsSync(dbPath)) return new Map();
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `select a.path, a.caption, a.broadcaster, a.vod_id as vodId, a.moment_id as id,
                  m.source, m.title, m.game_id as gameId
             from autoclips a left join moments m on m.id = a.moment_id
            where a.path is not null`,
        )
        .all();
      return new Map(rows.map((r) => [r.path.split(/[\\/]/).pop(), r]));
    } finally {
      db.close();
    }
  });
}

/** The copy for one short, from what it and the store recorded. */
export function recopy({ file, saved = null, record = null, oldText = '', avoid = [] }) {
  const caption = saved?.caption || record?.caption || oldText.split('\n')[0].trim();
  const game = saved?.game || GAME_BY_ID[record?.gameId] || null;
  const moment = {
    id: record?.id || file,
    source: record?.source || 'chat',
    title: record?.title || null,
    broadcaster: saved?.broadcaster || record?.broadcaster || file.split('-')[0],
    vodId: record?.vodId || null,
    game,
  };
  const reaction = reactionFromEmoji(caption);
  const about = describe(moment, { avoid, reaction });
  const parts = postPartsFor(moment, { caption, about, avoid, reaction });
  // The stream link was worked out when the short was made; keep it as it was.
  parts.link = saved?.link || /^Full stream: (\S+)/m.exec(oldText)?.[1] || '';
  return parts;
}

export async function recopyAll({ dir = join(config.root, 'clips', 'ready'), dbPath = join(config.root, 'data', 'feed.db'), log = console.log } = {}) {
  const records = await recordsFromStore(dbPath);
  const videos = (await readdir(dir)).filter((f) => f.endsWith('.mp4')).sort();
  const avoid = [];
  const totals = { rewritten: 0, failed: 0, gameTagged: 0 };
  for (const video of videos) {
    const stem = video.replace(/\.mp4$/, '');
    try {
      const jsonPath = join(dir, `${stem}.json`);
      const txtPath = join(dir, `${stem}.txt`);
      const saved = existsSync(jsonPath) ? JSON.parse(await readFile(jsonPath, 'utf8')) : null;
      const oldText = existsSync(txtPath) ? await readFile(txtPath, 'utf8') : '';
      const parts = recopy({ file: video, saved, record: records.get(video), oldText, avoid });
      avoid.push(parts.about);
      if (avoid.length > 80) avoid.shift();
      await writeAtomically(txtPath, postTextFor(null, { parts }));
      await writeAtomically(jsonPath, `${JSON.stringify(parts, null, 2)}\n`);
      totals.rewritten += 1;
      if (parts.game) totals.gameTagged += 1;
    } catch (err) {
      totals.failed += 1;
      log(`recopy: ${video} kept its old copy — ${err.message}`);
    }
  }
  log(
    `recopy: ${totals.rewritten} of ${videos.length} rewritten, ${totals.rewritten - totals.gameTagged} with no game known (no game tag)` +
      (totals.failed ? `, ${totals.failed} failed and kept their old copy` : ''),
  );
  return totals;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  recopyAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
