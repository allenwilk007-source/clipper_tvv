#!/usr/bin/env python3
"""
Multi-channel live Twitch chat-spike clipper.

Watches chat on many channels at once over pooled anonymous IRC connections,
flags moments where a channel's chat jumps well above its OWN normal pace,
and cuts a clip out of a rolling DVR buffer with ffmpeg.

Three things make the multi-channel version work where one-per-process did not:

  * Chat is pooled. One socket carries ~18 channels, so watching 100 streamers
    costs 6 sockets instead of 100 threads.
  * Recording is a ring buffer. streamlink is piped into ffmpeg's segment
    muxer and old segments are deleted, so disk use is bounded by --dvr
    instead of growing until the drive fills.
  * Detection is scale-free. A robust z-score against each channel's own
    median/MAD, so one threshold works for a 200k-viewer channel and a
    2k-viewer one at the same time.

Chat is free to type, so it is a noisy signal -- but it is the only signal
that needs no video understanding, which is why this runs on a laptop.

Usage:
    python clipper.py jynxzi
    python clipper.py caseoh_ jynxzi xqc --quality 720p
    python clipper.py --channels-file top200.txt --watch-only
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from statistics import median

IRC_HOST = "irc.chat.twitch.tv"
IRC_PORT = 6667
PRIVMSG = re.compile(r"^:[^ ]+ PRIVMSG #([^ ]+) :")

# Twitch rate-limits JOINs (~20 per 10s per connection), so joins are paced.
JOINS_PER_WAVE = 15
JOIN_WAVE_PAUSE = 10.0
CHANNELS_PER_SOCKET = 18


# --------------------------------------------------------------------------- #
# chat
# --------------------------------------------------------------------------- #

class ChatHub:
    """Counts chat messages for many channels over pooled IRC connections.

    Twitch allows read-only chat access with a justinfan<random> nick -- no
    account, no OAuth token, no API quota. One connection can hold many
    channels, and PRIVMSG carries the channel name, so counts are attributed
    without one socket per streamer.
    """

    def __init__(self, channels: list[str], per_socket: int = CHANNELS_PER_SOCKET) -> None:
        self.channels = list(dict.fromkeys(c.lower().lstrip("#") for c in channels))
        self.per_socket = per_socket
        self._counts: Counter[str] = Counter()
        self._lock = threading.Lock()
        self.stop_flag = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        groups = [self.channels[i:i + self.per_socket]
                  for i in range(0, len(self.channels), self.per_socket)]
        for group in groups:
            t = threading.Thread(target=self._socket_loop, args=(group,), daemon=True)
            t.start()
            self._threads.append(t)

    @property
    def sockets(self) -> int:
        return len(self._threads)

    def take(self) -> dict[str, int]:
        """Return per-channel messages seen since the last call, and reset."""
        with self._lock:
            counts = dict(self._counts)
            self._counts.clear()
        return counts

    def _socket_loop(self, group: list[str]) -> None:
        while not self.stop_flag.is_set():
            try:
                self._session(group)
            except Exception as exc:  # noqa: BLE001 - reconnect on anything
                if not self.stop_flag.is_set():
                    print(f"[chat] reconnecting ({len(group)} channels) after: {exc}",
                          flush=True)
                    time.sleep(5)

    def _session(self, group: list[str]) -> None:
        sock = socket.create_connection((IRC_HOST, IRC_PORT), timeout=20)
        try:
            nick = f"justinfan{random.randint(10_000, 99_999)}"
            sock.sendall(f"NICK {nick}\r\n".encode())
            for i, channel in enumerate(group):
                if self.stop_flag.is_set():
                    return
                sock.sendall(f"JOIN #{channel}\r\n".encode())
                if (i + 1) % JOINS_PER_WAVE == 0 and i + 1 < len(group):
                    time.sleep(JOIN_WAVE_PAUSE)
            sock.settimeout(1.0)
            buf = ""
            while not self.stop_flag.is_set():
                try:
                    data = sock.recv(32768).decode("utf-8", "ignore")
                except socket.timeout:
                    continue
                if not data:
                    return
                buf += data
                while "\r\n" in buf:
                    line, buf = buf.split("\r\n", 1)
                    if line.startswith("PING"):
                        sock.sendall(b"PONG :tmi.twitch.tv\r\n")
                        continue
                    m = PRIVMSG.match(line)
                    if m:
                        with self._lock:
                            self._counts[m.group(1)] += 1
        finally:
            sock.close()


# --------------------------------------------------------------------------- #
# detection
# --------------------------------------------------------------------------- #

class SpikeDetector:
    """Flags a bucket that beats the channel's own recent chat pace.

    Scored as a robust z-score: (count - median) / MAD, where MAD is the
    median absolute deviation. Median and MAD both ignore the spikes
    themselves, so a channel that pops repeatedly does not slowly raise its
    own bar -- and because the score is in units of that channel's own
    volatility, one threshold covers channels of wildly different size.

    Two guards sit in front of it. The floor stops a dead chat going 1 -> 4
    and calling it a moment. min_rise stops a very steady chat firing on a
    small absolute bump that happens to be many MADs out.
    """

    SCALE = 0.6745  # makes z comparable to a standard-deviation z

    def __init__(self, history: int, z: float, floor: int,
                 min_rise: float, cooldown: float) -> None:
        self.buckets: deque[int] = deque(maxlen=history)
        self.z = z
        self.floor = floor
        self.min_rise = min_rise
        self.cooldown = cooldown
        self.last_fire = 0.0

    def push(self, count: int, now: float) -> tuple[bool, float, float]:
        """Add a bucket. Returns (is_spike, baseline, score)."""
        warm = len(self.buckets) >= 6
        base = median(self.buckets) if warm else 0.0
        mad = median([abs(b - base) for b in self.buckets]) if warm else 0.0
        self.buckets.append(count)

        if not warm or count < self.floor or base <= 0:
            return False, base, 0.0
        if count < base * self.min_rise:
            return False, base, 0.0

        if mad > 0:
            score = self.SCALE * (count - base) / mad
        else:
            # Zero MAD means a perfectly flat window; fall back to the ratio
            # so a flat-then-jumping chat is still detectable.
            score = self.z * (count / base) / self.min_rise
        if score < self.z:
            return False, base, score
        if now - self.last_fire < self.cooldown:
            return False, base, score

        self.last_fire = now
        return True, base, score


# --------------------------------------------------------------------------- #
# recording (DVR ring buffer)
# --------------------------------------------------------------------------- #

class Recorder:
    """Keeps a bounded rolling recording of one channel.

    streamlink writes the stream to stdout; ffmpeg remuxes it into fixed-length
    .ts segments with -c copy, so there is no decode cost. Segments older than
    dvr_seconds are deleted, which is the difference between ~70 MB per channel
    and an 8-hour launch-week stream filling the disk.
    """

    def __init__(self, channel: str, outdir: Path, quality: str,
                 seg_seconds: float, dvr_seconds: float) -> None:
        self.channel = channel
        self.outdir = outdir
        self.segdir = outdir / "dvr"
        self.segdir.mkdir(parents=True, exist_ok=True)
        self.list_path = self.segdir / "segments.csv"
        self.quality = quality
        self.seg_seconds = seg_seconds
        self.dvr_seconds = dvr_seconds
        self.t0: float | None = None
        self.sl: subprocess.Popen | None = None
        self.ff: subprocess.Popen | None = None
        self._holds: set[float] = set()
        self._hold_lock = threading.Lock()

    # -- lifecycle -------------------------------------------------------- #

    def start(self) -> None:
        sl_cmd = [
            "streamlink", "--twitch-disable-ads",
            "--retry-streams", "15", "--retry-max", "0",
            "--stdout", f"twitch.tv/{self.channel}", self.quality,
        ]
        ff_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", "pipe:0", "-c", "copy",
            "-f", "segment",
            "-segment_time", f"{self.seg_seconds:g}",
            "-reset_timestamps", "1",
            "-segment_list", str(self.list_path),
            "-segment_list_type", "csv",
            "-segment_list_flags", "+live",
            str(self.segdir / "s%05d.ts"),
        ]
        self.sl = subprocess.Popen(sl_cmd, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
        self.ff = subprocess.Popen(ff_cmd, stdin=self.sl.stdout,
                                   stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
        # The parent must drop its handle or ffmpeg never sees EOF.
        self.sl.stdout.close()

    def poll_live(self) -> bool:
        """True once bytes are actually being recorded.

        t0 is the moment the first byte hit disk, not when streamlink was
        launched -- with --retry-streams it may sit waiting for an offline
        channel to come up, and anchoring on launch would skew every offset.
        """
        if self.t0 is not None:
            return True
        first = self.segdir / "s00000.ts"
        if first.exists() and first.stat().st_size > 0:
            self.t0 = time.time()
            print(f"[rec]  {self.channel}: recording", flush=True)
            return True
        return False

    def alive(self) -> bool:
        return bool(self.ff and self.ff.poll() is None)

    def stop(self) -> None:
        for proc in (self.sl, self.ff):
            if proc and proc.poll() is None:
                proc.terminate()

    # -- segment bookkeeping ---------------------------------------------- #

    def segments(self) -> list[tuple[Path, float, float]]:
        """Completed segments as (path, start, end) in recording time."""
        if not self.list_path.exists():
            return []
        out: list[tuple[Path, float, float]] = []
        try:
            with self.list_path.open(newline="", encoding="utf-8") as fh:
                for row in csv.reader(fh):
                    if len(row) != 3:
                        continue
                    try:
                        out.append((self.segdir / row[0], float(row[1]), float(row[2])))
                    except ValueError:
                        continue
        except OSError:
            return []
        return out

    def hold(self, start: float) -> None:
        with self._hold_lock:
            self._holds.add(start)

    def release(self, start: float) -> None:
        with self._hold_lock:
            self._holds.discard(start)

    def prune(self) -> int:
        """Delete segments that have aged out of the DVR window.

        A segment a pending cut still needs is never deleted, however old --
        otherwise a slow encode queue would eat its own source footage.
        """
        segs = self.segments()
        if not segs:
            return 0
        newest = max(end for _, _, end in segs)
        cutoff = newest - self.dvr_seconds
        with self._hold_lock:
            if self._holds:
                cutoff = min(cutoff, min(self._holds) - self.seg_seconds)
        removed = 0
        for path, _, end in segs:
            if end < cutoff and path.exists():
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    pass
        return removed

    def disk_bytes(self) -> int:
        total = 0
        for path in self.segdir.glob("*.ts"):
            try:
                total += path.stat().st_size
            except OSError:
                pass
        return total


# --------------------------------------------------------------------------- #
# cutting
# --------------------------------------------------------------------------- #

def cut_from_segments(rec: Recorder, start: float, duration: float,
                      dest: Path, scratch: Path) -> bool:
    """Cut [start, start+duration) of recording time out of the ring buffer.

    Concatenates the segments the window touches and re-encodes. Re-encoding
    rather than stream-copying is deliberate: a copy cut starts on the next
    keyframe, which lands you a clip that opens on a frozen frame.
    """
    end = start + duration
    wanted = [(p, s, e) for p, s, e in rec.segments() if e > start and s < end]
    wanted = [(p, s, e) for p, s, e in wanted if p.exists()]
    if not wanted:
        return False
    wanted.sort(key=lambda row: row[1])
    base = wanted[0][1]

    scratch.parent.mkdir(parents=True, exist_ok=True)
    with scratch.open("w", encoding="utf-8") as fh:
        for path, _, _ in wanted:
            safe = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
            fh.write(f"file '{safe}'\n")

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", str(scratch),
        "-ss", f"{max(0.0, start - base):.2f}", "-t", f"{duration:.2f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", str(dest),
    ]
    ok = subprocess.run(cmd).returncode == 0
    scratch.unlink(missing_ok=True)
    return ok and dest.exists() and dest.stat().st_size > 0


_model = None
_model_lock = threading.Lock()


def write_captions(clip: Path, model_size: str):
    global _model
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001 - ImportError or blocked DLL
        print(f"[captions] unavailable ({type(exc).__name__}); skipping", flush=True)
        return None
    with _model_lock:
        if _model is None:
            print(f"[captions] loading whisper '{model_size}' "
                  "(first run downloads it)", flush=True)
            _model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, _ = _model.transcribe(str(clip))
        srt = clip.with_suffix(".srt")
        with srt.open("w", encoding="utf-8") as fh:
            for i, seg in enumerate(segments, 1):
                fh.write(f"{i}\n{_ts(seg.start)} --> {_ts(seg.end)}\n"
                         f"{seg.text.strip()}\n\n")
    return srt


def _ts(seconds: float) -> str:
    ms = int(seconds * 1000)
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def load_channels(args) -> list[str]:
    names = list(args.channels)
    if args.channels_file:
        text = Path(args.channels_file).read_text(encoding="utf-8")
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                names.append(line)
    cleaned = [n.lower().lstrip("#").strip() for n in names]
    return list(dict.fromkeys(n for n in cleaned if n))


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Clip live Twitch streams from chat spikes, many channels at once.")
    ap.add_argument("channels", nargs="*", help="channel names")
    ap.add_argument("--channels-file", help="file with one channel per line")
    ap.add_argument("--watch-only", action="store_true",
                    help="monitor chat and log spikes without recording "
                         "(free: use it to find which channels actually pop)")
    ap.add_argument("--quality", default="best")
    ap.add_argument("--bucket", type=float, default=10.0, help="seconds per count bucket")
    ap.add_argument("--history", type=int, default=30, help="buckets of baseline history")
    ap.add_argument("--z", type=float, default=3.5, help="robust z-score to fire at")
    ap.add_argument("--floor", type=int, default=20, help="min messages in a bucket")
    ap.add_argument("--min-rise", type=float, default=1.5,
                    help="min multiple of the channel's median")
    ap.add_argument("--cooldown", type=float, default=60.0,
                    help="seconds between clips, per channel")
    ap.add_argument("--pre", type=float, default=25.0, help="seconds kept before the spike")
    ap.add_argument("--post", type=float, default=5.0, help="seconds kept after the spike")
    ap.add_argument("--dvr", type=float, default=180.0,
                    help="seconds of rolling recording kept per channel")
    ap.add_argument("--segment", type=float, default=10.0, help="DVR segment length")
    ap.add_argument("--encoders", type=int, default=0,
                    help="concurrent ffmpeg cuts (0 = auto)")
    ap.add_argument("--duration", type=float, default=0.0,
                    help="stop after N seconds (0 = run until stopped)")
    ap.add_argument("--captions", action="store_true", help="write .srt next to each clip")
    ap.add_argument("--model", default="base", help="whisper model size")
    ap.add_argument("--outdir", default="clips")
    return ap


def main() -> int:
    args = build_parser().parse_args()
    channels = load_channels(args)
    if not channels:
        build_parser().print_usage()
        print("\nerror: name at least one channel, or pass --channels-file",
              file=sys.stderr)
        return 2
    if args.pre + args.post > args.dvr:
        print(f"error: --dvr {args.dvr:g}s is shorter than the "
              f"{args.pre + args.post:g}s clip window", file=sys.stderr)
        return 2

    for tool in (["streamlink"] if not args.watch_only else []) + ["ffmpeg"]:
        if shutil.which(tool) is None:
            print(f"error: {tool} not found on PATH", file=sys.stderr)
            return 2

    # The pid matters: splitting a channel list across two processes to spread
    # bandwidth is a normal thing to do, and a second-resolution name alone
    # lets two of them share a segment directory and overwrite each other.
    session = datetime.now().strftime("%Y%m%d-%H%M%S")
    root = Path(args.outdir) / f"session-{session}-{os.getpid()}"
    root.mkdir(parents=True, exist_ok=True)
    log_path = root / "spikes.jsonl"
    log_lock = threading.Lock()
    scratch_dir = root / ".concat"

    workers = args.encoders or max(1, min(4, (os.cpu_count() or 4) // 3))
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="cut")

    print(f"[chat] watching {len(channels)} channel(s) anonymously; "
          f"fire at z>={args.z:g}, floor {args.floor}/bucket, "
          f"min rise {args.min_rise:g}x", flush=True)
    hub = ChatHub(channels)
    hub.start()
    print(f"[chat] {hub.sockets} pooled IRC connection(s)", flush=True)

    recorders: dict[str, Recorder] = {}
    if not args.watch_only:
        print(f"[rec]  starting {len(channels)} recorder(s) at {args.quality}; "
              f"DVR {args.dvr:g}s/channel, {workers} encoder slot(s)", flush=True)
        for channel in channels:
            rec = Recorder(channel, root / channel, args.quality,
                           args.segment, args.dvr)
            rec.start()
            recorders[channel] = rec
    else:
        print("[rec]  watch-only: nothing is being recorded", flush=True)

    detectors = {c: SpikeDetector(args.history, args.z, args.floor,
                                  args.min_rise, args.cooldown)
                 for c in channels}
    clip_counts: Counter[str] = Counter()
    total_clips = 0
    pending: list = []

    def harvest(rec: Recorder, spike_at: float, index: int,
                count: int, base: float, score: float) -> None:
        """Wait for the tail of the window to reach disk, then cut it out."""
        assert rec.t0 is not None
        start = max(0.0, (spike_at - rec.t0) - args.pre)
        rec.hold(start)
        try:
            # The segment holding the end of the window must be closed and
            # listed before it can be concatenated.
            need = start + args.pre + args.post
            giveup = time.time() + args.segment * 3 + 20.0
            while time.time() < giveup:
                segs = rec.segments()
                if segs and max(e for _, _, e in segs) >= need:
                    break
                time.sleep(1.0)
            dest = rec.outdir / f"{rec.channel}-{index:03d}.mp4"
            scratch = scratch_dir / f"{rec.channel}-{index:03d}.txt"
            if cut_from_segments(rec, start, args.pre + args.post, dest, scratch):
                print(f"[clip] {dest.name}  chat {count} vs median {base:.0f} "
                      f"(z={score:.1f})", flush=True)
                if args.captions:
                    write_captions(dest, args.model)
            else:
                print(f"[clip] cut failed for {rec.channel} #{index}", flush=True)
        finally:
            rec.release(start)

    try:
        next_tick = time.time() + args.bucket
        started = time.time()
        deadline = started + args.duration if args.duration else None
        waiting = set(recorders)
        while True:
            if deadline and time.time() >= deadline:
                print("[main] duration reached", flush=True)
                break
            time.sleep(max(0.0, next_tick - time.time()))
            now = next_tick
            next_tick += args.bucket

            for channel in sorted(waiting):
                rec = recorders[channel]
                if rec.poll_live():
                    waiting.discard(channel)
                elif not rec.alive():
                    print(f"[rec]  {channel}: recorder exited before any bytes "
                          "(offline, or no stream found)", flush=True)
                    waiting.discard(channel)

            counts = hub.take()
            for channel, detector in detectors.items():
                count = counts.get(channel, 0)
                is_spike, base, score = detector.push(count, now)
                if not is_spike:
                    continue
                rec = recorders.get(channel)
                clip_counts[channel] += 1
                index = clip_counts[channel]
                total_clips += 1
                with log_lock, log_path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps({
                        "channel": channel, "clip": index, "at": now,
                        "messages": count, "median": base, "z": round(score, 2),
                        "recorded": bool(rec and rec.t0),
                    }) + "\n")
                if rec and rec.t0 is not None:
                    pending.append(pool.submit(harvest, rec, now, index,
                                               count, base, score))
                else:
                    print(f"[spike] {channel}  chat {count} vs median {base:.0f} "
                          f"(z={score:.1f}) -- not recording", flush=True)

            for rec in recorders.values():
                if rec.t0 is not None:
                    rec.prune()

            if recorders and not any(r.alive() for r in recorders.values()):
                print("[main] every recorder has stopped", flush=True)
                break
    except KeyboardInterrupt:
        print("\n[main] stopping", flush=True)
    finally:
        hub.stop_flag.set()
        for rec in recorders.values():
            rec.stop()
        if pending:
            print(f"[main] finishing {len(pending)} cut(s)...", flush=True)
        pool.shutdown(wait=True)
        for rec in recorders.values():
            shutil.rmtree(rec.segdir, ignore_errors=True)
        shutil.rmtree(scratch_dir, ignore_errors=True)

    print(f"[main] {total_clips} spike(s) across "
          f"{len(clip_counts)} channel(s) -> {root}", flush=True)
    for channel, n in clip_counts.most_common():
        print(f"       {channel:<20}{n:>4}", flush=True)

    # A channel that never went live retries silently forever, so say so
    # rather than leaving it looking like a channel that simply never popped.
    never = sorted(c for c, r in recorders.items() if r.t0 is None)
    if never:
        print(f"[main] never came online: {', '.join(never)}", flush=True)
    quiet = sorted(c for c in detectors if c not in clip_counts and c not in never)
    if quiet:
        print(f"[main] no spikes: {', '.join(quiet)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
