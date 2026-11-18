// Where a live channel is recording to, found without Twitch credentials.
//
// Without an app token there is no Helix, so no stream start and no VOD id,
// and a moment found in chat could be watched but never cut. yt-dlp answers
// both questions anonymously, in two calls per broadcast:
//
//   1. the channel's newest archive id
//   2. that archive's live_status and timestamp
//
// The newest archive is only trusted while it is still RECORDING. A streamer
// with archiving switched off has an old VOD at the top of the list, and
// cutting at "today's offset" into yesterday's broadcast is a random clip,
// not this moment. Measured on a live channel: the current archive reported
// is_live, its timestamp came 5s after the stream went live (the VOD's own
// zero point, which is what offsets are measured from), and its duration
// matched wall-clock time to within 3s. A finished archive reported was_live.

import { run, splitCommand } from './clip.js';
import { config } from './config.js';

const LOGIN = /^[a-z0-9_]{1,25}$/;

/**
 * An archive is usable only while it is recording the broadcast in progress.
 *
 * yt-dlp names archives `v2932444934`; Helix, and so everything downstream,
 * uses the bare `2932444934`. Left as-is, the deep link came out as
 * twitch.tv/videos/v... — so the id is normalised here, once.
 */
export function liveArchiveFrom({ id, timestamp, liveStatus }) {
  const raw = String(id || '').trim();
  if (liveStatus !== 'is_live' || !/^v?\d+$/.test(raw)) return null;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return { vodId: raw.replace(/^v/, ''), startedAt: timestamp * 1000 };
}

/** {vodId, startedAt(ms)} for the recording in progress, or null. */
export async function findLiveArchive(login) {
  const name = String(login || '').toLowerCase();
  if (!LOGIN.test(name)) return null;
  const { file, prefix } = splitCommand(config.ytdlpCmd);
  const first = async (args) =>
    (await run(file, [...prefix, ...args], { cwd: config.root, label: 'yt-dlp' })).stdout
      .trim()
      .split(/\r?\n/)[0] || '';

  const id = await first([
    '--flat-playlist',
    '--playlist-end',
    '1',
    '--print',
    '%(id)s',
    `https://www.twitch.tv/${name}/videos?filter=archives&sort=time`,
  ]);
  if (!/^v?\d+$/.test(id)) return null;

  const [timestamp, liveStatus] = (
    await first([
      '--print',
      '%(timestamp)s|%(live_status)s',
      `https://www.twitch.tv/videos/${id.replace(/^v/, '')}`,
    ])
  ).split('|');
  return liveArchiveFrom({ id, timestamp: Number(timestamp), liveStatus });
}
