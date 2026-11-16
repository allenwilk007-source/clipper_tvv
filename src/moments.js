// Turning raw clips into moments, and moments into a ranked feed.
//
// The whole product lives in this file. A native Twitch clip is a *costly*
// signal: someone watched something, decided it was worth keeping, and acted.
// Cluster those by broadcaster and position in the VOD and two things fall out
// of the same data at once:
//
//   * a cluster forming  = a moment happened
//   * the cluster's size = how many clippers already have it
//
// The second number is the one nothing else in the market shows.

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** FRESH is the whole point: hot, and nobody else is on it yet. */
export function saturationState(saturation) {
  if (saturation <= 2) return 'fresh';
  if (saturation <= 6) return 'warm';
  return 'flooded';
}

function formatTimestamp(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
}

function buildMoment(clips, basis) {
  const byTime = [...clips].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  const first = byTime[0];
  const last = byTime[byTime.length - 1];
  const firstAt = Date.parse(first.created_at);
  const lastAt = Date.parse(last.created_at);

  const offsets = clips.map((c) => c.vod_offset).filter((v) => Number.isFinite(v));
  const offsetSeconds = offsets.length ? Math.min(...offsets) : null;

  return {
    id: `${first.broadcaster_id}:${basis}:${offsetSeconds ?? first.created_at}`,
    broadcasterId: first.broadcaster_id || null,
    broadcaster: first.broadcaster_name || 'unknown',
    basis,
    vodId: first.video_id || null,
    offsetSeconds,
    saturation: clips.length,
    uniqueClippers: new Set(clips.map((c) => c.creator_name).filter(Boolean)).size,
    firstClipper: first.creator_name || null,
    firstClipAt: new Date(firstAt).toISOString(),
    lastClipAt: new Date(lastAt).toISOString(),
    spanMinutes: round((lastAt - firstAt) / 60000),
    clipViews: clips.reduce((total, c) => total + (c.view_count || 0), 0),
    title: first.title || '',
    thumbnail: first.thumbnail_url || null,
    exampleClipUrl: first.url || null,
  };
}

/**
 * Single-linkage cluster per broadcaster: a clip joins the run while it lands
 * within `gapSeconds` of the previous one, so a long moment stays one moment
 * instead of fragmenting on a fixed grid.
 *
 * Clips whose VOD position isn't published yet (it lags by a minute or two on
 * a live stream) fall back to clustering on creation time, which is coarser
 * but keeps the freshest moments in the feed rather than dropping them.
 */
export function clusterClips(clips, { gapSeconds = 30 } = {}) {
  const byBroadcaster = new Map();
  for (const clip of clips) {
    const key = clip.broadcaster_id || clip.broadcaster_name || 'unknown';
    let bucket = byBroadcaster.get(key);
    if (!bucket) {
      bucket = [];
      byBroadcaster.set(key, bucket);
    }
    bucket.push(clip);
  }

  const moments = [];

  const flush = (run, basis) => {
    if (run.length) moments.push(buildMoment(run, basis));
  };

  for (const list of byBroadcaster.values()) {
    const positioned = [];
    const unpositioned = [];
    for (const clip of list) {
      if (Number.isFinite(clip.vod_offset) && clip.video_id) positioned.push(clip);
      else unpositioned.push(clip);
    }

    positioned.sort((a, b) => a.vod_offset - b.vod_offset);
    let run = [];
    for (const clip of positioned) {
      const prev = run[run.length - 1];
      if (!prev || clip.vod_offset - prev.vod_offset <= gapSeconds) run.push(clip);
      else {
        flush(run, 'vod');
        run = [clip];
      }
    }
    flush(run, 'vod');

    unpositioned.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    run = [];
    for (const clip of unpositioned) {
      const prev = run[run.length - 1];
      const gap = prev ? (Date.parse(clip.created_at) - Date.parse(prev.created_at)) / 1000 : 0;
      if (!prev || gap <= gapSeconds) run.push(clip);
      else {
        flush(run, 'created');
        run = [clip];
      }
    }
    flush(run, 'created');
  }

  return moments;
}

function deepLink(moment, leadInSeconds) {
  if (moment.vodId && Number.isFinite(moment.offsetSeconds)) {
    const start = Math.max(0, moment.offsetSeconds - leadInSeconds);
    return `https://www.twitch.tv/videos/${moment.vodId}?t=${formatTimestamp(start)}`;
  }
  if (moment.exampleClipUrl) return moment.exampleClipUrl;
  return `https://www.twitch.tv/${moment.broadcaster}`;
}

/**
 * Rank by opportunity, not by heat.
 *
 * Heat alone just rediscovers the moments everyone already has, which is the
 * one thing this feed exists not to do.
 *
 * The subtlety: clip velocity IS saturation divided by span, so feeding raw
 * velocity into the numerator and dividing by saturation lets the two cancel —
 * the score then quietly climbs with clip count, exactly backwards. Taking the
 * log of velocity breaks that. Log says "this moment is provably interesting"
 * while growing far too slowly to out-argue the crowding penalty below it, so
 * more clippers on a moment always lowers its rank.
 *
 * Chat enters the numerator raw, because it is the one signal that is
 * independent of how many people have already clipped.
 */
export function scoreMoments(
  moments,
  {
    now = Date.now(),
    chatSpikes = new Map(),
    streams = new Map(),
    previous = new Map(),
    leadInSeconds = 20,
  } = {},
) {
  return moments
    .map((moment) => {
      const ageMinutes = (now - Date.parse(moment.firstClipAt)) / 60000;
      const sinceLastClip = (now - Date.parse(moment.lastClipAt)) / 60000;

      // Floor the span so a two-clip burst in the same second doesn't read as
      // infinite velocity.
      const clipsPerMinute = moment.saturation / Math.max(moment.spanMinutes, 0.75);

      const login = moment.broadcaster.toLowerCase();
      const chat = chatSpikes.get(login) || null;
      const chatZ = chat && Number.isFinite(chat.z) ? Math.max(chat.z, 0) : 0;

      const stream = streams.get(moment.broadcasterId) || null;
      const before = previous.get(moment.id);
      const newClips = before ? Math.max(moment.saturation - before, 0) : moment.saturation;

      const recency = Math.exp(-Math.max(sinceLastClip, 0) / 12);
      const heat = Math.log1p(clipsPerMinute) * 2 + chatZ;
      const opportunity = (heat * recency) / (1 + moment.saturation) ** 0.9;

      return {
        ...moment,
        ageMinutes: round(ageMinutes, 1),
        minutesSinceLastClip: round(sinceLastClip, 1),
        clipsPerMinute: round(clipsPerMinute),
        newClips,
        chat,
        chatZ: round(chatZ),
        viewers: stream?.viewer_count ?? null,
        streamTitle: stream?.title ?? null,
        state: saturationState(moment.saturation),
        deepLink: deepLink(moment, leadInSeconds),
        opportunity: round(opportunity, 4),
      };
    })
    .sort((a, b) => b.opportunity - a.opportunity);
}
