// One copy of the app at a time.
//
// Measured today: three copies running at once (`npm run auto` and two
// `npm start`s) shared one database and one CPU. Up to six renders started
// together, Windows refused to start processes (exit 3221225794, 0xC0000142),
// and two copies cut the same lirik moment six seconds apart. So `npm start`
// and `npm run auto` each take this lock, and a second one refuses to start,
// naming the one already running.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Whether a process id belongs to a running process. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal.
    return err.code === 'EPERM';
  }
}

/**
 * Take the lock at `path`, or report who holds it. A lock left behind by a
 * copy that has since died is taken over, not obeyed.
 */
export function acquireLock(path, { pid = process.pid, name = 'app', alive = isAlive, now = () => new Date() } = {}) {
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    holder = null;
  }
  if (holder && holder.pid !== pid && alive(holder.pid)) return { ok: false, holder };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ pid, name, startedAt: now().toISOString() })}\n`);
  return {
    ok: true,
    took: holder && holder.pid !== pid ? holder : null,
    release() {
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).pid === pid) rmSync(path, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

/** What to tell someone who started a second copy. */
export function lockMessage(holder, path) {
  return [
    `Another copy is already running: ${holder.name || 'the app'} (process ${holder.pid}, started ${holder.startedAt}).`,
    'Two copies spend the Twitch limits twice, compete for the CPU and cut the same moments twice.',
    `Stop that one first. If nothing is actually running, delete ${path}.`,
  ].join('\n  ');
}
