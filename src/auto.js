// npm run auto
//
// The feed and autocollect together, headless, until stopped. Finished shorts
// land in clips/ready/ as an .mp4 with a .txt of post copy beside it.
//
// It is its own entry point rather than a flag on the web server so it can run
// unattended with nothing open. Do not run it alongside `npm start`: each
// starts its own feed, and two feeds spend the Twitch rate limit twice.

import { relative } from 'node:path';

import { credentialsMissing, root } from './config.js';
import { AutoClipper } from './autoclip.js';
import { clipQueueStatus } from './clipjobs.js';
import { Feed } from './feed.js';

const SUMMARY_MS = 10 * 60_000;

const feed = new Feed();
const auto = new AutoClipper({ store: feed.store, log: feed.log });

function summary() {
  const { done, failed, queued, lastHour, skipped } = auto.status();
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
  const remembered = auto.load();
  feed.log(
    `autocollect: finished shorts go to ${relative(root, auto.cfg.dir)}` +
      (remembered ? ` · ${remembered} earlier cut(s) remembered` : ''),
  );

  try {
    await feed.start();
  } catch (err) {
    console.error(`\n  Could not start the feed: ${err.message}`);
    if (credentialsMissing) {
      console.error('  TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are empty in .env.');
      console.error('  Register an app at https://dev.twitch.tv/console/apps — see the README.\n');
    }
    feed.stop();
    process.exit(1);
  }

  // The feed replaces its moments array on every poll, so a new array is a
  // new poll. Watching for that keeps this decoupled from how the feed
  // schedules itself.
  let seen = null;
  setInterval(() => {
    if (!feed.moments || feed.moments === seen) return;
    seen = feed.moments;
    auto.onPoll(feed.moments).catch((err) => feed.log(`autocollect: poll failed: ${err.message}`));
  }, 2000);

  setInterval(summary, SUMMARY_MS);
}

const shutdown = () => {
  summary();
  feed.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
