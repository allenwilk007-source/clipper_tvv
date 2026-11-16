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
- **Not verified against live data.** Every path has been exercised against the
  demo fixture and the clustering and ranking are covered by tests, but no run
  against a real category has happened yet. The first real run is the real
  test.

## Configuration

Everything lives in `.env` — see `.env.example` for the annotated list.

`GAME_NAME` is the only field that needs changing to point the whole thing at a
different game. The engine is category-agnostic; GTA 6 is the wedge, not the
product.

## Layout

```
src/twitch.js   Helix client — app token, rate limits, pagination
src/moments.js  clustering + the ranking formula (the product)
src/chat.js     pooled anonymous IRC, median/MAD spike scoring
src/feed.js     polling loops and current state
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
