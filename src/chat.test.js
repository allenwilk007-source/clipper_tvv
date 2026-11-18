// node --test src/chat.test.js    (or: npm test)
//
// The classifier and the per-class scoring. Not the sockets — connecting to
// Twitch in a unit test would be testing Twitch.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatWatcher, Series } from './chat.js';
import {
  REACTION_WEIGHTS,
  classify,
  copypastaRatio,
  normalizeMessage,
  reactionScore,
} from './reactions.js';

test('chat asking for a clip is caught, chat discussing clips is not', () => {
  assert.deepEqual(classify('CLIP THAT'), ['clipit']);
  assert.deepEqual(classify('someone clip this please'), ['clipit']);
  assert.ok(classify('!clip').includes('clipit'));

  // The value of this class is precision. These must NOT fire, or it fills up
  // with people talking about clips instead of asking for one.
  assert.ok(!classify('his clips are so good').includes('clipit'));
  assert.ok(!classify('i clipped it yesterday').includes('clipit'));
});

test('reaction classes separate the kinds of reaction', () => {
  assert.ok(classify('OMEGALUL').includes('funny'));
  assert.ok(classify('KEKW').includes('funny'));
  assert.ok(classify('💀💀💀').includes('funny'));
  assert.ok(classify('POGGERS').includes('hype'));
  assert.ok(classify('W').includes('hype'));
  assert.ok(classify('monkaS').includes('tension'));
  assert.ok(classify('WTF was that').includes('shock'));
  assert.deepEqual(classify('hello chat how are we'), []);
});

test('a message can be two pieces of evidence at once', () => {
  // Not a classification problem with one right answer — "LUL clip that" is
  // laughter AND a request, and both should count.
  const hits = classify('LUL clip that');
  assert.ok(hits.includes('funny'));
  assert.ok(hits.includes('clipit'));
});

test('a bare W counts but a W inside a sentence does not', () => {
  assert.ok(classify('W').includes('hype'));
  assert.ok(!classify('we should go west').includes('hype'));
});

test('normalising collapses the ways chat spams the same thing', () => {
  assert.equal(normalizeMessage('KEKW KEKW!!!'), 'kekw kekw');
  assert.equal(normalizeMessage('kekw   kekw'), 'kekw kekw');
  assert.equal(normalizeMessage('LMAOOOOOO'), 'lmaoo');
  assert.equal(normalizeMessage('   '), '');
});

test('copypasta ratio measures repetition, not volume', () => {
  // Ten different messages: a room reacting.
  assert.equal(copypastaRatio([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 0);
  // Eight copies of one thing and two others: a meme forming.
  assert.equal(copypastaRatio([8, 1, 1]), 0.8);
  assert.equal(copypastaRatio([]), 0);
});

test('a quiet channel is not evidence against a moment', () => {
  // Negative z-scores must never subtract from the score — the absence of a
  // chat spike says nothing about clips.
  const quiet = reactionScore({ volume: -4, funny: -2 });
  assert.equal(quiet, 0);
});

test('chat asking for a clip outweighs the same size of generic noise', () => {
  const callout = reactionScore({ clipit: 3 });
  const noise = reactionScore({ volume: 3 });
  assert.ok(callout > noise, `${callout} should beat ${noise}`);
  assert.equal(callout, 3 * REACTION_WEIGHTS.clipit);
});

test('a series scores against its own baseline, not an absolute threshold', () => {
  const busy = new Series();
  const quiet = new Series();
  // Warm both up at wildly different volumes.
  for (let i = 0; i < 10; i += 1) {
    busy.push(900 + (i % 3) * 20);
    quiet.push(9 + (i % 3));
  }
  // Each doubles relative to its own baseline.
  const busyZ = busy.push(1900);
  const quietZ = quiet.push(19);
  assert.ok(busyZ > 3, `busy channel z was ${busyZ}`);
  assert.ok(quietZ > 3, `quiet channel z was ${quietZ}`);
});

/** Drive a watcher's counters directly, without any sockets. */
function watcherWith(logins) {
  const watcher = new ChatWatcher({ connect: false });
  watcher.setChannels(logins);
  return watcher;
}

function warmUp(watcher, logins, buckets = 8, perBucket = 10) {
  for (let b = 0; b < buckets; b += 1) {
    for (const login of logins) {
      for (let i = 0; i < perBucket; i += 1) watcher.record(login, `user${i}`, 'hello');
    }
    watcher.rollAll(1000 + b * 10_000);
  }
}

test('one channel spiking alone is not marked as a category-wide event', () => {
  const logins = ['alpha', 'beta', 'gamma', 'delta'];
  const watcher = watcherWith(logins);
  warmUp(watcher, logins);

  for (let i = 0; i < 120; i += 1) watcher.record('alpha', `user${i}`, 'CLIP THAT OMEGALUL');
  for (const login of ['beta', 'gamma', 'delta']) {
    for (let i = 0; i < 10; i += 1) watcher.record(login, `user${i}`, 'hello');
  }
  watcher.rollAll(1_000_000);

  const candidates = watcher.candidates({ now: 1_000_000 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].login, 'alpha');
  assert.equal(candidates[0].shared, false);
  watcher.stop();
});

test('the whole category spiking at once is marked shared', () => {
  // Three channels popping in the same ten seconds is the game doing
  // something, not a streamer — high volume, no uniqueness, flooded shortly.
  const logins = ['alpha', 'beta', 'gamma', 'delta'];
  const watcher = watcherWith(logins);
  warmUp(watcher, logins);

  for (const login of logins) {
    for (let i = 0; i < 120; i += 1) watcher.record(login, `user${i}`, 'POGGERS');
  }
  watcher.rollAll(1_000_000);

  const candidates = watcher.candidates({ now: 1_000_000 });
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((c) => c.shared === true));
  watcher.stop();
});

test('a small chat asking for a clip nominates a moment without a volume spike', () => {
  // The whole reason the class breakdown exists: four people saying "clip
  // that" in a slow chat is a real signal that message rate cannot see.
  const watcher = watcherWith(['quiet']);
  for (let b = 0; b < 8; b += 1) {
    for (let i = 0; i < 6; i += 1) watcher.record('quiet', `user${i}`, 'just chatting away');
    watcher.rollAll(1000 + b * 10_000);
  }

  for (let i = 0; i < 4; i += 1) watcher.record('quiet', `user${i}`, 'CLIP THAT');
  for (let i = 0; i < 3; i += 1) watcher.record('quiet', `other${i}`, 'yeah');
  watcher.rollAll(1_000_000);

  const [candidate] = watcher.candidates({ now: 1_000_000 });
  assert.ok(candidate, 'expected a candidate from the clip callout alone');
  assert.equal(candidate.chat.classes.clipit.count, 4);
  watcher.stop();
});

test('a spike that keeps going is one candidate, not one per bucket', () => {
  const watcher = watcherWith(['alpha']);
  warmUp(watcher, ['alpha']);

  for (let b = 0; b < 3; b += 1) {
    for (let i = 0; i < 150; i += 1) watcher.record('alpha', `user${i}`, 'KEKW');
    watcher.rollAll(1_000_000 + b * 10_000);
  }

  const candidates = watcher.candidates({ now: 1_000_030 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].buckets, 3);
  watcher.stop();
});

test('a mid-size channel jumping 5x its own baseline counts as a spike', () => {
  // These are numbers measured off live Twitch, not invented: summit1g sat at
  // a baseline of ~3 messages per 10s bucket and jumped to 16 — z = 5.85, an
  // unmistakable reaction. The old floor of 20 messages per bucket threw it
  // away, which meant only channels too big to ever spike could qualify.
  const watcher = watcherWith(['summit1g']);
  for (let b = 0; b < 8; b += 1) {
    for (let i = 0; i < 3; i += 1) watcher.record('summit1g', `user${i}`, 'chatting');
    watcher.rollAll(1000 + b * 10_000);
  }

  for (let i = 0; i < 16; i += 1) watcher.record('summit1g', `user${i}`, 'LUL what');
  watcher.rollAll(1_000_000);

  const [candidate] = watcher.candidates({ now: 1_000_000 });
  assert.ok(candidate, 'a 5x jump on a mid-size channel must nominate a moment');
  assert.equal(candidate.login, 'summit1g');
  watcher.stop();
});

test('a dead chat with two messages is still not a spike', () => {
  // The other half of lowering the floor: a channel whose baseline is zero
  // hits the flat-series fallback on any activity at all, and must not be
  // allowed to nominate moments off two messages.
  const watcher = watcherWith(['ghost']);
  for (let b = 0; b < 8; b += 1) watcher.rollAll(1000 + b * 10_000);

  for (let i = 0; i < 2; i += 1) watcher.record('ghost', `user${i}`, 'anyone here');
  watcher.rollAll(1_000_000);

  assert.equal(watcher.candidates({ now: 1_000_000 }).length, 0);
  watcher.stop();
});
