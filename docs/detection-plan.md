# Detection: finding the best clip, not the busiest moment

A plan for turning the saturation feed into something that actually detects
clip quality. Written 2026-11-18, against commit `310c58a`.

## Two things are true about what exists today

**1. The feed structurally cannot be first.** A moment only enters the feed
once somebody has clipped it, because clips *are* the input. `saturation = 1`
is the floor, and `saturation = 1` means one person already beat you. Every
ranking improvement inside that constraint is a fight over second place.

The fix is not a better formula. It is a second input that exists *before* any
clip does — chat. The pooled IRC connection is already open to 80 channels and
is currently used only as a tiebreaker multiplier. It is the only signal in the
building that can fire at `saturation = 0`.

**2. "Best" is currently unfalsifiable.** `opportunity` is a hand-tuned
formula. The thesis behind it is sound and the `log1p` guard is load-bearing,
but no moment it has ever ranked has been checked against whether the clip went
on to do anything. There is no label, so there is no way to tell a good signal
from a plausible one, and no way to tune a constant except by taste.

So the first phase is not a detector. It is the scoreboard that tells you
whether a detector works.

## The funnel

Three stages, cheapest first. This shape matters: content analysis is good and
expensive, chat is weak and free, and a system that mixes them in one pass
either costs too much or ignores the good signal.

```
stage 1   chat, all channels, continuous     free        fires at saturation 0
stage 2   clip clustering + ranking          cheap API   fires at saturation 1+
stage 3   download + audio/scene analysis    expensive   top ~10 moments only
```

Stage 1 nominates, stage 2 ranks, stage 3 confirms and trims.

---

## Phase 0 — Ground truth

**Build the label before building the detector.**

Persist every moment, clip and poll to `node:sqlite` — confirmed working on
Node 24.19.0 with no flag and no npm dependency, so the zero-dep rule holds.

Then re-poll the clips of known moments at +15m, +1h, +6h and +24h and record
where their view counts landed. That gives three labels, all of them
clipping-specific:

- `views@24h` — did the clip perform?
- `saturation@24h / saturation@detect` — did the moment go mainstream after we
  saw it, or did nobody else ever care?
- `lead_time` — how long before the second independent clipper found it. This
  is the one the product is actually selling.

Ship `npm run eval`: of the top 20 moments by today's `opportunity`, what
fraction landed in the top decile by `views@24h`? That number is the baseline.
No later phase ships unless it beats it on the same held-out history.

This phase is also the only way Phase 3 ever exists, because the clipper index
is a longitudinal statistic — you cannot compute it retroactively, you can only
have been collecting.

**Deliverable:** `src/store.js`, a migration, backfill from the live feed, and
one number printed by `npm run eval`.

---

## Phase 1 — Chat semantics

`src/chat.js` currently scores message *rate* with a median/MAD z-score, which
is well built and verified against live Twitch. The limitation is that it
treats "KEKW KEKW KEKW" and "CLIP THAT" and "monkaS" as the same event.

Decompose the rate into a typed reaction vector, each class z-scored against
its own baseline using the existing machinery:

| class | matches | what it means for a clip |
|---|---|---|
| `clipit` | `clip that`, `clip it`, `!clip`, `someone clip` | chat telling you literally — highest precision signal available |
| `funny` | LULW, OMEGALUL, KEKW, ICANT, LMAO, 💀 | travels furthest off-platform, no context needed |
| `hype` | POGGERS, PogU, LETSGO, W, GIGACHAD | high ceiling, short shelf life |
| `tension` | monkaS, monkaW, PauseChamp, Sadge | needs setup, worse for Shorts |
| `shock` | WTF, HUH, "bro what", ??? | strong, often ambiguous |
| `copypasta` | ratio of repeated identical messages | meme-ability, the thing that spreads |

Two more that cost nothing and matter a lot:

- **unique chatters vs messages.** The whole room reacting is a different event
  from four people spamming. Current z-score cannot tell them apart.
- **cross-channel correlation.** If three or more watched channels spike within
  the same ten seconds, it is a game or server event, not a personal moment:
  high volume ceiling, near-zero uniqueness, and it will be flooded within
  minutes. One channel spiking alone is the opposite. This is nearly free given
  the pooled connection already exists, and it is a *uniqueness* detector,
  which is what this whole product is about.

**The output of this phase is a new kind of row: a candidate moment with no
clips attached to it.** That is the flip from reactive to predictive, and it is
the only change in this document that lets the tool be first rather than fast.

**Deliverable:** the reaction vector in `chat.js`, candidate moments in the
feed marked `source: 'chat'`, and an eval number showing whether chat-only
candidates beat clip-derived ones on `lead_time`.

---

## Phase 2 — Better clip-side signals

Same API calls, more extracted from them.

- **Viewer-normalized saturation.** Two clips on a 600-viewer stream is a far
  stronger signal than two clips on xQc. `clips per 1000 concurrent viewers`
  is the correct denominator and the current score does not use it at all.
- **Clipper diversity.** `unique creators / total clips`. Eight clips by one
  person is one person. The feed already computes `uniqueClippers` and then
  only uses it to pick a label.
- **Time to second clipper.** How long an independent second person took to
  find it. Short means loud and obvious; long means you are early on something
  non-obvious, which is worth more.
- **Early view velocity.** Views per minute on the *earliest* clip in the
  cluster. This is the single best free "is it actually good" measure, because
  it is independent of how many people clipped it.
- **Saturation acceleration** rather than rate, so a moment that is about to
  flood can be told from one that already has.

---

## Phase 3 — The clipper index (the moat)

From Phase 0's history: for each `creator_name`, how often were they first on a
moment that went on to saturate and perform? That is an early-finder score, and
it inverts the ranking usefully — a `saturation = 1` moment found by a
top-decile early finder is a strong signal, while the same moment found by a
first-time clipper is noise.

This is the asset the README already names as the unbuilt moat. It cannot be
scraped, bought or reverse-engineered, because it requires having been
collecting since before launch night. It is also the only phase here that gets
more valuable the longer the thing runs.

---

## Phase 4 — Content analysis of the top N

Now that `src/clip.js` exists, the top ~10 moments can be downloaded and
measured. Only the top ten, because each one costs a re-encode.

- `ebur128` loudness envelope — laughs, screams, the moment of impact
- `silencedetect` — the beat-then-payoff structure most good clips have
- scene-change density via `select=gt(scene,0.4)` — action vs talking
- speech density as a rough proxy for context-dependence

Two deliverables, and the second one is the valuable one:

1. a confidence score that confirms or demotes the stage-2 ranking
2. **auto-trim** — pick the tightest 8–15s window containing the payoff inside
   the 30s cut. Shorts and TikTok punish slack at the front, and the current
   fixed `CLIP_PRE=25` deliberately errs long. Trimming is the clipping-
   specific payoff of having built the extractor.

---

## Phase 5 — Risk flags

Flag, never block. The operator decides.

- **Content ID**: in-game radio is the known trigger. Flag driving scenes, and
  offer a mute-and-replace path rather than guessing at fingerprints.
- **Rockstar takedowns**: story and spoiler clips get removed even after
  launch. Detect on stream title and VOD chapter keywords.
- **Muted VOD segments**: detect before downloading, so the failure is instant
  rather than ninety seconds in.

---

## Settled: a signal can rank without detecting

Keep these two questions apart. They sound alike, they have different answers,
and conflating them cost a working signal most of an evening.

> **Detection** — does this signal tell a moment from ordinary stream?
> **Ranking** — among moments something else already nominated, does it sort
> the good from the bad?

Stream audio is the worked example. Asked as detection, it fails: over 29
chat-nominated moments compared against a random offset in the *same* VOD, the
nominated one was the louder of the pair 14 times — 48%, against 50% by chance
(`src/audiocontrol.js`). Audio cannot find a moment.

Asked as ranking, it is the strongest single signal in hand ratings: Spearman
0.62 against rated clip quality, where chat alone manages 0.31. The mechanism
is specific and worth remembering — chat fires at story cutscenes where
nothing happens on screen, and in a story-heavy game that is not a rare edge
case. Audio does not, which is exactly why it adds information chat has not
already given.

Both results are true. A signal can be useless for finding moments and the
best thing available for ordering them, because ranking is conditional on a
nomination that has already happened. **A negative detection result is not a
verdict on ranking, and a control group built without a notion of quality
cannot speak to quality at all.** The audio control had no idea what a good
clip was; it was never going to.

The practical rule: before concluding a signal is worthless, check which of
the two questions the experiment actually asked.

## Height is not position

A second distinction, same family, learned the same way. How *loud* a peak is
and how well it locates the moment are separate claims, and the first does not
imply the second.

The plan was to trust an audio-derived cut point when the burst was large.
Measured over 45 moments, the rate at which the audio peak precedes the chat
offset is flat across every threshold: 67% at a 4 dB floor, 68% at 9 dB, 69%
at 12 dB. A loud burst is no better placed than a quiet one, so a confidence
gate built on height is a number standing in for an argument.

Whatever gates the cut point has to be a property that bears on *placement* —
whether the window held one event or several, say — and it has to show a
gradient before it ships. `src/audiolag.js` prints the lead rate for each
candidate gate so a flat column is visible rather than assumed.

## How to tell if any of this worked

One number, re-run every phase against the same held-out history:

> of the top 20 moments this detector surfaced, what fraction landed in the top
> decile by `views@24h` — and what was the median `lead_time` over the second
> independent clipper?

The first number says it detects quality. The second says it detects it *first*.
A phase that improves neither does not ship, however good the idea sounded.

## Out of scope, permanently

No multi-account, account rotation, proxying, VPN or IP rotation. No uploading,
posting or scheduling. The tool indexes, ranks and cuts to local disk; footage
does not leave the operator's machine through anything built here. That
boundary is what keeps the legal posture intact and it is not a phase that
arrives later.
