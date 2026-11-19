import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  PUBLISH_CAP,
  SCOPE,
  authUrl,
  classify,
  connect,
  createContainer,
  failKind,
  findAccount,
  longLivedToken,
  publishingLimit,
  sendBytes,
  tokensFor,
  uploadVideo,
} from './instagram.js';

const KEYS = { appId: 'app', appSecret: 'sec', redirectUri: 'http://localhost:3000/auth/instagram/callback' };

const okJson = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => body });
const fail = (body, status = 400) => ({ ok: false, status, statusText: 'Bad', json: async () => body });
const metaError = (code, subcode) => ({ error: { message: 'nope', type: 'OAuthException', code, error_subcode: subcode } });

describe('authUrl', () => {
  it('asks for the four permissions publishing actually needs', () => {
    assert.equal(SCOPE, 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement');
    const url = new URL(authUrl(KEYS, 'st8'));
    assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v27.0/dialog/oauth');
    assert.equal(url.searchParams.get('scope'), SCOPE);
    assert.equal(url.searchParams.get('state'), 'st8');
    assert.equal(url.searchParams.get('response_type'), 'code');
  });
});

describe('classify', () => {
  it('reads the subcode first, because the code is coarse and reused', () => {
    // 2207042 and 2207026 both arrive under unhelpful top-level codes.
    assert.equal(classify(400, metaError(9, 2207042)), 'quota');
    assert.equal(classify(400, metaError(352, 2207026)), 'refused');
    assert.equal(classify(400, metaError(-1, 2207053)), 'refused');
    assert.equal(classify(400, metaError(24, 2207008)), 'transient');
    assert.equal(classify(400, metaError(9007, 2207027)), 'transient');
  });

  it('a restricted or spam-flagged account is the account, not the video', () => {
    // Marking these "refused" would strike off a short a slot, for ever,
    // while the real problem is untouched.
    assert.equal(classify(400, metaError(4, 2207051)), 'blocked');
    assert.equal(classify(400, metaError(25, 2207050)), 'blocked');
    assert.equal(classify(400, metaError(368)), 'blocked');
  });

  it('tells a dead token from a busy one', () => {
    assert.equal(classify(400, metaError(190)), 'auth');
    assert.equal(classify(400, metaError(102)), 'auth');
    // 4, 17 and 32 are rate limits: the account is fine, come back later.
    for (const code of [4, 17, 32, 80001, 80002]) assert.equal(classify(400, metaError(code)), 'transient');
  });

  it('believes Meta when it says a failure is temporary', () => {
    assert.equal(classify(400, { error: { code: 1234, is_transient: true } }), 'transient');
    assert.equal(classify(503, {}), 'transient');
  });
});

describe('failKind', () => {
  it('maps a container ERROR reason to what to do about it', () => {
    assert.equal(failKind('internal'), 'transient');
    assert.equal(failKind('duration_check_failed'), 'refused');
    assert.equal(failKind('ASPECT_RATIO_CHECK_FAILED'), 'refused');
    // Unknown is left uncertain rather than guessed at.
    assert.equal(failKind('something_new'), 'uncertain');
    assert.equal(failKind(null), 'uncertain');
  });
});

describe('longLivedToken', () => {
  it('swaps the hour-long token for the sixty-day one', async () => {
    let sent;
    const fetchImpl = async (url) => {
      sent = new URL(url);
      return okJson({ access_token: 'LONG', token_type: 'bearer', expires_in: 5_183_944 });
    };
    const result = await longLivedToken(KEYS, 'SHORT', { fetchImpl, now: 1_000_000 });

    assert.equal(sent.searchParams.get('grant_type'), 'fb_exchange_token');
    assert.equal(sent.searchParams.get('fb_exchange_token'), 'SHORT');
    assert.equal(result.userToken, 'LONG');
    assert.equal(result.userTokenExpiresAt, 1_000_000 + 5_183_944_000);
  });
});

describe('findAccount', () => {
  const PAGES = { data: [{ id: 'p1', name: 'My Page', access_token: 'PAGETOKEN', tasks: ['MANAGE', 'CREATE_CONTENT'] }] };

  it('walks from the user to a Page to the Instagram account', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/me/accounts')) return okJson(PAGES);
      return okJson({ id: 'p1', instagram_business_account: { id: 'ig1', username: 'clipper' } });
    };
    const account = await findAccount('USER', { fetchImpl });
    assert.deepEqual(account, { igUserId: 'ig1', username: 'clipper', pageId: 'p1', pageName: 'My Page', pageToken: 'PAGETOKEN' });
  });

  it('falls back to the other name for the link', async () => {
    // Which field carries the link is the one thing the docs did not pin
    // down, so both are tried before giving up.
    const fetchImpl = async (url) => {
      if (url.includes('/me/accounts')) return okJson(PAGES);
      return okJson({ id: 'p1', connected_instagram_account: { id: 'ig2' } });
    };
    assert.equal((await findAccount('USER', { fetchImpl })).igUserId, 'ig2');
  });

  it('says what to do when there is no Page at all', async () => {
    const fetchImpl = async () => okJson({ data: [] });
    await assert.rejects(findAccount('USER', { fetchImpl }), (err) => err.kind === 'refused' && /Facebook Page/.test(err.message));
  });

  it('says what to do when a Page has no Instagram account on it', async () => {
    const fetchImpl = async (url) => (url.includes('/me/accounts') ? okJson(PAGES) : okJson({ id: 'p1' }));
    await assert.rejects(findAccount('USER', { fetchImpl }), (err) => err.kind === 'refused' && /link the account/.test(err.message));
  });

  it('skips a Page the owner cannot post to', async () => {
    // Publishing needs CREATE_CONTENT or MANAGE. A Page with only ANALYZE
    // would fail later, with a far less obvious message.
    const readOnly = { data: [{ id: 'p1', name: 'Read only', access_token: 't', tasks: ['ANALYZE'] }] };
    const fetchImpl = async (url) =>
      url.includes('/me/accounts') ? okJson(readOnly) : okJson({ id: 'p1', instagram_business_account: { id: 'ig1' } });
    await assert.rejects(findAccount('USER', { fetchImpl }), /Create Content or Manage/);
  });

  it('stops on a bad token rather than walking every Page with it', async () => {
    const fetchImpl = async (url) => (url.includes('/me/accounts') ? okJson(PAGES) : fail(metaError(190)));
    await assert.rejects(findAccount('USER', { fetchImpl }), (err) => err.kind === 'auth');
  });
});

describe('connect', () => {
  it('does the whole dance and returns what to store', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('grant_type=fb_exchange_token')) return okJson({ access_token: 'LONG', expires_in: 100 });
      if (url.includes('/oauth/access_token')) return okJson({ access_token: 'SHORT', expires_in: 3600 });
      if (url.includes('/me/accounts')) return okJson({ data: [{ id: 'p1', name: 'P', access_token: 'PT', tasks: ['MANAGE'] }] });
      return okJson({ id: 'p1', instagram_business_account: { id: 'ig1', username: 'u' } });
    };
    const token = await connect(KEYS, 'CODE', { fetchImpl, now: 0 });
    assert.equal(token.userToken, 'LONG');
    assert.equal(token.igUserId, 'ig1');
    assert.equal(token.pageToken, 'PT');
    assert.equal(token.userTokenExpiresAt, 100_000);
  });
});

describe('tokensFor', () => {
  const stored = (over = {}) => ({ userToken: 'LONG', pageToken: 'PT', igUserId: 'ig1', userTokenExpiresAt: 60 * 86_400_000, ...over });

  it('uses the stored tokens when there is plenty of time left', async () => {
    let calls = 0;
    const result = await tokensFor(KEYS, {
      load: async () => stored(),
      fetchImpl: async () => {
        calls += 1;
        return okJson({});
      },
      now: 0,
    });
    assert.equal(calls, 0);
    assert.equal(result.pageToken, 'PT');
    assert.equal(result.igUserId, 'ig1');
  });

  it('renews a week out, and saves the result', async () => {
    // A long-lived token cannot be renewed once it has expired, so waiting
    // until the last day would risk losing it to a day of downtime.
    const saved = [];
    const fetchImpl = async (url) => {
      if (url.includes('grant_type=fb_exchange_token')) return okJson({ access_token: 'FRESH', expires_in: 5_183_944 });
      if (url.includes('/me/accounts')) return okJson({ data: [{ id: 'p1', name: 'P', access_token: 'PT2', tasks: ['MANAGE'] }] });
      return okJson({ id: 'p1', instagram_business_account: { id: 'ig1' } });
    };
    const almostGone = stored({ userTokenExpiresAt: 3 * 86_400_000 });
    const result = await tokensFor(KEYS, { load: async () => almostGone, save: async (t) => saved.push(t), fetchImpl, now: 0 });

    assert.equal(result.userToken, 'FRESH');
    assert.equal(result.pageToken, 'PT2');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].userToken, 'FRESH');
  });

  it('says plainly when the sign-in is past saving', async () => {
    await assert.rejects(
      tokensFor(KEYS, { load: async () => stored({ userTokenExpiresAt: -1 }), now: 0 }),
      (err) => err.kind === 'auth' && /cannot be renewed/.test(err.message),
    );
  });

  it('refuses to post with no account id', async () => {
    await assert.rejects(tokensFor(KEYS, { load: async () => stored({ igUserId: null }), now: 0 }), (err) => err.kind === 'auth');
  });

  it('says it is not connected rather than calling Meta with nothing', async () => {
    await assert.rejects(tokensFor(KEYS, { load: async () => null, now: 0 }), (err) => err.kind === 'auth');
  });
});

describe('createContainer', () => {
  it('asks for a resumable Reel and uses the address Meta hands back', async () => {
    let sent;
    const fetchImpl = async (url) => {
      sent = new URL(url);
      return okJson({ id: 'c1', uri: 'https://rupload.facebook.com/ig-api-upload/v27.0/c1' });
    };
    const result = await createContainer({ token: 'T', igUserId: 'ig1', caption: 'hello #gta6', fetchImpl });

    assert.equal(sent.searchParams.get('media_type'), 'REELS');
    // Without this it is a URL-fetch upload, which cannot work from this PC.
    assert.equal(sent.searchParams.get('upload_type'), 'resumable');
    assert.equal(sent.searchParams.get('caption'), 'hello #gta6');
    assert.equal(result.containerId, 'c1');
    assert.equal(result.uploadUrl, 'https://rupload.facebook.com/ig-api-upload/v27.0/c1');
  });

  it('leaves share_to_feed out when it is switched off', async () => {
    let sent;
    const fetchImpl = async (url) => {
      sent = new URL(url);
      return okJson({ id: 'c1' });
    };
    await createContainer({ token: 'T', igUserId: 'ig1', shareToFeed: false, fetchImpl });
    assert.equal(sent.searchParams.get('share_to_feed'), null);
  });
});

describe('sendBytes and uploadVideo', () => {
  let dir;
  let file;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ig-test-'));
    file = join(dir, 'short.mp4');
    await writeFile(file, Buffer.alloc(4096, 3));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses OAuth on the upload host, not Bearer', async () => {
    // rupload is the one host that wants `OAuth <token>`; Bearer fails there,
    // and the failure looks like a bad sign-in rather than a wrong header.
    let headers;
    await sendBytes({
      uploadUrl: 'https://rupload/x',
      token: 'T',
      file,
      size: 4096,
      fetchImpl: async (url, options) => {
        headers = options.headers;
        return okJson({ success: true });
      },
    });
    assert.equal(headers.authorization, 'OAuth T');
    assert.equal(headers.offset, '0');
    assert.equal(headers.file_size, '4096');
  });

  it('reads the upload host own failure shape', async () => {
    const retriable = { debug_info: { retriable: true, type: 'TransientError', message: 'try again' } };
    await assert.rejects(
      sendBytes({ uploadUrl: 'u', token: 'T', file, size: 4096, fetchImpl: async () => okJson(retriable) }),
      (err) => err.kind === 'transient',
    );
    const permanent = { debug_info: { retriable: false, type: 'ProcessingFailedError', message: 'bad file' } };
    await assert.rejects(
      sendBytes({ uploadUrl: 'u', token: 'T', file, size: 4096, fetchImpl: async () => okJson(permanent) }),
      (err) => err.kind === 'refused',
    );
  });

  it('a dropped connection mid-send is uncertain, never retried blind', async () => {
    await assert.rejects(
      sendBytes({
        uploadUrl: 'u',
        token: 'T',
        file,
        size: 4096,
        fetchImpl: async () => {
          throw new Error('socket hang up');
        },
      }),
      (err) => err.kind === 'uncertain',
    );
  });

  const upload = (statuses, extra = {}) => {
    const seen = [...statuses];
    return async (url) => {
      if (url.includes('/media?')) return okJson({ id: 'c1', uri: 'https://rupload/x' });
      if (url.includes('rupload')) return okJson({ success: true });
      if (url.includes('/media_publish')) return okJson({ id: 'm1' });
      if (url.includes('status_code')) return okJson(seen.shift() || { status_code: 'IN_PROGRESS' });
      return okJson(extra);
    };
  };

  it('waits for the container then publishes', async () => {
    const mediaId = await uploadVideo({
      token: 'T',
      igUserId: 'ig1',
      file,
      caption: 'c',
      fetchImpl: upload([{ status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' }]),
      sleep: async () => {},
    });
    assert.equal(mediaId, 'm1');
  });

  it('does not publish a container that failed', async () => {
    await assert.rejects(
      uploadVideo({
        token: 'T',
        igUserId: 'ig1',
        file,
        fetchImpl: upload([{ status_code: 'ERROR', status: 'duration_check_failed' }]),
        sleep: async () => {},
      }),
      (err) => err.kind === 'refused' && /duration_check_failed/.test(err.message),
    );
  });

  it('still processing after the last look is uncertain, not a clean failure', async () => {
    // The bytes are in and a container may yet publish itself. Calling this
    // "retry" would be how the same Reel goes up twice.
    await assert.rejects(
      uploadVideo({ token: 'T', igUserId: 'ig1', file, fetchImpl: upload([]), tries: 2, sleep: async () => {} }),
      (err) => err.kind === 'uncertain',
    );
  });

  it('sends the caption with the Reel, so credit goes out with it', async () => {
    // Unlike TikTok drafts, this caption IS published: TERMS.md promises a
    // credit line and a link back with every clip, and here it is the only
    // text that carries them.
    let caption;
    const fetchImpl = async (url) => {
      if (url.includes('/media?')) {
        caption = new URL(url).searchParams.get('caption');
        return okJson({ id: 'c1', uri: 'https://rupload/x' });
      }
      if (url.includes('rupload')) return okJson({ success: true });
      if (url.includes('/media_publish')) return okJson({ id: 'm1' });
      return okJson({ status_code: 'FINISHED' });
    };

    await uploadVideo({
      token: 'T',
      igUserId: 'ig1',
      file,
      caption: 'chat could not breathe\nCredit: lirik on Twitch\nFull stream: https://twitch.tv/videos/1',
      fetchImpl,
      sleep: async () => {},
    });

    assert.match(caption, /Credit: lirik on Twitch/);
    assert.match(caption, /https:\/\/twitch\.tv\/videos\/1/);
  });

  it('nothing is published when the upload itself failed', async () => {
    // A container exists at this point. Publishing it anyway would put an
    // empty or broken Reel on the profile.
    let published = false;
    const fetchImpl = async (url) => {
      if (url.includes('/media?')) return okJson({ id: 'c1', uri: 'https://rupload/x' });
      if (url.includes('rupload')) return okJson({ debug_info: { retriable: false, message: 'bad file' } });
      if (url.includes('/media_publish')) {
        published = true;
        return okJson({ id: 'm1' });
      }
      return okJson({ status_code: 'FINISHED' });
    };
    await assert.rejects(uploadVideo({ token: 'T', igUserId: 'ig1', file, fetchImpl, sleep: async () => {} }));
    assert.equal(published, false);
  });
});

describe('publishingLimit', () => {
  it('reads what Instagram itself thinks is used', async () => {
    const fetchImpl = async () => okJson({ data: [{ quota_usage: 12, config: { quota_total: 50, quota_duration: 86400 } }] });
    assert.deepEqual(await publishingLimit({ token: 'T', igUserId: 'ig1', fetchImpl }), { used: 12, total: 50 });
  });

  it('falls back to the documented cap when the config is missing', async () => {
    const fetchImpl = async () => okJson({ data: [{ quota_usage: 3 }] });
    assert.deepEqual(await publishingLimit({ token: 'T', igUserId: 'ig1', fetchImpl }), { used: 3, total: PUBLISH_CAP });
  });
});
