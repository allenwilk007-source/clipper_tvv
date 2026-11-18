# Does detection's audio burst predict a good short?

Declared on 2026-11-18, before any of the data below exists, so the answer
cannot be shaped by looking. Written down because the last two audio results
in this project were a hypothesis reported as a finding (a ~7s lead that did
not replicate) and a correlation on 12 clips (the engagement meter's 0.62).
This is the test that decides whether `audioBurst` enters the ranking.

## Question

Among automated shorts, does the `audioBurst` detection measured at detection
time (peak loudness over the probe window's median, in dB) predict how good
the short is?

## Sample, fixed in advance

- The **first 60** automated shorts with status `done` and a stored
  `audioBurst`, created after commit `7f3911c` on `main`.
- **n = 60 exactly.** Collection stops at 60: not earlier because it looks
  clear, not later because it does not.
- Excluded: any short already seen by the engagement meter's calibration or
  by a previous reviewer. None qualify, since the sample starts after them.
- Coverage when declared: 8 of 8 recent shorts carried `audioBurst`. If
  coverage falls, the shorts without it are counted and reported, and do not
  silently drop out of the denominator.

## Measures

1. The engagement meter's stored score (0-100).
2. An independent reviewer's engagement rating (0-10). The reviewer sees each
   short's frames and transcript only, never the meter's score or the audio
   numbers, and is a fresh agent that has not seen this document's
   hypothesis.

## Analysis

- Spearman rank correlation of `audioBurst` against (1) and against (2), each
  with n and a bootstrap 95% interval.
- The same for the meter's own `burst` against (2), for comparison.
- Reported in full **whatever the result**, null included.

## Decision, declared now

`audioBurst` enters the ranking only if its correlation with the reviewer's
ratings is at least **0.3** with a 95% interval that **excludes zero**.
Otherwise it stays out, and no subgroup or alternative cut of the same 60
is used to revive it; a new hypothesis needs a new sample.

If it does enter, it goes in as a modest term, and only once detection
probes enough moments that ranking on it does not simply reward having been
measured.

## Also on record

The cut window's 25s-before / 5s-after asymmetry is reasoning (broadcast
delay plus human reaction time), not a measurement. No valid figure for how
far chat lags a moment exists: the only one, ~7s, was derived through the
audio peak, which turned out not to be locatable (see detection-plan.md).
