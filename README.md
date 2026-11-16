# gta-6-clipping

Watches Twitch chat on many channels at once, notices when a channel's chat
suddenly jumps well above its own normal pace, and cuts a clip out of a rolling
recording.

Chat is a crude signal — it is free to type, so it reacts to jokes, raids and
nothing at all. But it is the only signal that needs no video understanding,
which is why this runs on a laptop instead of a GPU cluster.

## Requirements

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) on `PATH`
- [streamlink](https://streamlink.github.io/) on `PATH` (`pip install streamlink`)
- optional: `pip install faster-whisper` for captions

No Twitch account, OAuth token or API key. Chat is read over anonymous IRC with
a `justinfan` nick, which is read-only and has no quota.

## Usage

```bash
python clipper.py jynxzi
```

```bash
python clipper.py caseoh_ jynxzi xqc --quality 720p
```

```bash
python clipper.py --channels-file top200.txt --watch-only
```

```bash
python clipper.py jynxzi --captions --z 4.0 --pre 30
```

`--channels-file` takes one channel per line; `#` starts a comment.

Clips land in `clips/session-<timestamp>/<channel>/`, and every spike is
appended to `spikes.jsonl` whether or not it was recorded.

## How it works

1. **streamlink** pipes each live stream into **ffmpeg**, which remuxes it
   (`-c copy`, so no decoding) into fixed-length `.ts` segments.
2. Segments older than `--dvr` are deleted. Disk use is bounded by the window,
   not by how long you leave it running.
3. Chat is read over pooled anonymous IRC connections — one socket carries ~18
   channels — and messages are counted per channel in `--bucket`-second buckets.
4. Each channel is scored against **its own** recent pace as a robust z-score:
   `(count − median) / MAD`. Above `--z`, it's a moment.
5. The segments covering the window are concatenated and re-encoded into an mp4,
   optionally with an `.srt` beside it.

## Three choices worth knowing about

**The baseline is a median and MAD, not a mean and standard deviation.** Both
ignore the spikes themselves, so a channel that pops repeatedly doesn't slowly
raise its own bar and stop detecting its own moments.

**The score is in units of each channel's own volatility**, which is what makes
one threshold work across channel sizes. A fixed "3× the usual" fires constantly
on a small chat and almost never on a huge steady one; 3.5 MADs out means the
same thing to both.

**The clip window is weighted backwards** — 25 s before the spike, 5 s after.
Chat reacts *after* the thing happens, so a window centred on the spike mostly
captures people typing about something that already left the screen.

## Tuning

| flag | default | what it does |
| --- | --- | --- |
| `--bucket` | 10 | seconds per count bucket. Smaller reacts faster and noisier |
| `--history` | 30 | buckets of baseline. 30 × 10 s = 5 min of context |
| `--z` | 3.5 | robust z-score to fire at. Lower = more clips, more junk |
| `--floor` | 20 | absolute messages/bucket minimum. Kills dead-chat noise |
| `--min-rise` | 1.5 | must also be 1.5× the median. Kills tiny absolute bumps |
| `--cooldown` | 60 | seconds between clips, per channel |
| `--pre` / `--post` | 25 / 5 | clip window around the spike |
| `--dvr` | 180 | seconds of rolling recording kept per channel |
| `--segment` | 10 | DVR segment length. Sets cut granularity |
| `--encoders` | auto | concurrent ffmpeg cuts. Auto is `cores / 3`, capped at 4 |

Start with `--watch-only` on a long channel list for an hour. It records
nothing and costs almost nothing, and the resulting `spikes.jsonl` tells you
which channels actually pop — which is where you then point your bandwidth.

## Cost per channel

| quality | bandwidth | DVR at 180 s |
| --- | --- | --- |
| 480p | ~1.5 Mbps | ~34 MB |
| 720p | ~3 Mbps | ~67 MB |
| 1080p60 | ~8 Mbps | ~180 MB |

Multiply by channel count. Bandwidth, not CPU or disk, is the ceiling on how
many channels you can *record* — so monitor widely and record narrowly.

## Known limits

- **Live only.** Twitch does not let you rewind a stream you weren't recording.
  Nothing here can reach back before you started.
- **Chat lies.** It spikes for raids, emote spam, chat games and arguments about
  nothing. Expect to throw clips away; `--z` is how you trade volume for hit rate.
- **You still have to choose.** Monitoring is cheap, recording is not. Watching
  200 channels is free; recording 200 is 600 Mbps.
- **Captions may not run.** `faster-whisper` needs `ctranslate2`'s native
  extension, which Windows Application Control blocks on some machines
  (`DLL load failed while importing _ext`). That's a machine security policy,
  not a bug here — the rest of the pipeline doesn't depend on it.
