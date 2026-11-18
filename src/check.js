// One-shot smoke test.
//
//   npm run check
//
// With credentials: resolve the category, count live channels, pull the clip
// window, and print the moments it clusters into.
//
// Without credentials: listen to the watch list's chat and print the moments
// it nominates, live. That is the half of detection needing no token, and the
// only half that can fire before anybody has clipped — so it is worth being
// able to run on its own.

import { ChatWatcher, THRESHOLDS } from './chat.js';
import { chatOnlyPossible, config, credentialsMissing } from './config.js';
import { chatCandidateMoments, clusterClips, scoreMoments } from './moments.js';
import { Twitch } from './twitch.js';

const pad = (value, width) => String(value).padEnd(width);

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
};

/** The reaction classes that actually fired, loudest first. */
function topClasses(chat, limit = 3) {
  const classes = chat?.classes || {};
  return Object.entries(classes)
    .filter(([, value]) => (value?.count || 0) > 0)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, limit)
    .map(([name, value]) => `${name} x${value.count}`)
    .join(' ');
}

/**
 * Watch chat and report what it nominates.
 *
 * Deliberately prints nothing clever during the first minute. The baseline is
 * a rolling median and needs about that long to mean anything, so a score
 * before then would be noise dressed as a finding. The heartbeat exists to
 * prove messages are arriving while that happens.
 */
async function watchChat(seconds) {
  const logins = config.watchChannels;

  console.log('');
  console.log(`no credentials - listening to ${logins.length} channels' chat`);
  console.log('');
  console.log(`  ${logins.join(' ')}`);
  console.log('');
  console.log('  Chat is anonymous and unmetered, so this needs no token. What it');
  console.log('  cannot tell you is saturation - whether anybody already clipped');
  console.log('  the moment. That needs the API.');
  console.log('');
  console.log('  Nothing will score for the first ~60s: the baseline is a rolling');
  console.log(`  median and has to settle first. Watching for ${seconds}s.`);
  console.log('');

  // A chat-only moment knows the channel's name and nothing else. Stream
  // start, VOD id and viewer count all come from Helix, so they stay unset
  // and the deep link falls back to the live channel.
  const channels = new Map(logins.map((login) => [login, { displayName: login }]));

  const watcher = new ChatWatcher({ log: () => {} });
  watcher.setChannels(logins);
  watcher.start();

  const started = Date.now();
  const seen = new Set();
  let found = 0;

  /**
   * The high-water mark of every gate a spike has to clear.
   *
   * Without this a quiet run tells you nothing: "no spikes" could mean the
   * channels were calm, or that one threshold is set somewhere unreachable.
   * Maxima are safe to sample repeatedly, which rates and counts would not be.
   */
  const peak = {
    z: { value: 0, login: null },
    rise: { value: 0, login: null },
    messages: { value: 0, login: null },
    reaction: { value: 0, login: null },
    callout: { value: 0, z: 0, login: null },
  };

  const observe = () => {
    for (const [login, snap] of watcher.spikes()) {
      const messages = snap.messages || 0;
      const rise = snap.baseline > 0 ? messages / snap.baseline : 0;
      const callout = snap.classes?.clipit?.count || 0;

      if ((snap.z || 0) > peak.z.value) peak.z = { value: snap.z, login };
      if (rise > peak.rise.value) peak.rise = { value: rise, login };
      if (messages > peak.messages.value) peak.messages = { value: messages, login };
      if ((snap.reaction || 0) > peak.reaction.value) {
        peak.reaction = { value: snap.reaction, login };
      }
      if (callout > peak.callout.value) {
        peak.callout = { value: callout, z: snap.classes?.clipit?.z || 0, login };
      }
    }
  };

  const calibration = () => {
    const row = (label, login, measured, threshold) =>
      `    ${pad(label, 20)}${pad(login || '-', 16)}${pad(measured, 14)}${threshold}`;

    console.log('  the closest anything came, per gate:');
    console.log('');
    console.log(row('volume z', peak.z.login, peak.z.value.toFixed(1), `needs ${THRESHOLDS.spikeZ}`));
    console.log(
      row(
        'rise over median',
        peak.rise.login,
        `${peak.rise.value.toFixed(2)}x`,
        `needs ${THRESHOLDS.minRise}x`,
      ),
    );
    console.log(
      row(
        'messages / bucket',
        peak.messages.login,
        String(peak.messages.value),
        `needs ${THRESHOLDS.floorMessages}`,
      ),
    );
    console.log(
      row(
        'clip calls',
        peak.callout.login,
        `${peak.callout.value} (z ${peak.callout.z.toFixed(1)})`,
        `needs ${THRESHOLDS.calloutMinimum} and z ${THRESHOLDS.spikeZ}`,
      ),
    );
    console.log('');
    console.log(
      `    loudest reaction overall: ${peak.reaction.login || '-'} ${peak.reaction.value.toFixed(1)}`,
    );
    console.log('');
    console.log('  The volume path needs the first three at once. Whichever column');
    console.log('  stayed furthest short is the one to move.');
  };

  const report = () => {
    const now = Date.now();
    observe();
    const moments = scoreMoments(
      chatCandidateMoments(watcher.candidates({ now }), { channels }),
      { now, leadInSeconds: config.leadInSeconds },
    );

    for (const moment of moments) {
      if (seen.has(moment.id)) continue;
      seen.add(moment.id);
      found += 1;

      const classes = topClasses(moment.chat);
      const copypasta = moment.chat?.copypasta
        ? `  ${Math.round(moment.chat.copypasta * 100)}% copypasta`
        : '';
      const shared = moment.shared ? '  (whole list spiked)' : '';

      console.log(
        `  [${clock(now - started)}]  ${pad(moment.broadcaster, 20)}reaction ${pad(moment.reaction, 7)}${classes}${copypasta}${shared}`,
      );
      console.log(`            ${moment.deepLink}`);
    }
  };

  const heartbeat = () => {
    const now = Date.now();
    const status = watcher.status();

    let loudest = null;
    for (const [login, snap] of watcher.spikes()) {
      const rate = snap.messagesPerSecond || 0;
      if (!loudest || rate > loudest.rate) loudest = { login, rate };
    }

    const busiest = loudest ? `  busiest ${loudest.login} ${loudest.rate.toFixed(1)}/s` : '';
    const warming = now - started < 70_000 ? '  warming up' : '';

    console.log(
      `  [${clock(now - started)}]  ${status.channels} ch - ${status.connectedShards}/${status.shards} shards${busiest}  spiking ${status.spiking}${warming}`,
    );
  };

  const reporter = setInterval(report, 2000);
  const pulse = setInterval(heartbeat, 15_000);

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

  clearInterval(reporter);
  clearInterval(pulse);
  report();
  watcher.stop();

  console.log('');
  if (found) {
    console.log(`  ${found} moment(s) nominated by chat in ${seconds}s.`);
    console.log('  None is confirmed - nobody has clipped them, which is the point.');
    console.log('  Some will be nothing. That is the price of being first.');
    console.log('');
    calibration();
  } else {
    console.log(`  Nothing crossed the threshold in ${seconds}s.`);
    console.log('');
    calibration();
    console.log('');
    console.log('  Tune a gate with CHAT_SPIKE_Z / CHAT_MIN_RISE / CHAT_FLOOR_MESSAGES');
    console.log('  in .env, or just watch for longer:  npm run check -- 600');
  }
  console.log('');
}

async function fullCheck() {
  const twitch = new Twitch({ log: (m) => console.log(`  ${m}`) });

  console.log('');
  console.log('resolving category...');
  const game = config.gameId
    ? await twitch.gameById(config.gameId)
    : await twitch.resolveGame(config.gameName);
  console.log(`  ${game.name} (id ${game.id})`);

  console.log('');
  console.log('live channels...');
  const streams = await twitch.liveStreams(game.id, 100);
  const viewers = streams.reduce((n, s) => n + (s.viewer_count || 0), 0);
  console.log(`  ${streams.length} live, ${viewers.toLocaleString()} viewers`);
  for (const stream of streams.slice(0, 5)) {
    console.log(`    ${pad(stream.user_name, 24)} ${stream.viewer_count.toLocaleString()}`);
  }

  const now = Date.now();
  const startedAt = new Date(now - config.clipWindowMinutes * 60_000).toISOString();
  console.log('');
  console.log(`clips in the last ${config.clipWindowMinutes} min...`);
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

  const counts = { early: 0, fresh: 0, warm: 0, flooded: 0 };
  for (const moment of moments) counts[moment.state] += 1;

  console.log('');
  console.log(
    `${moments.length} moments  (early ${counts.early}, fresh ${counts.fresh}, warm ${counts.warm}, flooded ${counts.flooded})`,
  );
  console.log('');
  console.log(`  ${pad('sat', 5)}${pad('state', 9)}${pad('broadcaster', 22)}link`);
  for (const moment of moments.slice(0, 15)) {
    console.log(
      `  ${pad(moment.saturation, 5)}${pad(moment.state, 9)}${pad(moment.broadcaster, 22)}${moment.deepLink}`,
    );
  }

  if (!clips.length) {
    console.log('');
    console.log('  No clips in the window. Either the category is quiet right now,');
    console.log('  or the game has not launched yet. Both are expected before release.');
  }
  console.log('');
}

async function main() {
  if (!credentialsMissing) {
    await fullCheck();
    return;
  }

  if (!chatOnlyPossible) {
    console.error('');
    console.error('Nothing to watch.');
    console.error('  Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env');
    console.error('  (register an app at https://dev.twitch.tv/console/apps),');
    console.error('  or set WATCH_CHANNELS=name,name to run chat-only.');
    console.error('');
    process.exitCode = 1;
    return;
  }

  const requested = Number(process.argv[2]);
  await watchChat(requested > 0 ? requested : 120);
}

main().catch((err) => {
  console.error('');
  console.error(`${err.name}: ${err.message}`);
  if (err.body) console.error(err.body);
  process.exitCode = 1;
});
