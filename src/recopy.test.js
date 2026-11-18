// node --test src/recopy.test.js    (or: npm test)

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { recopy, recopyAll } from './recopy.js';

test("the game comes from the short's own record, never a default", () => {
  const fortnite = recopy({
    file: 'doble-1-t000000-x.mp4',
    saved: { caption: 'Doble in Fortnite 👀', game: 'Fortnite', broadcaster: 'Doble', link: 'https://x' },
  });
  assert.match(fortnite.platforms.tiktok, /#fortnite/);
  assert.ok(!/#gta/.test(Object.values(fortnite.platforms).join(' ')));
  assert.equal(fortnite.link, 'https://x');
  // And the ready-made YouTube copy carries it too.
  assert.match(fortnite.platforms.youtube, /Full stream: https:\/\/x/);

  // Nothing recorded about the game: no game tag at all.
  const unknown = recopy({ file: 'tarik-1-t000000-x.mp4', oldText: 'Wait what 😱\n\n#gta6 #gtavi #tarik\n' });
  const all = Object.values(unknown.platforms).join(' ');
  assert.ok(!/#gta|#fortnite/i.test(all), all);
  assert.match(all, /#tarik/);

  // The game id stored with its moment counts as a record.
  const byId = recopy({ file: 'a-1-t0-x.mp4', record: { caption: 'x 😂', broadcaster: 'a', gameId: '1867279146' } });
  assert.equal(byId.game, 'Grand Theft Auto VI');
});

test('a backfill rewrites the copy beside each video, and a bad one keeps its old copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recopy-'));
  await writeFile(join(dir, 'lirik-1-t000001-x.mp4'), 'VIDEO');
  await writeFile(
    join(dir, 'lirik-1-t000001-x.json'),
    JSON.stringify({ caption: '"Excuse me, put that down" 😂', game: 'Grand Theft Auto VI', broadcaster: 'lirik', link: 'https://l' }),
  );
  await writeFile(join(dir, 'lirik-1-t000001-x.txt'), 'old');
  await writeFile(join(dir, 'broken-1-t000002-x.mp4'), 'VIDEO');
  await writeFile(join(dir, 'broken-1-t000002-x.json'), '{ not json');
  await writeFile(join(dir, 'broken-1-t000002-x.txt'), 'old copy');

  const lines = [];
  const totals = await recopyAll({ dir, dbPath: join(dir, 'none.db'), log: (l) => lines.push(l) });
  assert.deepEqual(totals, { rewritten: 1, failed: 1, gameTagged: 1 });

  const text = await readFile(join(dir, 'lirik-1-t000001-x.txt'), 'utf8');
  assert.match(text, /^TIKTOK\n/);
  assert.match(text, /\nYOUTUBE\n.*#Shorts #GTA6/);
  assert.match(text, /Full stream: https:\/\/l/);
  // The video is untouched, the broken one's copy is as it was, no temp files.
  assert.equal(await readFile(join(dir, 'lirik-1-t000001-x.mp4'), 'utf8'), 'VIDEO');
  assert.equal(await readFile(join(dir, 'broken-1-t000002-x.txt'), 'utf8'), 'old copy');
  assert.ok(!(await readdir(dir)).some((f) => f.includes('tmp')));
  await rm(dir, { recursive: true, force: true });
});
