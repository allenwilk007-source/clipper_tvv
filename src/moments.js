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

/**
 * FRESH is the whole point: hot, and nobody else is on it yet.
 *
 * EARLY is better still and is new: zero clips, because chat gave the moment
 * away before anyone acted on it. It is also the only state that can be wrong
 * about a moment existing at all, which is why the UI never lets it pretend to
 * be confirmed.
 */
export function saturationState(saturation) {
  if (saturation <= 0) return 'early';
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

// Twitch's default clip length, used when a clip arrives without its duration.
const DEFAULT_CLIP_SECONDS = 30;

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

  // Where people REACTED, which is what a cut has to be built around. Twitch's
  // vod_offset is where a clip STARTS; the clipper pressed the button at its
  // END, after the thing happened. Cutting around the start lands in the
  // lead-up and can miss the moment entirely. The earliest end is the
  // earliest reaction, so it is the one closest to the moment itself.
  const ends = clips
    .filter((c) => Number.isFinite(c.vod_offset))
    .map((c) => c.vod_offset + (Number(c.duration) > 0 ? Number(c.duration) : DEFAULT_CLIP_SECONDS));
  const reactionOffsetSeconds = ends.length ? Math.round(Math.min(...ends)) : null;

  return {
    id: `${first.broadcaster_id}:${basis}:${offsetSeconds ?? first.created_at}`,
    broadcasterId: first.broadcaster_id || null,
    broadcaster: first.broadcaster_name || 'unknown',
    basis,
    source: 'clips',
    // Kept so the store can write one row per clip and, later, work out who
    // was first. Stripped before the snapshot goes to the browser — it is
    // bookkeeping, not something the page renders.
    clipIds: clips.map((c) => c.id).filter(Boolean),
    vodId: first.video_id || null,
    offsetSeconds,
    reactionOffsetSeconds,
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

/**
 * A chat spike, shaped like a moment so everything downstream — scoring, the
 * store, the UI — can treat it the same way.
 *
 * Two honest compromises live here, and the UI has to keep saying so:
 *
 *   * the VOD offset is ESTIMATED from stream uptime. Ads, reconnects and
 *     Twitch's own bookkeeping all shift it, so it is a good place to start
 *     looking, not a frame-accurate timestamp.
 *   * nobody has clipped this. It may be nothing. That is the price of being
 *     first, and it is the right price to pay — a confirmed moment is one you
 *     are already late to.
 *
 * `firstClipAt`/`lastClipAt` are set to the spike itself so the recency and
 * staleness maths in scoreMoments needs no special case.
 */
export function chatCandidateMoments(candidates, { channels = new Map() } = {}) {
  const moments = [];

  for (const candidate of candidates) {
    const channel = channels.get(candidate.login) || null;
    const startedAt = channel?.startedAt ? Date.parse(channel.startedAt) : NaN;
    const offsetSeconds = Number.isFinite(startedAt)
      ? Math.max(0, Math.round((candidate.peakAt - startedAt) / 1000))
      : null;

    const at = new Date(candidate.peakAt).toISOString();

    moments.push({
      // Keyed on when the spike STARTED, not on its peak. The peak moves as a
      // spike grows, and keying on it would file one moment under several ids
      // — quietly multiplying rows in the dataset this is all here to collect.
      id: `chat:${candidate.login}:${Math.round(candidate.startedAt / 1000)}`,
      broadcasterId: channel?.broadcasterId || null,
      broadcaster: channel?.displayName || candidate.login,
      basis: 'chat',
      source: 'chat',
      clipIds: [],
      vodId: channel?.vodId || null,
      offsetSeconds,
      // The chat peak already is the reaction, so no correction applies.
      reactionOffsetSeconds: offsetSeconds,
      offsetEstimated: true,
      saturation: 0,
      uniqueClippers: 0,
      firstClipper: null,
      firstClipAt: at,
      lastClipAt: new Date(candidate.lastAt).toISOString(),
      spanMinutes: round((candidate.lastAt - candidate.startedAt) / 60000),
      clipViews: 0,
      title: channel?.title || '',
      thumbnail: null,
      exampleClipUrl: null,
      chatCandidate: candidate,
    });
  }

  return moments;
}

/**
 * Fold chat candidates into the clip-derived moments.
 *
 * A chat spike and a cluster of clips on the same channel at the same time are
 * the same event seen twice, and showing them as two rows would be the feed
 * lying about how many moments there are. When they match, the clips win on
 * identity (they carry a real VOD offset) and the chat is attached as
 * evidence; the moment is marked `both`, which is the strongest row the feed
 * can produce — something happened AND almost nobody has it yet.
 *
 * Clips are created after the fact, so the match window is deliberately
 * lopsided: a spike can precede its clips by a couple of minutes, but clips
 * rarely precede the spike by more than a few seconds.
 */
export function mergeChatCandidates(
  clipMoments,
  candidateMoments,
  { beforeSeconds = 60, afterSeconds = 180 } = {},
) {
  const byBroadcaster = new Map();
  for (const moment of clipMoments) {
    const key = (moment.broadcaster || '').toLowerCase();
    if (!byBroadcaster.has(key)) byBroadcaster.set(key, []);
    byBroadcaster.get(key).push(moment);
  }

  const merged = [];

  for (const candidate of candidateMoments) {
    const key = (candidate.broadcaster || '').toLowerCase();
    const peak = Date.parse(candidate.firstClipAt);

    const hit = (byBroadcaster.get(key) || []).find((moment) => {
      const first = Date.parse(moment.firstClipAt);
      const last = Date.parse(moment.lastClipAt);
      return peak >= first - beforeSeconds * 1000 && peak <= last + afterSeconds * 1000;
    });

    if (hit) {
      hit.source = 'both';
      hit.chatCandidate = candidate.chatCandidate;
      continue;
    }
    merged.push(candidate);
  }

  return [...clipMoments, ...merged];
}

/**
 * What the browser gets: the moment without the bookkeeping.
 *
 * `clipIds` exists so the store can write one row per clip and work out who
 * was first; on a flooded moment it is forty strings nobody renders.
 * `chatCandidate` is already summarised into `chat`.
 */
export const publicMoments = (moments) =>
  moments.map(({ clipIds, chatCandidate, ...rest }) => rest);

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
 * independent of how many people have already clipped. It is now a weighted
 * reaction score rather than a message-rate z-score (see reactions.js), but it
 * sits in exactly the same place and for the same reason.
 *
 * Two discounts ride on it:
 *
 *   * SHARED halves it. Three channels spiking at once is the game doing
 *     something, not the streamer — every clipper watching the category will
 *     have it within minutes, which is the definition of a moment this feed
 *     should not be excited about.
 *   * UNCONFIRMED scales the whole score for chat-only moments. They have zero
 *     saturation and so take no crowding penalty at all, which would let an
 *     unverified spike outrank a real, confirmed, barely-clipped moment. A
 *     moment that might not exist should lose a tie against one that does.
 */
const SHARED_DISCOUNT = 0.5;
const UNCONFIRMED_DISCOUNT = 0.75;

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
      // For a moment chat nominated, the snapshot AT THE PEAK is the evidence
      // that put it on screen. The live bucket may already have gone quiet,
      // and showing that would make the row look like it was never justified.
      const chat = moment.chatCandidate?.chat || chatSpikes.get(login) || null;
      const chatZ = chat && Number.isFinite(chat.z) ? Math.max(chat.z, 0) : 0;

      // Fall back to the volume z-score when no reaction vector is present, so
      // a caller with only the old shape still scores the way it always did.
      const rawReaction = chat?.reaction ?? chat?.z ?? 0;
      const shared = Boolean(chat?.shared || moment.chatCandidate?.shared);
      const reaction =
        Math.max(Number(rawReaction) || 0, 0) * (shared ? SHARED_DISCOUNT : 1);

      const stream = streams.get(moment.broadcasterId) || null;
      const before = previous.get(moment.id);
      const newClips = before ? Math.max(moment.saturation - before, 0) : moment.saturation;

      const recency = Math.exp(-Math.max(sinceLastClip, 0) / 12);
      const heat = Math.log1p(clipsPerMinute) * 2 + reaction;
      const unconfirmed = moment.saturation === 0;
      const opportunity =
        ((heat * recency) / (1 + moment.saturation) ** 0.9) *
        (unconfirmed ? UNCONFIRMED_DISCOUNT : 1);

      return {
        ...moment,
        source: moment.source || 'clips',
        unconfirmed,
        shared,
        reaction: round(reaction),
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
