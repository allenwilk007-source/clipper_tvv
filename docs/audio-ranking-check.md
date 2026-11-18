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

## What the sample can and cannot show

Every short in the sample is a moment automation chose to cut, so every one
has already passed the chat ranking. The test can therefore answer only:
**among moments good enough to cut, does `audioBurst` predict which are
better?** It cannot show whether `audioBurst` should help decide which
moments get cut at all: no moment chat ranked low is in the sample, and
those are exactly the ones a selection rule would newly promote or demote.
(Raised by the detection session before collection began.)

## Decision, declared now

If its correlation with the reviewer's ratings is at least **0.3**, with a
95% interval that **excludes zero**, `audioBurst` may be used to **re-order
moments that have already passed every other rule**: which of the eligible
moments are cut first when a cap bites. It may **not** be used to admit or
exclude moments. That needs a separate test, declared in advance, with a
control arm cut from below the line, so the correlation is measured across
the whole range a selection rule would act on. The control moments must be
measured by detection's own probe (`measureAudio` sampling a random
below-the-line moment per poll, flagged as control), never by a second
probe in the cutter: two implementations would differ, and that difference
would be indistinguishable from the effect. Agreed with the detection
session, which will add it when that test is declared.

Otherwise it stays out, and no subgroup or alternative cut of the same 60
is used to revive it; a new hypothesis needs a new sample.

## Reading the result

- **Range restriction.** The sample covers only moments that cleared the
  ranking, which narrows the spread of both variables and pulls the
  correlation toward zero. A result just under 0.3 is weaker evidence
  against the hypothesis than it looks, and is to be reported as
  inconclusive, not as a clean null.
- **The outcome is a stand-in.** A reviewer rating a clip and a meter
  scoring it can both respond to loudness directly: a loud clip feels
  exciting to anything that listens to it. A positive result shows that
  `audioBurst` predicts what a rater thinks of a clip, not that the clip
  performs. It is not to be cited as "audio predicts good clips" without
  that qualifier. What settles performance is views, which needs
  credentials and posting.

## Also on record

The cut window's 25s-before / 5s-after asymmetry is reasoning (broadcast
delay plus human reaction time), not a measurement. No valid figure for how
far chat lags a moment exists: the only one, ~7s, was derived through the
audio peak, which turned out not to be locatable (see detection-plan.md).
