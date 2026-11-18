# Saturation Feed

A live feed of stream moments that leads with the one number nothing else
shows: **how many clippers already grabbed it.**

Every clipping tool answers "what's hot." Hot is where the crowd already is. A
clipper racing two hundred people to the same forty seconds has already lost.
The useful question is *hot and not yet flooded*, and nobody reports it.

## The trick

A native Twitch clip is a **costly** signal. Chat is free — anyone can type
"LMAOO" — but creating a clip means someone watched something, decided it was
worth keeping, and acted. Cluster those clips by broadcaster and position in
the VOD, and two things fall out of one API call:

- a cluster forming &nbsp;=&nbsp; **a moment happened**
- the cluster's size &nbsp;=&nbsp; **how many people already have it**

Detection and saturation are the same measurement. Chat velocity rides on top
as the *lead* signal — it moves before anyone has finished clipping — but never
declares a moment on its own.

Nothing analyses video. It runs on a laptop.

## Quick start

```bash
npm start
```

Then open <http://localhost:3000>. With no credentials the page tells you what
to do; with credentials it starts polling immediately.

To see the interface before the game is out, when the category is empty:

```bash
npm start
```

and open <http://localhost:3000/?demo=1>.

### Credentials

Twitch's public endpoints still need an app token.

1. Register an app at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
   (OAuth redirect `http://localhost`, category "Application Integration")
2. `cp .env.example .env`
3. Paste the Client ID and a generated Client Secret into `.env`
4. `npm start`

Check it works without launching the server:

```bash
npm run check
```

That resolves the category, counts live channels, pulls the clip window, and
prints the moments it clusters into.

## Clipping a moment

Every card has a **Clip it** button. It cuts the moment out of the broadcaster's
VOD and writes an mp4 into `clips/` — on your own disk, nowhere else. The feed
still only ever indexes and links; nothing here uploads, posts, or rehosts
anything, and that is deliberate rather than unfinished.

### Setup

ffmpeg must be on `PATH`, and yt-dlp installed:

```bash
python -m pip install yt-dlp
```

The default invocation is `python -m yt_dlp` (set `YTDLP_CMD` to change it)
because the `yt-dlp` console-script shim hits a permission error on some
Windows installs while the module form works fine.

**Do not reach for streamlink.** It is the obvious tool for this and it cannot
work on a current Python: streamlink needs `pycryptodome` for HLS AES, and
pycryptodome has no Python 3.14 wheel, so `Crypto.Cipher._raw_aes` fails to
import and every HLS stream dies at the first segment. `--force-reinstall`
does not fix it. An hour has already been spent confirming that; yt-dlp does
the same job here.

### Why the window is lopsided

`CLIP_PRE=25`, `CLIP_POST=5` — twenty-five seconds *before* the timestamp and
five after.

Both signals that put a moment in the feed are reactions. Chat types after the
thing lands. A clipper hits the hotkey after they have already watched it
happen. So the timestamp the feed hands you is the *tail* of the moment, not
its start, and a window centred on it would capture the crowd reacting while
cutting off whatever they were reacting to. The pre-roll is where the clip
actually is.

The cut uses `--download-sections` with `--force-keyframes-at-cuts`, so only
the relevant segments are fetched and the boundaries land on the second asked
for rather than the nearest keyframe (on Twitch, up to two seconds away). The
flag costs a re-encode: a 30s cut at 1080p60 takes around 100 seconds, at 720p
around five. Lower `CLIP_QUALITY` if that matters more than resolution.

### Vertical

Ticking **9:16 copy** writes a second file alongside the first, sized 1080x1920
for Shorts and TikTok. It is not a centre crop — a centre crop of 16:9 throws
away two thirds of the width, and in GTA the thing worth clipping is as often
at the edge of frame as in the middle. Instead a zoomed, blurred copy fills the
tall canvas and the whole original frame sits centred on top of it.

### API

The button is a thin wrapper over two endpoints, so a script can do the same:

```bash
curl -X POST http://localhost:3000/api/clip   -H 'content-type: application/json'   -d '{"vodId":"2931538239","offsetSeconds":3025,"vertical":false}'
# -> 202 {"job":{"id":"...","state":"queued"}, ...}

curl http://localhost:3000/api/clip/<id>
# -> {"job":{"state":"running","progress":44,"message":"cutting 13s", ...}}
```

Jobs live in memory and run two at a time (`CLIP_CONCURRENCY`), because each
one is an ffmpeg re-encode and a third just makes the clip someone is waiting
on slower. They are lost on restart; the mp4 is the artefact worth keeping.

Note that in `?demo=1` the VOD ids are synthetic, so **Clip it** there will
fail with "Video 21 does not exist". That is the fixture being honest, not a
bug — the button needs a real moment.

## Detection: being first, and proving it

Two problems shaped everything in `src/chat.js`, `src/store.js` and
`src/eval.js`, and they are worth stating plainly because they are easy to miss.

**The clip feed structurally cannot be first.** Clips are its only input, so a
moment cannot exist until somebody has already clipped it. `saturation = 1`
means one person beat you. Chat is the only signal available that fires at
saturation ZERO.

**"Best" was unfalsifiable.** The ranking formula had never been checked
against whether the moments it liked went on to do anything, so there was no
way to tell a signal that works from one that merely sounds right.

### Chat-sourced moments

A chat spike with no clips attached now becomes a moment of its own, marked
**chat only** and drawn with a dashed border. Two things about it are honest
compromises, and the card says so rather than hiding them:

- **nobody has clipped it.** It might be nothing. That is the price of being
  first, and it is the right price — a confirmed moment is one you are late to.
- **the VOD offset is estimated** from stream uptime, so it is a good place to
  start looking, not a frame-accurate timestamp.

When clips do show up on the same channel at the same time, the two rows are
merged into one marked `both` — something happened *and* almost nobody has it.

### What chat is reacting with

Message rate alone treats `KEKW`, `CLIP THAT` and `monkaS` as the same event.
They are not. `src/reactions.js` scores each class separately, against its own
baseline:

| class | why it matters |
|---|---|
| `clipit` | chat literally asking for a clip — the highest-precision signal there is, and it gets its own path to nominating a moment even when message rate barely moves |
| `funny` | travels furthest off Twitch, because it needs no context |
| `hype` | high ceiling, short shelf life |
| `tension` | needs setup, which a 15-second vertical cut cannot carry |
| `shock` | strong but often ambiguous |

Plus two structural signals: **unique chatters** (the whole room reacting is a
different event from four people spamming) and **copypasta ratio** (a meme
forming is the best predictor that a moment will leave the platform).

If three or more watched channels spike within the same ten seconds, the moment
is marked **shared** and discounted by half: that is the game doing something,
not the streamer, and every clipper in the category will have it within minutes.

### The scoreboard

```bash
npm run eval
```

Every moment, clip and poll is written to `data/feed.db` (`node:sqlite`, which
is in the Node standard library — the zero-dependency rule still holds). The
clips of moments already seen are re-polled at 15m, 1h, 6h and 24h, which gives
two labels worth having:

- **views at 24h** — did the clip perform?
- **lead time** — seconds between the first clip and the first clip by a
  *different* creator. One person making four clips of their own moment is one
  person, not competition, and counting it otherwise would flatter every number.

`npm run eval` prints precision@20 against the top decile by views, next to
what chance alone would have given you. **Lift above 1.0 means the ranking is
doing something.** Nothing that claims to improve detection ships without
moving that number — including the reaction weights in `src/reactions.js`,
which are a starting position rather than a result.

With no history it says so, rather than printing a confident zero.

### What is kept, and what is not

**No chat is stored.** Messages are folded into per-bucket counts as they
arrive and the bucket is dropped every ten seconds — the store has no column
that could hold a message, and nothing in a bucket summary can be turned back
into what anybody said. At launch volume that is a great deal of text not kept,
and retained chat logs are a liability with no upside: every signal here is
derivable live.

`observations` (one row per moment per poll, around 300 a minute at a 30s
cadence with 150 moments) is pruned to `STORE_PRUNE_DAYS`, except for the
earliest row of each moment, which is what the feed claimed while the moment
was still actionable and therefore what `eval` reads.

`moments`, `clips` and `outcomes` are never pruned. They are what the clipper
index gets built from, they cannot be re-collected after the fact, and they are
small: a measured launch-scale poll of 150 moments and 669 clips writes in one
transaction in under 3ms.

The schema carries a `user_version`, so a later phase can add columns without
throwing away data that cannot be collected twice.

## How a moment gets ranked

```
heat        = log1p(clips per minute) * 2  +  chat z-score
recency     = exp(-minutes since the last clip / 12)
opportunity = heat * recency / (1 + saturation) ^ 0.9
```

The `log1p` matters more than it looks. Clip velocity *is* saturation divided
by span, so feeding raw velocity into the numerator while dividing by
saturation lets the two cancel — the score then climbs with clip count, which
is precisely backwards. A test caught that. Log keeps velocity as evidence the
moment is real while growing far too slowly to out-argue the crowding penalty,
so more clippers on a moment always lowers its rank.

Chat enters raw, because it is the only input independent of how many people
have already clipped.

| state | clips | meaning |
| --- | --- | --- |
| `fresh` | 1–2 | proven interesting, basically untouched |
| `warm` | 3–6 | a few people are on it |
| `flooded` | 7+ | you are late |

Deep links start 20 seconds early (`LEAD_IN_SECONDS`), because chat reacts
after the thing happens and so do clippers.

## Chat scoring

A robust z-score against each channel's **own** recent pace:
`(count − median) / MAD`, in 10-second buckets over 5 minutes of history.

Median and MAD both ignore the spikes themselves, so a channel that pops
repeatedly doesn't quietly raise its own bar and stop detecting its own
moments. Because the score is in units of that channel's volatility, one
threshold works for a 200k-viewer channel and a 2k-viewer one at once — where a
flat "3× busier than usual" fires constantly on a small chat and never on a
large steady one.

Chat is read over pooled anonymous IRC (`justinfan` nicks, 18 channels per
socket, joins paced to Twitch's ~20-per-10s limit). No account, no token, no
quota.

## Known limits

Worth reading before launch night rather than during it.

- **Twitch sorts `/helix/clips` by view count, not creation time.** Over a
  short window that barely matters — brand-new clips all sit near zero views —
  but a truncated result drops the quietest clips first. The feed reports
  truncation instead of hiding it; raise `CLIP_MAX_PAGES` or shorten
  `CLIP_WINDOW_MINUTES` if you see it.
- **VOD position lags.** For a minute or two after a clip is made, Twitch
  hasn't published its `vod_offset`. Those cluster on creation time instead and
  are marked "VOD position pending" — coarser, but it keeps the freshest
  moments in the feed rather than dropping them.
- **Launch week compresses the chat signal.** Every GTA 6 chat will sit at
  maximum excitement for days, so baselines rise everywhere and spikes get
  harder to separate exactly when it matters. Clip-creation rate degrades far
  more gracefully, which is the other reason it's the primary signal.
- **Twitch only.** Kick has no official public API and is hostile to scraping;
  YouTube's live chat API burns quota per poll. Both are deliberately out.
- **Saturation is Twitch-native only.** It counts clips made *on Twitch*. It
  does not know whether a moment has already flooded TikTok — that's a leading
  indicator of flooding, not a measure of it.
- **A clip is only as good as the VOD.** If the broadcaster has VODs disabled,
  or the moment is in a muted or already-deleted segment, the cut fails with
  whatever Twitch says about it. Nothing can be done from this end.
- **Rockstar removes story and spoiler clips**, including after launch, and
  in-game radio music triggers Content ID. Both are reasons to watch what you
  cut, and neither is something the tool can detect for you.
- **The feed is not verified against live data.** Every path has been exercised
  against the demo fixture and the clustering and ranking are covered by tests,
  but no run against a real category has happened yet. The first real run is
  the real test. (Clipping is the exception: it has been run end to end against
  a real public VOD and produces a playable mp4 of exactly the requested
  length.)

## Configuration

Everything lives in `.env` — see `.env.example` for the annotated list.

`GAME_NAME` is the only field that needs changing to point the whole thing at a
different game. The engine is category-agnostic; GTA 6 is the wedge, not the
product.

## Layout

```
src/twitch.js   Helix client — app token, rate limits, pagination
src/moments.js  clustering + the ranking formula (the product)
src/chat.js     pooled anonymous IRC, per-class median/MAD spike scoring
src/reactions.js what chat is reacting WITH — the class table
src/store.js    node:sqlite persistence + outcome recording
src/eval.js     the scoreboard: does the ranking beat chance?
src/feed.js     polling loops and current state
src/clip.js     VOD section download + 9:16 render (yt-dlp/ffmpeg)
src/clipjobs.js in-memory clip queue, two at a time
src/server.js   HTTP + static
src/demo.js     fixture, pushed through the real pipeline
src/check.js    one-shot smoke test
public/         the feed UI
```

```bash
npm test
```

## Not built yet

The data this accumulates — who found a moment first, before it saturated, and
what it went on to do — is an un-fakeable record of which clippers are actually
early. That's the part worth selling, and it isn't here yet.

## History

This repo previously held `clipper.py`, a multi-channel chat-spike clipper with
a DVR ring buffer and ffmpeg cutting. It was removed when the project narrowed
to saturation, but it is not lost — it's at commit `bd1ceec`:

```bash
git show bd1ceec:clipper.py > clipper.py
```

Its median/MAD scoring is the direct ancestor of `src/chat.js`.
