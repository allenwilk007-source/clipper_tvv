// What chat is reacting *with*, not just how fast.
//
// Message rate alone treats "KEKW KEKW KEKW", "CLIP THAT" and "monkaS" as the
// same event. They are not. They predict different clips, with different
// ceilings, on different platforms:
//
//   * chat literally saying "clip it" is the highest-precision signal in the
//     building — it is a human deciding, for free, that this is clip material
//   * laughter travels furthest off Twitch, because it needs no context
//   * hype has a high ceiling and a short shelf life
//   * tension needs setup, which is exactly what a 15-second vertical cut
//     cannot carry
//
// Kept in one table so the patterns can be tuned, and tested, without touching
// the scoring that reads them.

/**
 * Order matters only for cost, not correctness: a message can land in several
 * classes at once (an "LUL CLIP IT" is both), and that is correct — it is two
 * pieces of evidence, not a classification problem with one right answer.
 */
export const REACTION_CLASSES = [
  {
    name: 'clipit',
    // Deliberately narrow. The value of this class is precision; loosening it
    // to catch "clips" or "clipped" fills it with people discussing clips
    // rather than asking for one.
    // `!clip` needs its own alternative: \b before a non-word character never
    // matches at the start of a string, so the obvious spelling silently
    // never fires.
    pattern: /\b(?:clip (?:that|this|it)|someone clip|clipit)\b|(?:^|\s)!clip\b/i,
  },
  {
    name: 'funny',
    pattern:
      /\b(?:lul+w?|omegalul|kekw?|icant|lmf?ao+|lmaoo+|pepelaugh|ahahah|jaja+)\b|💀|😂|🤣/i,
  },
  {
    name: 'hype',
    // Bare "W" is a real and very common signal, but only on its own — "W" in
    // the middle of a sentence is just a letter.
    pattern:
      /\b(?:pog+(?:ers|u|champ)?|letsgo+|lets go+|gigachad|sheesh|no shot|insane|actual cinema)\b|^\s*[WW]+\s*$/i,
  },
  {
    name: 'tension',
    pattern: /\b(?:monkas+|monkaw|pausechamp|sadge|oh no|uh oh|he'?s cooked|bro is cooked)\b/i,
  },
  {
    name: 'shock',
    pattern: /\b(?:wtf|wth|huh+|what the|no way|bro what|wait what|hol'? up)\b|\?{3,}/i,
  },
];

export const CLASS_NAMES = REACTION_CLASSES.map((c) => c.name);

/** Which classes a single message belongs to. */
export function classify(message) {
  const hits = [];
  for (const { name, pattern } of REACTION_CLASSES) {
    if (pattern.test(message)) hits.push(name);
  }
  return hits;
}

/**
 * Normalised for copypasta detection: case, punctuation and runs of the same
 * character collapse, so "KEKW KEKW" and "kekw kekw!!!" count as the same
 * message. Emote spam is the most common form of a chat meme forming, and a
 * meme forming is the single best predictor that a moment will travel.
 */
export function normalizeMessage(message) {
  return String(message)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/(.)\1{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How much of this bucket was people repeating each other.
 *
 * Returns 0..1. A room where everyone independently types something different
 * is reacting; a room where 60% of messages are the same four characters has
 * produced a meme, and memes are what leave the platform.
 */
export function copypastaRatio(counts) {
  let total = 0;
  let repeated = 0;
  for (const count of counts) {
    total += count;
    if (count > 1) repeated += count;
  }
  return total ? repeated / total : 0;
}

/**
 * A ten-second bucket of chat, as counts.
 *
 * These three are the whole extraction step, kept pure and separate from the
 * socket so the scoring can be tested without one.
 *
 * Note what a bucket does NOT hold: the messages. Text is folded into counts
 * as it arrives and the bucket is dropped on roll, so nothing retains chat.
 * At launch volume that is a lot of text not kept, and retained chat logs are
 * a liability with no upside here — every signal below is derivable live.
 */
export const createBucket = () => ({
  messages: 0,
  chatters: new Set(),
  // Normalised text only, and only until the bucket rolls — this is what makes
  // "how much of this was people repeating each other" answerable at all.
  repeats: new Map(),
  classes: new Map(CLASS_NAMES.map((name) => [name, 0])),
});

export function addMessage(bucket, nick, message) {
  bucket.messages += 1;
  if (nick) bucket.chatters.add(nick);

  const key = normalizeMessage(message);
  if (key) bucket.repeats.set(key, (bucket.repeats.get(key) || 0) + 1);

  for (const name of classify(message)) {
    bucket.classes.set(name, bucket.classes.get(name) + 1);
  }
  return bucket;
}

export function summarizeBucket(bucket) {
  return {
    messages: bucket.messages,
    chatters: bucket.chatters.size,
    copypasta: copypastaRatio([...bucket.repeats.values()]),
    classes: new Map(bucket.classes),
  };
}

/**
 * Collapse the per-class z-scores into the single number the ranking consumes.
 *
 * Everything is clamped at zero first: a channel being *quieter* than usual is
 * not evidence against a moment, it is just the absence of evidence, and
 * letting it go negative would silently subtract from unrelated clip signal.
 *
 * The weights are a starting position, not a result. They are the first thing
 * `npm run eval` should be pointed at once there is enough history to say
 * which of these classes actually predicts a clip that performs.
 */
export const REACTION_WEIGHTS = {
  volume: 1, // the original message-rate z-score
  clipit: 2, // chat telling you outright
  funny: 0.8,
  hype: 0.6,
  shock: 0.5,
  tension: 0.3,
  copypasta: 0.5, // a meme forming
  chatters: 0.4, // the room, not four people with a keyboard macro
};

export function reactionScore(parts = {}) {
  const up = (value) => Math.max(Number(value) || 0, 0);
  let total = 0;
  for (const [key, weight] of Object.entries(REACTION_WEIGHTS)) {
    total += weight * up(parts[key]);
  }
  return total;
}
