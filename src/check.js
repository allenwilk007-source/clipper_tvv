// One-shot smoke test: resolve the category, count live channels, pull the clip
// window, and print the moments it clusters into. No server, no chat sockets.
//
//   npm run check

import { config, credentialsMissing } from './config.js';
import { clusterClips, scoreMoments } from './moments.js';
import { Twitch } from './twitch.js';

const pad = (value, width) => String(value).padEnd(width);

async function main() {
  if (credentialsMissing) {
    console.error('\nMissing credentials.\n');
    console.error('  1. cp .env.example .env');
    console.error('  2. add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET');
    console.error('     register an app at https://dev.twitch.tv/console/apps\n');
    process.exitCode = 1;
    return;
  }

  const twitch = new Twitch({ log: (m) => console.log(`  ${m}`) });

  console.log('\nresolving category...');
  const game = config.gameId
    ? await twitch.gameById(config.gameId)
    : await twitch.resolveGame(config.gameName);
  console.log(`  ${game.name} (id ${game.id})`);

  console.log('\nlive channels...');
  const streams = await twitch.liveStreams(game.id, 100);
  const viewers = streams.reduce((n, s) => n + (s.viewer_count || 0), 0);
  console.log(`  ${streams.length} live, ${viewers.toLocaleString()} viewers`);
  for (const stream of streams.slice(0, 5)) {
    console.log(`    ${pad(stream.user_name, 24)} ${stream.viewer_count.toLocaleString()}`);
  }

  const now = Date.now();
  const startedAt = new Date(now - config.clipWindowMinutes * 60_000).toISOString();
  console.log(`\nclips in the last ${config.clipWindowMinutes} min...`);
  const { clips, pages, truncated } = await twitch.recentClips({
    gameId: game.id,
    startedAt,
    endedAt: new Date(now).toISOString(),
    maxPages: config.clipMaxPages,
  });
  console.log(`  ${clips.length} clips over ${pages} page(s)${truncated ? ' (TRUNCATED)' : ''}`);

  const streamMap = new Map(streams.map((s) => [s.user_id, s]));
  const moments = scoreMoments(clusterClips(clips, { gapSeconds: config.clusterGapSeconds }), {
    now,
    streams: streamMap,
    leadInSeconds: config.leadInSeconds,
  });

  const counts = { fresh: 0, warm: 0, flooded: 0 };
  for (const moment of moments) counts[moment.state] += 1;

  console.log(`\n${moments.length} moments  (fresh ${counts.fresh}, warm ${counts.warm}, flooded ${counts.flooded})\n`);
  console.log(`  ${pad('sat', 5)}${pad('state', 9)}${pad('broadcaster', 22)}link`);
  for (const moment of moments.slice(0, 15)) {
    console.log(
      `  ${pad(moment.saturation, 5)}${pad(moment.state, 9)}${pad(moment.broadcaster, 22)}${moment.deepLink}`,
    );
  }

  if (!clips.length) {
    console.log('\n  No clips in the window. Either the category is quiet right now,');
    console.log('  or the game has not launched yet. Both are expected before release.');
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\n${err.name}: ${err.message}`);
  if (err.body) console.error(err.body);
  process.exitCode = 1;
});
