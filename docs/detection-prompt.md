# Handoff prompt — detection platform

Copy everything below the line into a fresh session working in this repo.
The reasoning behind it is in [`detection-plan.md`](./detection-plan.md).

---

Build the detection platform for the saturation feed in
`C:\Users\allen\code\gta-6-clipping`, on the `main` branch. Read
`docs/detection-plan.md` first — it is the spec, and it explains *why* each
piece exists. Do not create a feature branch.

## What exists

Node 24, ESM, **zero npm dependencies** — keep it that way. `npm test` currently
runs 26 passing tests and must stay green.

- `src/chat.js` — pooled anonymous Twitch IRC. Counts messages per channel in
  10-second buckets and scores a robust `(count − median) / MAD` z-score against
  each channel's own history. **Verified working against live Twitch.** It
  currently throws away both the sender's nick and the message text; most of this
  task is about stopping that.
- `src/moments.js` — clusters clips by broadcaster and `vod_offset`, ranks with
  `opportunity = (log1p(clipsPerMinute) * 2 + chatZ) * recency / (1 + saturation) ** 0.9`.
  The `log1p` is load-bearing: clip velocity *is* saturation/span, so raw velocity
  in the numerator cancels the saturation penalty and the ranking silently becomes
  a popularity chart. A test guards this. Do not "simplify" it.
- `src/twitch.js` Helix client, `src/feed.js` poll loops, `src/server.js`
  (`node:http`), `src/clip.js` + `src/clipjobs.js` (yt-dlp extraction), `public/`
  UI, `src/demo.js` fixture behind `/api/feed?demo=1`.

## Hard constraint on verification

`.env` has **no Twitch credentials**, so the live Helix feed cannot run and you
cannot collect real clip data. Work within that:

- Twitch **chat** needs no credentials and does work — anonymous IRC, `justinfan`
  nick. Use it to verify every chat-derived signal against real traffic.
- Use `/api/feed?demo=1` and synthetic bucket data for everything Helix-dependent.
- **Do not fabricate metrics.** Build the measurement machinery and verify it on
  synthetic and replayed data. If you cannot measure something for real, say so
  explicitly in the README and in your final report.

## Phase 1 — signals

Extend `src/chat.js` to capture the nick and message text per PRIVMSG, derive
per-bucket signals, then discard the raw text. Never persist raw messages.

Detectors:
- **unique chatters** per bucket (dedupe on nick) — the largest precision win here
- **"clip it" intent density** — explicit viewer intent, one regex
- **emote burst composition** — laugh / shock / sad ratios
- **message entropy collapse** — mean length drop and repeated-token ratio
- **viewer delta** from the existing `/helix/streams` poll

Suppressors, each in its own tested function:
- **raid** — vertical cliff in unique chatters, no ramp, no clip response
- **sub/bit train** — repetition signature
- **cross-channel co-occurrence** — if ≥30% of tracked channels spike inside the
  same 20s window it is a game-wide event, not one streamer's moment. Label it
  differently; do not rank it as clippable.

Put signal extraction in a new `src/signals.js` as **pure functions over a bucket
of parsed messages**, so it is testable without a socket. `src/chat.js` calls it.

## Phase 2 — storage

`node:sqlite` (`import { DatabaseSync } from 'node:sqlite'`) — built into Node 24,
already verified working in this repo. No npm packages.

New `src/store.js`, three tables:
- `buckets` — every signal value, per channel, per 10s bucket
- `detections` — each time the detector fired, with the full signal vector
- `moments` — saturation trajectory, sampled per poll

Write batched (one transaction per bucket tick, not per row). Add retention from
the start: a `pruneOlderThan(days)` with a default, not a TODO. Expect roughly
500 rows/minute.

**Outcome tracking:** for each detection, re-poll its clips at +1h, +6h, +24h via
`/helix/clips?id=` and record peak views and final saturation. Those are the
labels. Build it so it survives restarts — persist the schedule, don't hold it in
a timer.

## Phase 3 — calibration machinery

- `src/replay.js` — replay stored buckets through the detector offline and
  deterministically, far faster than real time.
- `npm run evaluate` — reports **precision**, **recall**, and **lead time**
  (seconds between detection and the third clip existing). Lead time is the
  product metric: being early is the entire value, so report it first.
- Logistic regression in plain JS (~40 lines, no ML dependency) over the stored
  feature matrix, predicting "this moment exceeded N clips". Keep the current
  hand-tuned formula as the baseline; a fitted model that cannot beat it on
  held-out data is not an improvement, and you should report that outcome plainly
  if it happens.

## Phase 4 — surface it

Show the metrics in the UI header: detections, hit rate, median lead time. When
there is no data yet, say "not enough data" — never a placeholder number.

## Out of scope

No multi-account, account-rotation, proxy, VPN or IP-rotation features. No
uploading or auto-posting. If something seems to need one of those, stop and say
so instead of building it.

## Done looks like

- `npm test` green, with new tests for every pure signal function and every
  suppressor, including the raid and cross-channel cases
- `npm start` works; `/?demo=1` renders
- A real anonymous IRC run against live Twitch showing the new signals populating
  — report the actual numbers you observed, per channel
- `npm run evaluate` runs end to end on replayed synthetic data and prints the
  three metrics
- `node:sqlite` file created, written, pruned, and reopened across a restart
- README updated, including an honest statement of what could not be verified
  without Twitch credentials

Commit to `main` with the trailer
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and push.

Priority if time runs short: **Phases 1 and 2 before anything else.** GTA 6
launches 2026-11-19. Launch week is the richest and most unrepeatable data this
category will ever produce. A detector that fires badly all week but records
everything is recoverable; a perfect detector that stored nothing has thrown the
week away. Collect first, calibrate second.
