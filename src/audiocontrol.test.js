import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickControl } from './audiocontrol.js';

/** Deterministic stand-in for Math.random, so a control pick is reproducible. */
const sequence = (...values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

describe('pickControl', () => {
  it('never lands within 300s of a nominated moment', () => {
    const offsets = [1000, 2000, 5000];
    // Walk the whole unit interval; every pick has to clear every moment.
    for (let i = 0; i <= 100; i += 1) {
      const control = pickControl(offsets, sequence(i / 100));
      if (control === null) continue;
      for (const offset of offsets) {
        assert.ok(
          Math.abs(control - offset) >= 300,
          `control ${control} sits ${Math.abs(control - offset)}s from moment ${offset}`,
        );
      }
    }
  });

  it('stays inside the span actually observed on that VOD', () => {
    // An offset past the end of the VOD downloads nothing, and a failed probe
    // is not a control — it is a missing data point that biases the pairing.
    const offsets = [1000, 9000];
    for (let i = 0; i <= 50; i += 1) {
      const control = pickControl(offsets, sequence(i / 50));
      if (control === null) continue;
      assert.ok(control >= 60 && control <= 9000, `control ${control} outside the observed span`);
    }
  });

  it('gives up rather than returning a control too close to the moments', () => {
    // One moment in a short VOD: there is nowhere legal to stand.
    assert.equal(pickControl([400], sequence(0.5)), null);
  });

  it('retries past a blocked draw instead of failing on the first collision', () => {
    // First draw lands on top of the moment at 1000; the second is clear.
    const offsets = [1000, 4000];
    const control = pickControl(offsets, sequence(1000 / 4000, 0.9));
    assert.notEqual(control, null);
    assert.ok(Math.abs(control - 1000) >= 300);
  });
});
