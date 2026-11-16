import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { config, credentialsMissing, root } from './config.js';
import { Feed } from './feed.js';

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

  if (url.pathname === '/api/status') {
    sendJson(res, 200, {
      ok: !credentialsMissing,
      credentials: credentialsMissing ? 'missing' : 'present',
      game: feed.game ? { id: feed.game.id, name: feed.game.name } : null,
      started: feed.started,
      lastError: feed.lastError,
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
