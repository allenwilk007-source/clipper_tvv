import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  CAP_WINDOW_MS,
  MAX_CHUNK,
  PENDING_CAP,
  SCOPE,
  TikTokError,
  accessTokenFor,
  authUrl,
  chunkPlan,
  chunkRange,
  classify,
  classifyAuth,
  exchangeCode,
  failKind,
  initUpload,
  postStatus,
  putChunk,
  refreshAccess,
  uploadVideo,
} from './tiktok.js';

const KEYS = { clientKey: 'ck', clientSecret: 'cs', redirectUri: 'http://localhost:3000/auth/tiktok/callback' };

const okJson = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => body });
const ok = (data) => okJson({ data, error: { code: 'ok', message: '', log_id: 'l1' } });

describe('authUrl', () => {
  it('asks for the scopes comma separated, which is what TikTok wants', () => {
    // Google wants spaces here; sending spaces to TikTok silently drops
    // scopes, and the upload then fails at post time with scope_not_authorized.
    assert.equal(SCOPE, 'user.info.basic,user.info.stats,video.list,video.upload');
    const url = new URL(authUrl(KEYS, 'st8'));
    assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
    assert.equal(url.searchParams.get('scope'), SCOPE);
    assert.equal(url.searchParams.get('client_key'), 'ck');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('state'), 'st8');
    assert.equal(url.searchParams.get('redirect_uri'), KEYS.redirectUri);
  });
});

describe('classify', () => {
  it('reads TikTok own codes before the HTTP status', () => {
    assert.equal(classify(401, { error: { code: 'access_token_invalid' } }), 'auth');
    assert.equal(classify(401, { error: { code: 'scope_not_authorized' } }), 'auth');
    assert.equal(classify(403, { error: { code: 'spam_risk_too_many_pending_share' } }), 'quota');
    assert.equal(classify(429, { error: { code: 'rate_limit_exceeded' } }), 'transient');
    assert.equal(classify(400, { error: { code: 'invalid_param' } }), 'refused');
    assert.equal(classify(503, { error: { code: 'internal_error' } }), 'transient');
  });

  it('a ban is the account, not the sign-in and not the video', () => {
    // Calling this "auth" would send the owner to reconnect over and over;
    // calling it "refused" would strike off every short in turn, one a slot.
    assert.equal(classify(403, { error: { code: 'spam_risk_user_banned_from_posting' } }), 'blocked');
    // An unrecognised 403 is about the account too, for the same reason.
    assert.equal(classify(403, { error: { code: 'something_new' } }), 'blocked');
  });
});

describe('classifyAuth', () => {
  it('invalid_grant means connect again, whatever caused it', () => {
    // Expired, revoked, or issued to another client all arrive as this.
    assert.equal(classifyAuth({ error: 'invalid_grant' }), 'auth');
    assert.equal(classifyAuth({ error: 'invalid_client' }), 'auth');
  });

  it('TikTok being down is not the owner signed out', () => {
    assert.equal(classifyAuth({ error: 'server_error' }), 'transient');
    assert.equal(classifyAuth({ error: 'temporarily_unavailable' }), 'transient');
    // Unknown is transient: the expensive direction to be wrong in is telling
    // someone their sign-in died when it did not.
    assert.equal(classifyAuth({ error: 'brand_new_thing' }), 'transient');
    assert.equal(classifyAuth(null), 'transient');
  });
});

describe('chunkPlan', () => {
  it('sends a short in one piece', () => {
    // A short is ~14 MB: one chunk, so chunk_size is the whole file.
    assert.deepEqual(chunkPlan(14_000_000), { chunkSize: 14_000_000, totalChunkCount: 1 });
    // Under TikTok's 5 MB floor the whole file must still go as one chunk.
    assert.deepEqual(chunkPlan(900_000), { chunkSize: 900_000, totalChunkCount: 1 });
    assert.deepEqual(chunkPlan(MAX_CHUNK), { chunkSize: MAX_CHUNK, totalChunkCount: 1 });
  });

  it('rounds the count DOWN, so no chunk falls under the floor', () => {
    // 64 MiB chunks over 200 MiB is 3.125 -> 3, and the last chunk carries
    // the extra. Rounding up would make a final chunk of 8 MiB... fine here,
    // but at 129 MiB it would make one of 1 MiB, which TikTok rejects.
    const plan = chunkPlan(200 * 1024 * 1024);
    assert.equal(plan.chunkSize, MAX_CHUNK);
    assert.equal(plan.totalChunkCount, 3);
  });

  it('refuses a file it cannot describe', () => {
    assert.throws(() => chunkPlan(0), TikTokError);
    assert.throws(() => chunkPlan(NaN), TikTokError);
  });
});

describe('chunkRange', () => {
  it('covers the file exactly, with the remainder in the last chunk', () => {
    const size = 200 * 1024 * 1024;
    const plan = chunkPlan(size);
    const ranges = Array.from({ length: plan.totalChunkCount }, (_, i) => chunkRange(i, plan, size));

    assert.equal(ranges[0].start, 0);
    // No gap and no overlap between neighbours.
    for (let i = 1; i < ranges.length; i += 1) assert.equal(ranges[i].start, ranges[i - 1].end + 1);
    // The last byte of the file is the last byte sent.
    assert.equal(ranges.at(-1).end, size - 1);
    assert.equal(
      ranges.reduce((total, r) => total + r.length, 0),
      size,
    );
    // And the final chunk is the big one, not a short tail.
    assert.ok(ranges.at(-1).length > MAX_CHUNK);
  });

  it('a one-chunk file is the whole file', () => {
    const size = 14_000_000;
    assert.deepEqual(chunkRange(0, chunkPlan(size), size), { start: 0, end: size - 1, length: size });
  });
});

describe('refreshAccess', () => {
  it('hands back the rotated refresh token', async () => {
    const fetchImpl = async () =>
      okJson({ access_token: 'at', refresh_token: 'NEW', expires_in: 7200, refresh_expires_in: 15_552_000, open_id: 'oid' });
    const { accessToken, token } = await refreshAccess(KEYS, 'OLD', { fetchImpl, now: 1_000_000 });
    assert.equal(accessToken, 'at');
    assert.equal(token.refreshToken, 'NEW');
    // Remaining seconds turned into instants, so nothing hard-codes a lifetime.
    assert.equal(token.expiresAt, 1_000_000 + 7_200_000);
    assert.equal(token.refreshExpiresAt, 1_000_000 + 15_552_000_000);
  });

  it('keeps the old refresh token if TikTok returns none', async () => {
    const fetchImpl = async () => okJson({ access_token: 'at' });
    const { token } = await refreshAccess(KEYS, 'OLD', { fetchImpl });
    assert.equal(token.refreshToken, 'OLD');
  });

  it('an error in a 200 body is still an error', async () => {
    // TikTok answers 200 with {"error": "invalid_grant"} rather than a 4xx.
    const fetchImpl = async () => okJson({ error: 'invalid_grant', error_description: 'gone', log_id: 'l' });
    await assert.rejects(refreshAccess(KEYS, 'OLD', { fetchImpl }), (err) => err.kind === 'auth');
  });
});

describe('accessTokenFor', () => {
  it('saves the rotated token BEFORE using it', async () => {
    // This is the one that bites: TikTok retires the refresh token it was
    // sent. Not saving the new one disconnects the account on the next run,
    // and the owner has to reconnect for no reason.
    const saved = [];
    const fetchImpl = async () => okJson({ access_token: 'at', refresh_token: 'NEW', expires_in: 7200 });
    const token = await accessTokenFor(KEYS, {
      load: async () => ({ refreshToken: 'OLD', openId: 'oid' }),
      save: async (t) => saved.push(t),
      fetchImpl,
    });

    assert.equal(token, 'at');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].refreshToken, 'NEW');
    // Fields the refresh did not mention survive the write.
    assert.equal(saved[0].openId, 'oid');
  });

  it('writes nothing when the token did not rotate', async () => {
    const saved = [];
    const fetchImpl = async () => okJson({ access_token: 'at', refresh_token: 'SAME' });
    await accessTokenFor(KEYS, { load: async () => ({ refreshToken: 'SAME' }), save: async (t) => saved.push(t), fetchImpl });
    assert.equal(saved.length, 0);
  });

  it('says it is not connected rather than calling TikTok with nothing', async () => {
    let calls = 0;
    await assert.rejects(
      accessTokenFor(KEYS, {
        load: async () => null,
        fetchImpl: async () => {
          calls += 1;
          return okJson({});
        },
      }),
      (err) => err.kind === 'auth',
    );
    assert.equal(calls, 0);
  });
});

describe('exchangeCode', () => {
  it('sends the redirect_uri back, which TikTok requires', async () => {
    let sent;
    const fetchImpl = async (url, options) => {
      sent = new URLSearchParams(options.body.toString());
      return okJson({ access_token: 'at', refresh_token: 'rt', open_id: 'oid', scope: SCOPE });
    };
    const token = await exchangeCode(KEYS, 'thecode', { fetchImpl, now: 5 });
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('code'), 'thecode');
    assert.equal(sent.get('redirect_uri'), KEYS.redirectUri);
    assert.equal(token.refreshToken, 'rt');
    assert.equal(token.openId, 'oid');
  });

  it('refuses a sign-in that came back with no refresh token', async () => {
    const fetchImpl = async () => okJson({ access_token: 'at' });
    await assert.rejects(exchangeCode(KEYS, 'c', { fetchImpl }), (err) => err.kind === 'auth');
  });
});

describe('initUpload', () => {
  it('reserves an upload and describes the file the way TikTok asks', async () => {
    let body;
    const fetchImpl = async (url, options) => {
      assert.equal(url, 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
      assert.equal(options.headers.authorization, 'Bearer at');
      body = JSON.parse(options.body);
      return ok({ publish_id: 'v_inbox_file~v2.1', upload_url: 'https://upload/x?id=1' });
    };

    const result = await initUpload({ token: 'at', size: 14_000_000, fetchImpl });

    assert.deepEqual(body, {
      source_info: { source: 'FILE_UPLOAD', video_size: 14_000_000, chunk_size: 14_000_000, total_chunk_count: 1 },
    });
    assert.equal(result.publishId, 'v_inbox_file~v2.1');
    assert.equal(result.uploadUrl, 'https://upload/x?id=1');
  });

  it('treats an error code inside a 200 as a failure', async () => {
    // error.code is "ok" on success; anything else means it did not work,
    // whatever the HTTP status says.
    const fetchImpl = async () => okJson({ error: { code: 'spam_risk_too_many_pending_share', message: 'too many' } });
    await assert.rejects(initUpload({ token: 'at', size: 10, fetchImpl }), (err) => err.kind === 'quota');
  });

  it('a 200 with no upload address is not a success', async () => {
    const fetchImpl = async () => ok({ publish_id: 'p1' });
    await assert.rejects(initUpload({ token: 'at', size: 10, fetchImpl }), (err) => err.kind === 'transient');
  });
});

describe('putChunk and uploadVideo', () => {
  let dir;
  let file;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tiktok-test-'));
    file = join(dir, 'short.mp4');
    await writeFile(file, Buffer.alloc(2048, 7));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const range = { start: 0, end: 2047, length: 2048 };

  it('reads 206 as more wanted and 201 as finished', async () => {
    assert.equal(await putChunk({ uploadUrl: 'u', file, size: 4096, range, fetchImpl: async () => ({ status: 206 }) }), 'more');
    assert.equal(await putChunk({ uploadUrl: 'u', file, size: 2048, range, fetchImpl: async () => ({ status: 201 }) }), 'done');
  });

  it('sends the byte range TikTok expects', async () => {
    let headers;
    await putChunk({
      uploadUrl: 'u',
      file,
      size: 2048,
      range,
      fetchImpl: async (url, options) => {
        headers = options.headers;
        return { status: 201 };
      },
    });
    assert.equal(headers['content-range'], 'bytes 0-2047/2048');
    assert.equal(headers['content-length'], '2048');
    assert.equal(headers['content-type'], 'video/mp4');
  });

  it('an expired upload address is worth another go, not a skip', async () => {
    // 403/404/416 mean the reservation is stale: start again from init.
    for (const status of [403, 404, 416]) {
      await assert.rejects(
        putChunk({ uploadUrl: 'u', file, size: 2048, range, fetchImpl: async () => ({ status }) }),
        (err) => err.kind === 'transient',
      );
    }
  });

  it('a dropped connection mid-send is uncertain, never retried blind', async () => {
    await assert.rejects(
      putChunk({
        uploadUrl: 'u',
        file,
        size: 2048,
        range,
        fetchImpl: async () => {
          throw new Error('socket hang up');
        },
      }),
      (err) => err.kind === 'uncertain',
    );
  });

  it('uploads a short and confirms it reached the inbox', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(url);
      if (url.includes('/init/')) return ok({ publish_id: 'p1', upload_url: 'https://upload/x' });
      if (url.includes('/status/fetch/')) {
        assert.deepEqual(JSON.parse(options.body), { publish_id: 'p1' });
        return ok({ status: 'SEND_TO_USER_INBOX' });
      }
      return { status: 201 };
    };

    const result = await uploadVideo({ token: 'at', file, fetchImpl, sleep: async () => {} });

    assert.equal(result.publishId, 'p1');
    assert.equal(result.status, 'SEND_TO_USER_INBOX');
    // init, one PUT, one status check: a 2 KB file is a single chunk.
    assert.equal(calls.length, 3);
  });

  it('throws with the right kind when TikTok rejects the video', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/init/')) return ok({ publish_id: 'p1', upload_url: 'https://upload/x' });
      if (url.includes('/status/fetch/')) return ok({ status: 'FAILED', fail_reason: 'duration_check_failed' });
      return { status: 201 };
    };
    await assert.rejects(
      uploadVideo({ token: 'at', file, fetchImpl, sleep: async () => {} }),
      (err) => err.kind === 'refused' && /duration_check_failed/.test(err.message),
    );
  });

  it('a confirm it cannot reach is reported, not treated as a failed upload', async () => {
    // The bytes are in. Failing here would re-spend a slot on a video TikTok
    // already has.
    const fetchImpl = async (url) => {
      if (url.includes('/init/')) return ok({ publish_id: 'p1', upload_url: 'https://upload/x' });
      if (url.includes('/status/fetch/')) throw new Error('fetch failed');
      return { status: 201 };
    };
    const result = await uploadVideo({ token: 'at', file, fetchImpl, sleep: async () => {} });
    assert.equal(result.publishId, 'p1');
    assert.equal(result.status, null);
    assert.match(result.confirmError, /fetch failed/);
  });

  it('still processing after the last look is not a failure', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/init/')) return ok({ publish_id: 'p1', upload_url: 'https://upload/x' });
      if (url.includes('/status/fetch/')) return ok({ status: 'PROCESSING_UPLOAD' });
      return { status: 201 };
    };
    const result = await uploadVideo({ token: 'at', file, fetchImpl, confirmTries: 2, sleep: async () => {} });
    assert.equal(result.status, 'PROCESSING_UPLOAD');
  });
});

describe('postStatus', () => {
  it('passes the failure reason through', async () => {
    const fetchImpl = async () => ok({ status: 'FAILED', fail_reason: 'spam_risk_too_many_posts' });
    assert.deepEqual(await postStatus({ token: 'at', publishId: 'p1', fetchImpl }), {
      status: 'FAILED',
      failReason: 'spam_risk_too_many_posts',
    });
  });
});

describe('failKind', () => {
  it('follows what TikTok says about retrying', () => {
    assert.equal(failKind('internal'), 'transient');
    assert.equal(failKind('file_format_check_failed'), 'refused');
    assert.equal(failKind('auth_removed'), 'auth');
    assert.equal(failKind('spam_risk_user_banned_from_posting'), 'blocked');
    assert.equal(failKind('spam_risk_too_many_posts'), 'quota');
    // An undocumented reason is left uncertain rather than guessed at.
    assert.equal(failKind('something_new'), 'uncertain');
    assert.equal(failKind(null), 'uncertain');
  });
});

describe('the documented caps', () => {
  it('are the numbers the scheduler is built on', () => {
    assert.equal(PENDING_CAP, 5);
    assert.equal(CAP_WINDOW_MS, 24 * 3600_000);
  });
});
