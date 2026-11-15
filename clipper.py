#!/usr/bin/env python3
"""
Live Twitch chat-spike clipper.

Records a live stream with streamlink, reads chat anonymously over IRC,
counts messages in fixed-width buckets, and cuts a clip around every spike
with ffmpeg. Optional captions via faster-whisper.

Chat is free to type, so it is a noisy signal -- but it is the only signal
that needs no video understanding, which is why this runs on a laptop.

Usage:
    python clipper.py <channel>
    python clipper.py caseoh_ --multiplier 3.5 --captions
"""

from __future__ import annotations

import argparse
import json
import random
import re
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from statistics import median

IRC_HOST = "irc.chat.twitch.tv"
IRC_PORT = 6667
PRIVMSG = re.compile(r"^:[^ ]+ PRIVMSG #")


class ChatCounter(threading.Thread):
    """Counts chat messages for one channel over an anonymous IRC connection.

    Twitch allows read-only chat access with a justinfan<random> nick --
    no account, no OAuth token, no API quota.
    """

    def __init__(self, channel: str) -> None:
        super().__init__(daemon=True)
        self.channel = channel.lower().lstrip("#")
        self._count = 0
        self._lock = threading.Lock()
        self.stop_flag = threading.Event()
        self.joined = threading.Event()

    def take(self) -> int:
        """Return messages seen since the last call and reset the counter."""
        with self._lock:
            n, self._count = self._count, 0
        return n

    def run(self) -> None:
        while not self.stop_flag.is_set():
            try:
                self._session()
            except Exception as exc:  # noqa: BLE001 - reconnect on anything
                if not self.stop_flag.is_set():
                    print(f"[chat] reconnecting after: {exc}", flush=True)
                    time.sleep(5)

    def _session(self) -> None:
        sock = socket.create_connection((IRC_HOST, IRC_PORT), timeout=20)
        try:
            nick = f"justinfan{random.randint(10_000, 99_999)}"
            sock.sendall(f"NICK {nick}\r\n".encode())
            sock.sendall(f"JOIN #{self.channel}\r\n".encode())
            sock.settimeout(1.0)
            buf = ""
            while not self.stop_flag.is_set():
                try:
                    data = sock.recv(8192).decode("utf-8", "ignore")
                except socket.timeout:
                    continue
                if not data:
                    return
                buf += data
                while "\r\n" in buf:
                    line, buf = buf.split("\r\n", 1)
                    if line.startswith("PING"):
                        sock.sendall(b"PONG :tmi.twitch.tv\r\n")
                    elif PRIVMSG.match(line):
                        self.joined.set()
                        with self._lock:
                            self._count += 1
        finally:
            sock.close()


class SpikeDetector:
    """Flags a bucket whose message count beats its own rolling baseline.

    The baseline is a median, not a mean, so the spikes themselves do not
    inflate it. The floor stops a dead chat going from 1 message to 4 and
    calling it a moment.
    """

    def __init__(self, history: int, multiplier: float, floor: int, cooldown: float) -> None:
        self.buckets: deque[int] = deque(maxlen=history)
        self.multiplier = multiplier
        self.floor = floor
        self.cooldown = cooldown
        self.last_fire = 0.0

    def push(self, count: int, now: float) -> tuple[bool, float]:
        """Add a bucket. Returns (is_spike, baseline)."""
        baseline = median(self.buckets) if len(self.buckets) >= 6 else 0.0
        self.buckets.append(count)
        if baseline <= 0 or count < self.floor:
            return False, baseline
        if count < baseline * self.multiplier:
            return False, baseline
        if now - self.last_fire < self.cooldown:
            return False, baseline
        self.last_fire = now
        return True, baseline


def start_recorder(channel: str, out_path: Path, quality: str) -> subprocess.Popen:
    cmd = [
        "streamlink",
        "--twitch-disable-ads",
        "--retry-streams", "10",
        "--retry-max", "30",
        "--force",
        f"twitch.tv/{channel}",
        quality,
        "-o", str(out_path),
    ]
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cut_clip(source: Path, start: float, duration: float, dest: Path) -> bool:
    """Re-encode rather than stream-copy: a copy cut starts on the next
    keyframe, which lands you a clip that opens on a frozen frame."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.2f}",
        "-i", str(source),
        "-t", f"{duration:.2f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        str(dest),
    ]
    return subprocess.run(cmd).returncode == 0


_model = None
_model_lock = threading.Lock()


def write_captions(clip: Path, model_size: str):
    global _model
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("[captions] faster-whisper not installed; skipping", flush=True)
        return None
    with _model_lock:
        if _model is None:
            print(f"[captions] loading whisper '{model_size}' (first run downloads it)", flush=True)
            _model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = _model.transcribe(str(clip))
    srt = clip.with_suffix(".srt")
    with srt.open("w", encoding="utf-8") as fh:
        for i, seg in enumerate(segments, 1):
            fh.write(f"{i}\n{_ts(seg.start)} --> {_ts(seg.end)}\n{seg.text.strip()}\n\n")
    return srt


def _ts(seconds: float) -> str:
    ms = int(seconds * 1000)
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Clip a live Twitch stream from chat spikes.")
    ap.add_argument("channel")
    ap.add_argument("--quality", default="best")
    ap.add_argument("--bucket", type=float, default=10.0, help="seconds per count bucket")
    ap.add_argument("--history", type=int, default=30, help="buckets of baseline history")
    ap.add_argument("--multiplier", type=float, default=3.0, help="spike threshold vs baseline")
    ap.add_argument("--floor", type=int, default=15, help="min messages in a bucket to count")
    ap.add_argument("--cooldown", type=float, default=60.0, help="seconds between clips")
    ap.add_argument("--pre", type=float, default=25.0, help="seconds kept before the spike")
    ap.add_argument("--post", type=float, default=5.0, help="seconds kept after the spike")
    ap.add_argument("--duration", type=float, default=0.0,
                    help="stop after N seconds of recording (0 = until the stream ends)")
    ap.add_argument("--captions", action="store_true", help="write .srt next to each clip")
    ap.add_argument("--model", default="base", help="whisper model size")
    ap.add_argument("--outdir", default="clips")
    args = ap.parse_args()

    channel = args.channel.lower().lstrip("#")
    session = datetime.now().strftime("%Y%m%d-%H%M%S")
    outdir = Path(args.outdir) / f"{channel}-{session}"
    outdir.mkdir(parents=True, exist_ok=True)
    recording = outdir / "stream.ts"
    log = outdir / "spikes.jsonl"

    print(f"[rec]  starting streamlink on twitch.tv/{channel} ({args.quality})", flush=True)
    rec = start_recorder(channel, recording, args.quality)

    # Offsets into the recording are measured from the first byte written,
    # not from when we launched streamlink -- it may sit waiting for the stream.
    t0 = None
    while t0 is None:
        if rec.poll() is not None:
            print("[rec]  streamlink exited before recording started "
                  "(channel offline, or no stream found).", flush=True)
            return 1
        if recording.exists() and recording.stat().st_size > 0:
            t0 = time.time()
        else:
            time.sleep(0.5)
    print(f"[rec]  recording -> {recording}", flush=True)

    chat = ChatCounter(channel)
    chat.start()
    detector = SpikeDetector(args.history, args.multiplier, args.floor, args.cooldown)
    workers: list[threading.Thread] = []
    clip_n = 0

    def harvest(spike_at: float, index: int, count: int, baseline: float) -> None:
        """Wait for the tail of the window to hit disk, then cut it out."""
        ready = spike_at + args.post + 8.0
        while time.time() < ready:
            time.sleep(1.0)
        start = max(0.0, (spike_at - t0) - args.pre)
        dest = outdir / f"clip{index:03d}.mp4"
        if cut_clip(recording, start, args.pre + args.post, dest):
            print(f"[clip] {dest.name}  chat {count} vs baseline {baseline:.0f}", flush=True)
            if args.captions:
                write_captions(dest, args.model)
        else:
            print(f"[clip] ffmpeg failed for {dest.name}", flush=True)

    print(f"[chat] watching #{channel} anonymously; spike = {args.multiplier}x median, "
          f"floor {args.floor}/bucket", flush=True)
    try:
        next_tick = time.time() + args.bucket
        deadline = (t0 + args.duration) if args.duration else None
        while rec.poll() is None:
            if deadline and time.time() >= deadline:
                print("[main] duration reached", flush=True)
                break
            time.sleep(max(0.0, next_tick - time.time()))
            now = next_tick
            next_tick += args.bucket
            count = chat.take()
            is_spike, baseline = detector.push(count, now)
            if is_spike:
                clip_n += 1
                with log.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps({
                        "clip": clip_n, "at": now, "offset": (now - t0) - args.pre,
                        "messages": count, "baseline": baseline,
                    }) + "\n")
                w = threading.Thread(target=harvest, args=(now, clip_n, count, baseline), daemon=False)
                w.start()
                workers.append(w)
    except KeyboardInterrupt:
        print("\n[main] stopping", flush=True)
    finally:
        chat.stop_flag.set()
        if rec.poll() is None:
            rec.terminate()
        if workers:
            print(f"[main] finishing {len(workers)} clip(s)...", flush=True)
        for w in workers:
            w.join()

    print(f"[main] {clip_n} clip(s) in {outdir}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
