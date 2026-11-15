# GTA 6 Clipping

Live Twitch chat-spike clipper. Records a stream as it airs, watches chat for
spikes, and cuts a clip around each one — so clips are ready while the stream
is still live, instead of after the VOD goes up and everyone has the same
moments.

## Why chat

Chat is the only "something just happened" signal that needs no video
understanding, so the whole thing runs on a laptop with no GPU. It is also a
*free* signal — anyone can type "LMAOO" — so expect false positives until you
tune the threshold for the channel you are watching.

## Requirements

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) on PATH
- `pip install streamlink`
- Optional captions: `pip install faster-whisper`

## Usage

```bash
python clipper.py jynxzi
```

```bash
python clipper.py caseoh_ --quality best --multiplier 3.5 --captions
```

```bash
python clipper.py kaicenat --duration 3600 --pre 30 --post 8
```

Clips land in `clips/<channel>-<timestamp>/`, alongside the full recording
(`stream.ts`) and a `spikes.jsonl` log of every moment that fired.

## How it works

1. `streamlink` records the stream the moment it goes live
2. Twitch chat is read anonymously over IRC — no account, no OAuth token
3. messages are counted in 10-second buckets; a bucket that beats the rolling
   **median** by `--multiplier` is a spike
4. `ffmpeg` cuts a window around the spike and re-encodes it
5. `faster-whisper` writes an `.srt` beside the clip, if `--captions` is set

The baseline is a median rather than a mean so the spikes do not inflate it,
and `--floor` stops a dead chat going from 1 message to 4 and calling that a
moment.

## Tuning

| Flag | Default | Notes |
|------|---------|-------|
| `--multiplier` | 3.0 | Lower = more clips, more junk |
| `--floor` | 15 | Minimum messages in a bucket to count at all |
| `--cooldown` | 60 | Seconds before another clip can fire |
| `--pre` / `--post` | 25 / 5 | Window around the spike |
| `--duration` | 0 | Stop after N seconds (0 = until stream ends) |

Chat reacts *after* the thing happens, so the moment sits a few seconds before
the spike — that is why the window is weighted to `--pre`. On a very busy
channel raise `--multiplier`; on a quiet one lower `--floor`.

## Known limits

- **Live only.** You cannot rewind a stream that already ended.
- **Pick the right stream in advance.** Record the wrong channel and you have
  an hour of nothing. This is the real constraint, more than the one above.
- **Captions need a native extension.** `faster-whisper` pulls in `ctranslate2`,
  whose DLL can be blocked by Windows Application Control. Everything else
  works without it.
