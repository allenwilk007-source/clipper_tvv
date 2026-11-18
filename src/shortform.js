// Turning a cut into something you could post.
//
// A 9:16 frame with a caption burned in, loudness evened out, and a text file
// beside it holding the post copy and the credit. That is where this module
// stops: it writes a file to disk. Posting it is a separate, deliberate step
// this tool does not take.
//
// Most of what is here is about text, because text is where burning captions
// in goes wrong quietly:
//
//   * drawtext expands `%{...}` sequences, and Twitch titles contain `%`. A
//     title of "100% cooked" would otherwise be interpreted, not printed.
//   * the font path on Windows starts with a drive letter, and the colon in
//     "C:" is the option separator in a filtergraph. Unescaped, the path is
//     split in half and the error names neither the font nor the cause.
//   * a font has no glyph for most emoji or for non-Latin scripts, and the
//     result is a row of empty boxes in the most prominent part of the frame.
//
// So the caption goes in via `textfile=` (no in-graph quoting of what anyone
// typed), expansion is switched off, the character set is pinned to what the
// font can draw, and every path goes through one tested escaping function.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { config } from './config.js';
import { formatClipTimestamp, run, verticalFilter } from './clip.js';

const env = process.env;

const DEFAULT_FONT =
  process.platform === 'win32'
    ? 'C:/Windows/Fonts/seguibl.ttf' // Segoe UI Black: heavy, legible at phone size
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

export const shortformConfig = () => ({
  font: env.SHORTS_FONT || DEFAULT_FONT,
  hashtags: (env.SHORTS_HASHTAGS ?? '#gta6 #gtavi #gaming #twitch').trim(),
  // Short-form platforms normalise loudness on their side; delivering near
  // their target means the clip is not turned down, or up into the noise.
  loudness: Number(env.SHORTS_LUFS) || -14,
});

// ---------------------------------------------------------------------------
// Caption text
// ---------------------------------------------------------------------------

// Everything the default fonts can draw: Latin letters with their accents,
// digits, and ordinary punctuation. Anything else would render as tofu.
const UNDRAWABLE = /[^\p{Script=Latin}\p{N}\s.,!?'"&:;()\-–—…%$#@+/]/gu;

/**
 * A title made fit to print over video.
 *
 * Twitch stream titles are mostly furniture — "GTA 6 DAY 1 | !merch !discord
 * [DROPS ON]" — so the first `|` segment is kept and the furniture goes. Clip
 * titles are usually written by the clipper and survive this untouched.
 * Returns '' when nothing worth printing is left, so the caller can fall back.
 */
export function cleanCaption(raw) {
  const text = String(raw ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)![\w-]+/g, ' ')
    .replace(/[[(【][^\])】]{0,40}[\])】]/g, ' ')
    .replace(/(^|\s)#\w+/g, ' ');

  const first = text
    .split(/\s*(?:\||•|\/\/|~)\s*/)
    .map((part) =>
      part
        .replace(UNDRAWABLE, ' ')
        .split(/\s+/)
        // Stripping undrawable characters can strand the punctuation around
        // them ("%{pts}" leaves a bare "%"). A token with no letter or digit
        // left in it is debris, unless it is the "!!!" or "???" itself.
        .filter((token) => /[\p{L}\p{N}]/u.test(token) || /^[!?…]+$/.test(token))
        .join(' ')
        .trim(),
    )
    .find((part) => part.length > 0);

  const cleaned = (first || '').replace(/^[\s,.;:\-–—]+|[\s,;:\-–—]+$/g, '');
  const letters = cleaned.replace(/[^\p{L}\p{N}]/gu, '').length;
  return letters >= 3 ? cleaned : '';
}

/**
 * Greedy word wrap into at most `maxLines` lines of `maxChars`.
 *
 * drawtext does not wrap, so a long caption would run straight off both edges
 * of a 1080-wide frame. 16 characters at the default size keeps a line clear
 * of the column of buttons TikTok and Reels draw down the right-hand side.
 */
export function wrapCaption(text, { maxChars = 16, maxLines = 3 } = {}) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (let word of words) {
    // A single word longer than a line is split rather than allowed to overflow.
    while (word.length > maxChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  return kept;
}

// What chat was doing, said the way a caption would say it. Only used when it
// is backed by evidence: a class has to have actually spiked to be named.
export const REACTION_HOOKS = {
  clipit: 'CHAT SAID CLIP IT',
  funny: 'CHAT LOST IT',
  shock: 'WAIT WHAT',
  hype: "LET'S GO",
  tension: 'OH NO',
};

/** The reaction class that spiked hardest, or null if none clearly did. */
export function dominantReaction(chat, { minZ = 2 } = {}) {
  let best = null;
  for (const [name, stats] of Object.entries(chat?.classes || {})) {
    const z = Number(stats?.z);
    if (!Number.isFinite(z) || z < minZ || !REACTION_HOOKS[name]) continue;
    if (!best || z > best.z) best = { name, z };
  }
  return best?.name || null;
}

/**
 * The headline for a moment.
 *
 * A clip title is a human describing this exact moment, so it wins when there
 * is one. A chat-only moment carries the *stream* title, which describes the
 * whole broadcast rather than the thirty seconds being posted, so there the
 * reaction hook goes first.
 */
export function captionFor(moment, { game = config.gameName } = {}) {
  const title = cleanCaption(moment?.title);
  const hook = REACTION_HOOKS[dominantReaction(moment?.chat)] || '';
  const chatOnly = moment?.source === 'chat';

  const pick = chatOnly ? hook || title : title || hook;
  if (pick) return pick;

  const who = cleanCaption(moment?.broadcaster).toUpperCase();
  const what = String(game || '').toUpperCase();
  return who ? `${who} IN ${what}`.trim() : what || 'WATCH THIS';
}

/** The on-screen credit. Empty when the name has nothing the font can draw. */
export function creditFor(moment) {
  const name = String(moment?.broadcaster || '').replace(UNDRAWABLE, '').trim();
  return name ? `@${name} on Twitch` : '';
}

/** Twitch's `?t=` format: 1h02m03s. */
export function twitchTime(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
}

/**
 * The text to paste when posting: caption, credit with a link straight to the
 * moment in the full stream, and tags.
 */
export function postTextFor(moment, { caption, start, hashtags = shortformConfig().hashtags } = {}) {
  const who = String(moment?.broadcaster || '').trim();
  const login = who.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const vod = String(moment?.vodId || '').replace(/^v/, '');
  const tags = [hashtags, login ? `#${login}` : ''].filter(Boolean).join(' ');

  return [
    caption || captionFor(moment),
    '',
    who ? `Credit: ${who} on Twitch` : null,
    vod ? `Full stream: https://www.twitch.tv/videos/${vod}?t=${twitchTime(start)}` : null,
    '',
    tags,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/**
 * A path made safe to sit inside a filtergraph option value.
 *
 * Two layers of escaping apply, and both are needed: the option parser splits
 * on `:` (so the drive letter in `C:/...` has to become `C\:`), and the graph
 * parser then treats `\ ' [ ] , ;` as its own syntax (so that backslash has
 * to be escaped again). Backslash separators become forward slashes first,
 * which ffmpeg accepts on Windows and which removes most of the problem.
 */
export function escapeFilterPath(path) {
  const forward = String(path).replace(/\\/g, '/');
  const option = forward.replace(/[\\':]/g, '\\$&');
  return option.replace(/[\\'[\],;]/g, '\\$&');
}

/**
 * The full argument list for one short. Pure, so the graph can be tested.
 * `creditPath` may be null, in which case no credit line is drawn.
 */
export function shortformArgs({
  input,
  output,
  captionPath,
  creditPath = null,
  font,
  hasAudio = true,
  width = 1080,
  height = 1920,
  loudness = -14,
}) {
  const fontfile = escapeFilterPath(font);
  const titleSize = Math.round(width * 0.07);
  const creditSize = Math.round(width * 0.041);
  const outline = Math.max(2, Math.round(width * 0.0065));

  // The title sits in the middle of the blurred band above the picture,
  // clear of the "Following | For You" strip at the very top. The credit sits
  // just under the picture, above the description overlay at the bottom.
  const title =
    `drawtext=fontfile=${fontfile}:textfile=${escapeFilterPath(captionPath)}:expansion=none` +
    `:text_align=C:fontsize=${titleSize}:fontcolor=white:borderw=${outline}:bordercolor=black` +
    `:line_spacing=${Math.round(titleSize * 0.14)}:x=(w-text_w)/2:y=h*0.17-text_h/2`;
  const credit = creditPath
    ? `,drawtext=fontfile=${fontfile}:textfile=${escapeFilterPath(creditPath)}:expansion=none` +
      `:fontsize=${creditSize}:fontcolor=white:borderw=${Math.max(2, outline - 2)}:bordercolor=black` +
      `:x=(w-text_w)/2:y=h*0.70`
    : '';

  const base = verticalFilter({ width, height });
  const chains = [`[0:v]${base}[base]`, `[base]${title}${credit}[v]`];
  // loudnorm works internally at 192 kHz and hands that rate on unless told
  // otherwise, which some players and upload pipelines reject outright.
  if (hasAudio) chains.push(`[0:a]loudnorm=I=${loudness}:TP=-1.5:LRA=11,aresample=48000[a]`);

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[v]',
    ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '160k'] : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ];
}

async function hasAudioStream(input) {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', input],
      { cwd: config.root, label: 'ffprobe' },
    );
    return stdout.trim().length > 0;
  } catch {
    return true; // let ffmpeg give the real error if the file is unreadable
  }
}

/**
 * Render a captioned 9:16 short from a landscape cut, and write the post copy
 * beside it. Returns {path, textPath, caption}.
 */
export async function renderShort({
  input,
  output,
  moment,
  start = 0,
  workDir = dirname(input),
  onProgress = () => {},
  settings = shortformConfig(),
}) {
  if (!existsSync(settings.font)) {
    throw new Error(`caption font not found at ${settings.font} — set SHORTS_FONT to a .ttf file`);
  }

  const caption = captionFor(moment);
  const credit = creditFor(moment);
  const stem = basename(output, extname(output));

  await mkdir(dirname(output), { recursive: true });
  await mkdir(workDir, { recursive: true });

  // Written beside the source, not the output, so nothing half-made ever
  // appears in the folder someone is picking finished posts out of.
  const captionPath = join(workDir, `${stem}.caption.txt`);
  const creditPath = credit ? join(workDir, `${stem}.credit.txt`) : null;
  await writeFile(captionPath, wrapCaption(caption).join('\n'), 'utf8');
  if (creditPath) await writeFile(creditPath, credit, 'utf8');

  // Rendered beside the source and moved into place only once complete. A
  // stopped process would otherwise leave a truncated mp4 in the ready folder,
  // which is exactly the folder someone picks files to post from.
  const partial = join(workDir, `${stem}.rendering.mp4`);
  const partialText = join(workDir, `${stem}.rendering.txt`);

  try {
    const args = shortformArgs({
      input,
      output: partial,
      captionPath,
      creditPath,
      font: settings.font,
      hasAudio: await hasAudioStream(input),
      loudness: settings.loudness,
    });
    onProgress({ stage: 'short', percent: 0, message: 'rendering short' });
    await run('ffmpeg', args, {
      cwd: config.root,
      label: 'ffmpeg',
      onLine: (line) => {
        const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
        if (match) {
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          onProgress({ stage: 'short', seconds, message: `rendering short ${formatClipTimestamp(seconds)}` });
        }
      },
    });
    await writeFile(partialText, postTextFor(moment, { caption, start, hashtags: settings.hashtags }), 'utf8');

    const textPath = join(dirname(output), `${stem}.txt`);
    await moveInto(partial, output);
    await moveInto(partialText, textPath);
    return { path: output, textPath, caption };
  } finally {
    await rm(captionPath, { force: true });
    if (creditPath) await rm(creditPath, { force: true });
    await rm(partial, { force: true });
    await rm(partialText, { force: true });
  }
}

// rename is atomic on one volume. AUTOCLIP_DIR may point at another drive
// (a synced folder, say), where rename refuses and a copy has to do.
async function moveInto(from, to) {
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
