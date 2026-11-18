// npm run auto
//
// Channel automation with no page open: the feed and the automation the web
// server runs, headless and switched on, until stopped. Finished shorts land
// in clips/ready/ as an .mp4 with a .txt of post copy beside it.
//
// It uses the same channels as the panel (data/automation.json). Run it
// instead of `npm start`, not beside it: each starts its own feed, and two
// feeds spend the Twitch rate limit — and the chat sockets — twice.

import { relative } from 'node:path';

import { credentialsMissing, root } from './config.js';
import { Automation } from './automation.js';
import { clipQueueStatus } from './clipjobs.js';
import { Feed } from './feed.js';

const SUMMARY_MS = 10 * 60_000;

const feed = new Feed();
const automation = new Automation({ feed, log: feed.log });
// Headless means nobody is there to flip the switch.
automation.settings.enabled = true;

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
      (reasons ? ` · last poll passed over: ${reasons}` : ''),
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
  setInterval(summary, SUMMARY_MS);
}

const shutdown = () => {
  summary();
  automation.stop();
  feed.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
