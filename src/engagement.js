// The engagement meter: rewatching a cut before anyone posts it.
//
// Every automated short is scored, 0-100, on what can actually be measured in
// the cut, and a low score gets one redo: a wider cut, re-centred on where the
// action is, kept only if it scores higher. What is still weak after that is
// flagged in the panel rather than passed off as good.
//
// The meter reads four things, each because it is how a moment worth watching
// shows up in the data:
//
//   chat     how hard chat's reaction classes spiked. The strongest signal
//            there is: a room of people decided, live, that this was a moment.
//   audio    a burst in loudness near the payoff, against the clip's own
//            baseline. Laughing, shouting and explosions all sound like that.
//   speech   clear, energetic talk: words per second, "!" and "?", laughing,
//            "no way". A clip of silence, or of speech the model could not
//            follow, has none.
//   motion   something happening on screen. A menu, a map or a static frame
//            scores nothing here, and a clip that is mostly frozen is
//            penalised outright.
//
// "Funny" is the slice of those that is laughter: chat's funny class, laughing
// in the transcript, and the audio burst that laughter makes.
//
// It cannot see a joke land. It is a stand-in for watching, checked against an
// independent reviewer's ratings (see the README for how well they agreed).

import { run } from './clip.js';
import { config } from './config.js';

// Below this a short is redone; below the floor, after the redo, it is
// flagged as weak. Set against an independent reviewer's ratings of 12 live
// shorts (rank correlation with the meter: 0.83): every short under 50 was
// one the reviewer also wanted redone, and nothing it kept fell under 50. The
// two it rated 1/10 — a phone menu and a frozen webcam — scored 13 and 17.
export const KEEP_SCORE = Number(process.env.ENGAGEMENT_KEEP) || 50;
export const FLOOR_SCORE = Number(process.env.ENGAGEMENT_FLOOR) || 30;

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, Number(value) || 0));
const mean = (values) => (values.length ? values.reduce((n, v) => n + v, 0) / values.length : null);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/**
 * Pairs of `pts_time:T` and `key=value` lines, as ffmpeg's metadata printers
 * write them, into [{t, v}].
 */
export function parseSeries(text, key) {
  const series = [];
  let time = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const at = /pts_time:([\d.]+)/.exec(line);
    if (at) {
      time = Number(at[1]);
      continue;
    }
    const i = line.indexOf(`${key}=`);
    if (i >= 0 && time !== null) {
      const value = Number(line.slice(i + key.length + 1));
      if (Number.isFinite(value)) series.push({ t: time, v: value });
      time = null;
    }
  }
  return series;
}

/** Loudness (every 100ms) and motion (every 200ms) of a cut, from ffmpeg. */
export async function measureCut(path) {
  const measure = async (args, key) => {
    try {
      const { stdout } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', path, ...args, '-f', 'null', '-'], {
        cwd: config.root,
        label: 'ffmpeg',
      });
      return parseSeries(stdout, key);
    } catch {
      return []; // no audio stream, say: that signal is simply absent
    }
  };
  const [loudness, motion] = await Promise.all([
    measure(['-vn', '-af', 'ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-'], 'lavfi.r128.M'),
    measure(
      ['-an', '-vf', "fps=5,scale=320:-2,select='gte(scene,0)',metadata=mode=print:key=lavfi.scene_score:file=-"],
      'lavfi.scene_score',
    ),
  ]);
  // The loudness meter reads -120 until its 400ms window has filled.
  return { loudness: loudness.filter((p) => p.v > -70), motion };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const LAUGH = /\b(?:ha(?:ha)+|lmao+|lol|hehe+|laugh\w*|dying|crying)\b/i;
const HYPE = /\b(?:no way|oh my god|what the|let'?s go+|holy|insane|crazy|run|bro|dude|wait)\b/i;

/**
 * Score one window of a cut. Times are seconds into the measured file;
 * `payoffAt` is where the moment should land (the reaction, or for a search,
 * three quarters of the way in). Pure, so every rule is tested.
 */
export function scoreWindow({ loudness = [], motion = [], words = null, chat = null, start = 0, end = 30, payoffAt = null }) {
  const length = Math.max(1, end - start);
  const payoff = payoffAt ?? start + length * 0.8;
  const inWindow = (p) => p.t >= start && p.t < end;
  const L = loudness.filter(inWindow);
  const M = motion.filter(inWindow);
  const W = (words || []).filter((w) => w.start >= start && w.end <= end);
  const reasons = [];

  // Chat (0-30). A moment from clips alone has no chat reading: neutral.
  const classes = chat?.classes || {};
  const z = (name) => Math.max(0, Number(classes[name]?.z) || 0);
  const crowd = Math.max(z('clipit'), z('funny'), z('shock'), z('hype'), z('tension') * 0.6, Number(chat?.z) || 0);
  const chatPts = chat ? clamp(crowd / 8) * 30 : 12;
  if (chat && crowd >= 4) reasons.push(`chat spiked hard (z ${crowd.toFixed(1)})`);
  else if (chat && crowd < 2) reasons.push('chat barely reacted');

  // Audio burst (0-25): the loudest point near the payoff, against the clip's
  // own median, so a quiet streamer and a loud one are judged alike.
  const baseline = median(L.map((p) => p.v));
  const near = L.filter((p) => p.t >= payoff - 12 && p.t <= payoff + 3);
  const peak = near.length ? Math.max(...near.map((p) => p.v)) : null;
  const burst = peak !== null && baseline !== null ? peak - baseline : 0;
  const audioPts = clamp(burst / 12) * 25;
  if (burst >= 9) reasons.push(`a ${Math.round(burst)} dB burst at the payoff`);
  else if (L.length && burst < 4) reasons.push('no audio spike at the payoff');

  // Speech (0-20).
  const text = W.map((w) => w.word).join(' ');
  const density = W.length / length;
  const energy =
    W.filter((w) => /[!?]$/.test(String(w.word).trim())).length +
    (text.match(new RegExp(LAUGH.source, 'gi')) || []).length +
    (text.match(new RegExp(HYPE.source, 'gi')) || []).length;
  const laughs = (text.match(new RegExp(LAUGH.source, 'gi')) || []).length;
  const speechPts = W.length >= 4 ? clamp(density / 2) * 8 + clamp(energy / 4) * 8 + 4 : 0;
  if (!W.length) reasons.push('nothing said, or not clearly');
  else if (energy >= 3) reasons.push('energetic speech');

  // Motion (0-15), and the penalty for a clip that is mostly a still frame.
  const activity = mean(M.map((p) => p.v)) ?? 0;
  const cuts = M.filter((p) => p.v > 0.3).length;
  const motionPts = clamp(activity / 0.06) * 10 + clamp(cuts / 4) * 5;
  const still = M.length ? M.filter((p) => p.v < 0.002).length / M.length : 0;

  let penalty = 0;
  if (still > 0.6) {
    penalty += 15;
    reasons.push('mostly a still frame');
  }
  if (baseline !== null && baseline < -40) {
    penalty += 10;
    reasons.push('very quiet');
  }

  const total = chatPts + audioPts + speechPts + motionPts - penalty;
  const score = Math.round(clamp(total / 90) * 100);
  const funny = Math.round(
    clamp(z('funny') / 6) * 50 + clamp(laughs / 2) * 25 + clamp(burst / 12) * 25,
  );

  return {
    score,
    funny,
    parts: {
      chat: Math.round(chatPts),
      audio: Math.round(audioPts),
      speech: Math.round(speechPts),
      motion: Math.round(motionPts),
      penalty,
    },
    burst: Math.round(burst * 10) / 10,
    reasons,
  };
}

/**
 * The best `length`-second window of a wider cut, for a redo.
 *
 * Every window must still contain the moment chat reacted to (`anchor`), with
 * a few seconds after it. Within that, each is scored as if its payoff sat
 * three quarters of the way in — where a payoff reads best on a short — so
 * the search slides the frame until the loudest burst lands there.
 */
export function bestWindow({ loudness = [], motion = [], words = null, chat = null, duration, anchor, length = 30, step = 1 }) {
  const first = Math.max(0, anchor - (length - 3));
  const last = Math.min(Math.max(0, duration - length), anchor - 3);
  let best = null;
  for (let start = first; start <= last + 1e-9; start += step) {
    const payoffAt = start + length * 0.75;
    const scored = scoreWindow({ loudness, motion, words, chat, start, end: start + length, payoffAt });
    // Every window that merely contains the burst scores the same, so ties
    // go to the one whose loudest point sits closest to the three-quarter
    // mark — worth up to two points, never enough to beat a real difference.
    const inside = loudness.filter((p) => p.t >= start && p.t < start + length);
    const peak = inside.length ? inside.reduce((a, b) => (b.v > a.v ? b : a)).t : payoffAt;
    const rank = scored.score + 2 * (1 - Math.min(1, Math.abs(peak - payoffAt) / 10));
    if (!best || rank > best.rank) best = { ...scored, rank, start: Math.round(start * 10) / 10 };
  }
  if (best) delete best.rank;
  return best;
}

/** Words from a wider cut, re-timed to a window that starts at `start`. */
export const shiftWords = (words, start, length = 30) =>
  (words || [])
    .filter((w) => w.start >= start && w.end <= start + length)
    .map((w) => ({ ...w, start: w.start - start, end: w.end - start }));
