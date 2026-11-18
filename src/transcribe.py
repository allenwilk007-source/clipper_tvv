"""Speech to timed words, for burned-in subtitles and for titles.

    python src/transcribe.py <media file> [model]

Prints one line of JSON: {"words": [{"start", "end", "word"}], "segments": [...]}
or {"error": "..."}. Called by shortform.js; nothing else uses it.

The model is never downloaded from here (local_files_only). It was fetched
once, deliberately; a render that silently pulled hundreds of megabytes the
first time it ran would be a surprise nobody agreed to. If it is missing, this
says so and the short is still made, just without subtitles.
"""

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe.py <media> [model]"}))
        return 0
    path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper is not installed (python -m pip install faster-whisper)"}))
        return 0

    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8", local_files_only=True)
    except Exception as err:  # noqa: BLE001 - any load failure means "no subtitles"
        print(json.dumps({"error": f"speech model {model_name} is not available locally: {err}"}))
        return 0

    try:
        # Decoded with ffmpeg rather than faster-whisper's own loader: that
        # loader goes through PyAV, and the installed PyAV no longer accepts an
        # argument faster-whisper 1.2.1 passes it ("unexpected keyword argument
        # 'metadata_errors'"). ffmpeg is already required, and 16 kHz mono
        # float is exactly what the model wants.
        import subprocess

        import numpy as np

        raw = subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
            capture_output=True,
            check=True,
        ).stdout
        audio = np.frombuffer(raw, np.float32)
        if not audio.size:
            print(json.dumps({"words": [], "segments": []}))
            return 0

        segments, _info = model.transcribe(
            audio,
            # Word timings are what let the subtitle highlight follow speech.
            word_timestamps=True,
            # Skips the stretches of pure game audio, which otherwise come back
            # as invented words.
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        words = []
        out_segments = []
        for segment in segments:
            out_segments.append(
                {"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()}
            )
            for word in segment.words or []:
                words.append(
                    {
                        "start": round(word.start, 3),
                        "end": round(word.end, 3),
                        "word": word.word,
                        # The model's own confidence. Speech in a language the
                        # English-only model does not know comes back as
                        # plausible English words with low confidence, which is
                        # how shortform.js tells a transcript from a guess.
                        "probability": round(float(word.probability), 3),
                    }
                )
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"error": f"transcription failed: {err}"}))
        return 0

    print(json.dumps({"words": words, "segments": out_segments}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
