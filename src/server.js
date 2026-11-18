import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { clipWindow, normalizeVodId } from './clip.js';
import { clipQueueStatus, enqueueClip, getClipJob, publicJob } from './clipjobs.js';
import { config, credentialsMissing, nothingToRun, root } from './config.js';
import { Automation, SHORT_FILE, parseRange } from './automation.js';
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
const automation = new Automation({ feed, log: (message) => feed.log(message) });

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

/**
 * A finished short, for the automation panel. Only names clipBasename makes
 * are served, and only from the shorts folder. Ranges are honoured because a
 * <video> element cannot seek without them.
 */
async function sendShort(req, res, name, download) {
  if (!SHORT_FILE.test(name)) {
    res.writeHead(404).end('not found');
    return;
  }
  const path = join(automation.dir, name);
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'content-type': name.endsWith('.mp4') ? 'video/mp4' : 'text/plain; charset=utf-8',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${name}"`;

  const range = parseRange(req.headers.range, size);
  if (range?.invalid) {
    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    });
    createReadStream(path, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(path).pipe(res);
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
    // Credentials buy clips and saturation. Chat alone still finds moments, so
    // the feed is only unavailable when there is neither a token nor anybody
    // on the watch list to listen to.
    if (nothingToRun) {
      sendJson(res, 503, {
        error: 'nothing_to_watch',
        message:
          'Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env for the full feed, or set WATCH_CHANNELS to run chat-only. Then restart.',
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

  // GET  /api/automation                     -> channels, switch, finished shorts
  // POST /api/automation {enabled|add|remove}  -> the same, after the change
  if (url.pathname === '/api/automation') {
    if (req.method === 'POST') {
      try {
        automation.update(await readJsonBody(req));
      } catch (err) {
        sendJson(res, 400, { error: 'bad_request', message: err.message });
        return;
      }
    } else if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'GET or POST' });
      return;
    }
    sendJson(res, 200, await automation.view());
    return;
  }

  if (url.pathname.startsWith('/shorts/')) {
    let name = '';
    try {
      name = decodeURIComponent(url.pathname.slice('/shorts/'.length));
    } catch {
      /* malformed escape: falls through to 404 */
    }
    await sendShort(req, res, name, url.searchParams.has('download'));
    return;
  }

  if (url.pathname === '/api/status') {
    sendJson(res, 200, {
      ok: !nothingToRun,
      // Chat-only is a working mode, not a broken one. It finds moments and
      // cannot measure saturation; the caller deserves to know which.
      mode: credentialsMissing ? 'chat-only' : 'full',
      credentials: credentialsMissing ? 'missing' : 'present',
      watchedChannels: feed.channels.size,
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

  if (nothingToRun) {
    console.log('  Nothing to watch.');
    console.log('  Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to .env for the full');
    console.log('  feed (register an app at https://dev.twitch.tv/console/apps), or set');
    console.log('  WATCH_CHANNELS=name,name to run chat-only.');
    console.log('');
    return;
  }

  if (credentialsMissing) {
    console.log(`  No credentials - chat-only on ${automation.settings.channels.length || config.watchChannels.length} channels.`);
    console.log('  Finding moments before anybody clips them is the half that works');
    console.log('  without a token. Saturation is the half that does not.');
    console.log('');
  }

  // Before the feed starts: in chat-only mode the automation's channels are
  // the watch list, and what was already cut has to be known before a poll.
  automation.prepare();
  try {
    await feed.start();
  } catch (err) {
    console.error(`  Could not start the feed: ${err.message}`);
    if (err.body) console.error(`  ${err.body}`);
  }
  automation.start();
  console.log(
    `  Automation is ${automation.settings.enabled ? 'ON' : 'off'} for ` +
      `${automation.settings.channels.length} channel(s) - switch it in the page.`,
  );
});

const shutdown = () => {
  automation.stop();
  feed.stop();
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck socket.
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
