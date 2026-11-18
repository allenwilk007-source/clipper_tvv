// node --test src/clipjobs.test.js    (or: npm test)
//
// What gets retried, and that retrying stops. No subprocesses.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTransient, withRetry } from './clipjobs.js';

test('the failures seen for real are retried', () => {
  // Windows refusing to start a process while too many start at once.
  assert.ok(isTransient('downloader exited with code 3221225794'));
  // yt-dlp mid-run.
  assert.ok(isTransient('list index out of range'));
  // A cut that came back short because the recording had not caught up.
  assert.ok(isTransient('the recording held only 28.0s of 30s: not recorded yet'));
  assert.ok(isTransient('HTTP Error 503: Service Unavailable'));
});

test('failures that would only fail again are not', () => {
  assert.ok(!isTransient('You must be logged into an account that has access to this subscriber-only content'));
  assert.ok(!isTransient('the finished short failed its checks: frozen for 30s of 30s'));
  assert.ok(!isTransient('Video 21 does not exist'));
});

test('a transient failure is tried again, and the third time is the last', async () => {
  let calls = 0;
  const value = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('exited with code 3221225794');
      return 'cut';
    },
    { delays: [0, 0] },
  );
  assert.equal(value, 'cut');
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('ETIMEDOUT');
      },
      { delays: [0, 0] },
    ),
    /ETIMEDOUT/,
  );
  assert.equal(calls, 3);
});

test('a permanent failure is not retried at all', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('subscriber-only content');
      },
      { delays: [0, 0] },
    ),
  );
  assert.equal(calls, 1);
});
