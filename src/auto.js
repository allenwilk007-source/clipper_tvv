// npm run auto
//
// Channel automation with no page open: the feed and the automation the web
// server runs, headless and switched on, until stopped. Finished shorts land
// in clips/ready/ as an .mp4 with a .txt of post copy beside it.
//
// It uses the same channels as the panel (data/automation.json). Run it
// instead of `npm start`, not beside it: each starts its own feed, and two
// feeds spend the Twitch rate limit — and the chat sockets — twice.

import { join, relative } from 'node:path';

import { credentialsMissing, root } from './config.js';
import { Automation } from './automation.js';
import { clipQueueStatus } from './clipjobs.js';
import { Feed } from './feed.js';
import { acquireLock, lockMessage } from './lock.js';
import { Uploader } from './uploader.js';

const SUMMARY_MS = 10 * 60_000;

// One copy at a time: see lock.js for what happened when there were three.
const LOCK_PATH = join(root, 'data', 'app.lock');
const lock = acquireLock(LOCK_PATH, { name: 'npm run auto' });
if (!lock.ok) {
  console.error(`\n  ${lockMessage(lock.holder, LOCK_PATH)}\n`);
  process.exit(1);
}
process.on('exit', () => lock.release());

const feed = new Feed();
const automation = new Automation({ feed, log: feed.log });
// Headless means nobody is there to flip the switch.
automation.settings.enabled = true;
// Uploads keep the mode set in the page (data/uploads.json): off unless chosen.
const uploader = new Uploader({ store: feed.store, dir: automation.dir, log: feed.log });

function summary() {
  const { done, failed, queued, lastHour, skipped } = automation.clipper.status();
  const queue = clipQueueStatus();
  const reasons = Object.entries(skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  feed.log(
    `autocollect: ${done} ready, ${failed} failed, ${queued - done - failed} in progress ` +
      `(${queue.running} running, ${queue.queued} waiting) · ${lastHour} cut in the last hour` +
      (reasons ? ` · last poll passed over: ${reasons}` : '') +
      (automation.health.level !== 'ok' ? ` · WARNING: ${automation.health.message}` : ''),
  );
}

async function main() {
  automation.prepare();
  feed.log(
    `autocollect: ${automation.settings.channels.length} channel(s), finished shorts go to ` +
      relative(root, automation.dir),
  );

  try {
    await feed.start();
  } catch (err) {
    console.error(`\n  Could not start the feed: ${err.message}`);
    if (credentialsMissing) {
      console.error('  No Twitch credentials, and the chat-only path could not start either.');
      console.error('  Check WATCH_CHANNELS in .env, or see the README.\n');
    }
    feed.stop();
    process.exit(1);
  }

  automation.start();
  await uploader.load();
  uploader.start();
  feed.log(`upload: YouTube is ${uploader.settings.youtube.mode}`);
  setInterval(summary, SUMMARY_MS);
}

const shutdown = () => {
  summary();
  uploader.stop();
  automation.stop();
  feed.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
