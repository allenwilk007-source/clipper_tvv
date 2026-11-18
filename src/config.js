import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env reader. Real environment variables always win, so the same file can
// sit next to a deployment that sets them properly.
function loadEnvFile() {
  let raw;
  try {
    raw = readFileSync(resolve(root, '.env'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  root,
  port: num(process.env.PORT, 3000),
  clientId: process.env.TWITCH_CLIENT_ID || '',
  clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
  gameName: process.env.GAME_NAME || 'Grand Theft Auto VI',
  gameId: process.env.GAME_ID || '',
  clipWindowMinutes: num(process.env.CLIP_WINDOW_MINUTES, 25),
  clipPollSeconds: num(process.env.CLIP_POLL_SECONDS, 30),
  clipMaxPages: num(process.env.CLIP_MAX_PAGES, 30),
  streamPollSeconds: num(process.env.STREAM_POLL_SECONDS, 120),
  clusterGapSeconds: num(process.env.CLUSTER_GAP_SECONDS, 30),
  leadInSeconds: num(process.env.LEAD_IN_SECONDS, 20),
  chatChannels: num(process.env.CHAT_CHANNELS, 80),
  chatEnabled: process.env.CHAT_ENABLED !== 'false',

  // Local clip extraction. The window is lopsided on purpose: see clip.js.
  clipPre: num(process.env.CLIP_PRE, 25),
  clipPost: num(process.env.CLIP_POST, 5),
  clipDir: resolve(root, process.env.CLIP_DIR || 'clips'),
  clipQuality: process.env.CLIP_QUALITY || '1080',
  clipConcurrency: num(process.env.CLIP_CONCURRENCY, 2),
  // The console scripts shim is broken on some Windows installs, so the
  // module form is the default and the whole command stays configurable.
  ytdlpCmd: process.env.YTDLP_CMD || 'python -m yt_dlp',
};

export const credentialsMissing = !config.clientId || !config.clientSecret;
