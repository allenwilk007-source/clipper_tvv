import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { clipWindow, normalizeVodId } from './clip.js';
import { clipQueueStatus, enqueueClip, getClipJob, publicJob } from './clipjobs.js';
import { config, credentialsMissing, root } from './config.js';
import { Feed } from './feed.js';

// Enough for the biggest plausible clip request and nothing like enough to be
// worth sending as a denial-of-service payload.
const MAX_BODY_BYTES = 4096;

const PUBLIC_DIR = join(root, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const feed = new Feed();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function sendStatic(res, urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  // normalize then confirm the result is still inside PUBLIC_DIR
  const target = join(PUBLIC_DIR, normalize(requested));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(500).end('server error');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);

  if (url.pathname === '/api/feed') {
    // ?demo=1 renders the UI off a fixture, so the layout can be checked while
    // the category is still empty.
    if (url.searchParams.has('demo')) {
      const { demoSnapshot } = await import('./demo.js');
      sendJson(res, 200, demoSnapshot());
      return;
    }
    if (credentialsMissing) {
      sendJson(res, 503, {
        error: 'missing_credentials',
        message:
          'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env, then restart. See README.',
      });
      return;
    }
    sendJson(res, 200, feed.snapshot());
    return;
  }

  // POST /api/clip  {vodId, offsetSeconds, pre, post, vertical}  ->  {id}
  //
  // The work is a subprocess that outlives any sane request timeout, so this
  // only validates and queues. GET /api/clip/:id reports the rest.
  if (url.pathname === '/api/clip' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'bad_request', message: err.message });
      return;
    }

    // Validate here, not in the worker: a bad vodId should come back as a 400
    // the card can show, not as a failed job the operator has to go read.
    let vodId;
    let window;
    try {
      vodId = normalizeVodId(body.vodId);
      window = clipWindow({
        offsetSeconds: body.offsetSeconds,
        pre: body.pre,
        post: body.post,
      });
    } catch (err) {
      sendJson(res, 400, { error: 'bad_request', message: err.message });
      return;
    }

    const job = enqueueClip({
      vodId,
      offsetSeconds: window.offset,
      pre: window.pre,
      post: window.post,
      vertical: Boolean(body.vertical),
      broadcaster: typeof body.broadcaster === 'string' ? body.broadcaster : '',
      momentId: typeof body.momentId === 'string' ? body.momentId : null,
    });

    sendJson(res, 202, { job: publicJob(job), queue: clipQueueStatus(), window });
    return;
  }

  if (url.pathname.startsWith('/api/clip/')) {
    const job = getClipJob(decodeURIComponent(url.pathname.slice('/api/clip/'.length)));
    if (!job) {
      sendJson(res, 404, { error: 'unknown_job', message: 'no such clip job' });
      return;
    }
    sendJson(res, 200, { job: publicJob(job), queue: clipQueueStatus() });
    return;
  }

  if (url.pathname === '/api/clip') {
    sendJson(res, 405, { error: 'method_not_allowed', message: 'POST a clip request here' });
    return;
  }

  if (url.pathname === '/api/status') {
    sendJson(res, 200, {
      ok: !credentialsMissing,
      credentials: credentialsMissing ? 'missing' : 'present',
      game: feed.game ? { id: feed.game.id, name: feed.game.name } : null,
      started: feed.started,
      lastError: feed.lastError,
      clips: { ...clipQueueStatus(), dir: config.clipDir },
    });
    return;
  }

  await sendStatic(res, url.pathname);
});

server.listen(config.port, async () => {
  console.log(`\n  saturation feed  ->  http://localhost:${config.port}\n`);

  if (credentialsMissing) {
    console.log('  No Twitch credentials yet.');
    console.log('  1. cp .env.example .env');
    console.log('  2. add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET');
    console.log('     (register an app at https://dev.twitch.tv/console/apps)');
    console.log('  3. restart\n');
    console.log('  The page is up and will explain the same thing.\n');
    return;
  }

  try {
    await feed.start();
  } catch (err) {
    console.error(`  Could not start the feed: ${err.message}`);
    if (err.body) console.error(`  ${err.body}`);
  }
});

const shutdown = () => {
  feed.stop();
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
