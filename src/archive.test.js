// node --test src/archive.test.js    (or: npm test)
//
// The judgement in archive.js is which recording to trust. The lookup itself
// runs yt-dlp against Twitch and is not tested here.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveArchiveFrom } from './archive.js';

test('only an archive that is still recording is trusted', () => {
  // Measured: the current recording reports is_live, a finished one was_live.
  // An old VOD at the top of the list (archiving switched off for today) would
  // put "today's offset" into yesterday's broadcast.
  assert.deepEqual(liveArchiveFrom({ id: 'v1', timestamp: 1000, liveStatus: 'is_live' }), {
    vodId: '1',
    startedAt: 1_000_000,
  });
  assert.equal(liveArchiveFrom({ id: 'v1', timestamp: 1000, liveStatus: 'was_live' }), null);
});

test("the id comes out in Helix's form, so deep links and the store agree", () => {
  // yt-dlp says v2932444934; Helix says 2932444934. Unnormalised, the deep
  // link pointed at twitch.tv/videos/v2932444934.
  assert.equal(liveArchiveFrom({ id: 'v2932444934', timestamp: 1, liveStatus: 'is_live' }).vodId, '2932444934');
});

test('an archive with no usable id or start is not trusted either', () => {
  assert.equal(liveArchiveFrom({ id: 'v1', timestamp: NaN, liveStatus: 'is_live' }), null);
  assert.equal(liveArchiveFrom({ id: 'v1', timestamp: 0, liveStatus: 'is_live' }), null);
  // yt-dlp prints "NA" for a field it could not find.
  assert.equal(liveArchiveFrom({ id: 'NA', timestamp: 1000, liveStatus: 'is_live' }), null);
});
