# Execution brief — detection platform

`detection-plan.md` is the spec. This is the operational brief for carrying it
out: constraints, verification rules, and what "done" means for each phase.

Copy everything below the line into a session working in this repo.

---

Execute `docs/detection-plan.md` in `C:\Users\allen\code\gta-6-clipping` on the
`main` branch. Read the plan first — it carries the reasoning, and the ordering
in it is deliberate. Do not create a feature branch.

**Phase order is not negotiable: Phase 0 before anything else.** The plan's own
argument is that the label has to exist before the detector, and that the clipper
index of Phase 3 can only ever be a longitudinal statistic — you cannot compute it
retroactively, you can only have been collecting. GTA 6 launches 2026-11-19.
Launch week is the richest and most unrepeatable data this category will ever
produce. A detector that ranks badly all week but records everything is
recoverable; a perfectly tuned detector that stored nothing has thrown the week
away.

## What exists

Node 24, ESM, **zero npm dependencies** — keep it that way. `npm test` runs 26
passing tests and must stay green.

- `src/chat.js` — pooled anonymous Twitch IRC, median/MAD z-score per channel on
  message rate. **Verified against live Twitch.** It discards the nick and the
  message text; Phase 1 is largely about stopping that.
- `src/moments.js` — clip clustering and the `opportunity` ranking. The `log1p` is
  load-bearing: clip velocity *is* saturation/span, so raw velocity in the
  numerator cancels the saturation penalty and the ranking silently becomes a
  popularity chart. A test guards it. Do not "simplify" it away.
- `src/twitch.js`, `src/feed.js`, `src/server.js`, `src/clip.js`,
  `src/clipjobs.js`, `public/`, `src/demo.js` (fixture behind `/api/feed?demo=1`).
- `node:sqlite` is confirmed working on this Node with no flag and no npm
  dependency.

## Verification rules

`.env` has **no Twitch credentials**, so the live Helix feed cannot run and you
cannot collect real clip history. Work inside that honestly:

- Twitch **chat** needs no credentials and does work — anonymous IRC, `justinfan`
  nick. Verify every chat-derived signal against real live traffic and report the
  actual per-channel numbers you observed.
- Use `/api/feed?demo=1` and synthetic fixtures for everything Helix-dependent.
- **Never fabricate a metric.** Build the measurement machinery and exercise it on
  replayed synthetic data. Where a number cannot be produced for real yet, print
  "not enough data" rather than a placeholder, and say so in the README and in
  your report.
- Do not persist raw chat messages. Derive the per-bucket signals, then discard
  the text. Volume is large at launch and retained chat logs are a liability with
  no upside.

## Per-phase definition of done

**Phase 0 — ground truth.** `src/store.js` over `node:sqlite`, schema with a
migration, batched writes (one transaction per tick, not per row), and a
`pruneOlderThan(days)` with a real default rather than a TODO. Outcome re-polling
at +15m/+1h/+6h/+24h must survive a restart — persist the schedule, don't hold it
in a timer. `npm run eval` prints the baseline number the plan defines. Expect
roughly 500 rows/minute.

**Phase 1 — chat semantics.** The typed reaction vector, each class z-scored
against its own baseline through the existing median/MAD machinery. Put the
extraction in a new `src/signals.js` as **pure functions over a bucket of parsed
messages**, so it is testable without a socket; `src/chat.js` calls it. The phase
is only done when the feed can emit a candidate moment with **no clips attached**
(`source: 'chat'`) — that flip from reactive to predictive is the point of the
phase, not a side effect of it.

Stop after Phase 1 and report. Do not run ahead into Phases 2–5; the plan says
each phase ships only if it beats the held-out baseline, and that judgement needs
real data that does not exist yet.

## Out of scope, permanently

No multi-account, account rotation, proxying, VPN or IP rotation. No uploading,
posting or scheduling. If something appears to need one, stop and say so rather
than building it.

## Reporting

Commit to `main` with the trailer
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and push. In your final
report, state plainly: what you verified against live data, what you could only
exercise synthetically, and anything you could not verify at all.
