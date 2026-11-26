"""Free speech check for Sequencing clips: silencedetect + local Whisper words.

Our editor places a clip only through spoken words (set_cut / show_footage
start on a word), so a clip with no words cannot go on the timeline.
silencedetect alone cannot tell speech from a music bed, hence Whisper.

Usage: python3 -I bench/agenticvbench/speech_check.py <tasks-dir> seq-5 seq-17 ...
Needs the openai-whisper package and its cached `base` model; runs offline.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import whisper  # local model, no network

MIN_WORDS = 2  # fewer than this = "no speech" for placement


def silent_seconds(p: Path) -> float:
    r = subprocess.run(["ffmpeg", "-nostats", "-i", str(p), "-af",
                        "silencedetect=noise=-35dB:d=0.3", "-f", "null", "-"],
                       capture_output=True, text=True)
    return sum(float(x) for x in re.findall(r"silence_duration: ([0-9.]+)", r.stderr))


def duration(p: Path) -> float:
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(p)]).decode().strip())


def main() -> None:
    root = Path(sys.argv[1])
    model = whisper.load_model("base")
    report = {}
    for tid in sys.argv[2:]:
        clips = sorted((root / tid / "materials").glob("*.mp4"), key=lambda p: int(p.stem))
        rows = []
        for c in clips:
            res = model.transcribe(str(c), language="en", fp16=False,
                                   condition_on_previous_text=False)
            # Whisper hallucinates on music; drop segments it marks as likely no speech.
            segs = [s for s in res["segments"] if s.get("no_speech_prob", 0) < 0.6]
            text = " ".join(s["text"].strip() for s in segs).strip()
            words = len(text.split())
            rows.append({"clip": c.stem, "dur": round(duration(c), 2),
                         "silent_s": round(silent_seconds(c), 2),
                         "words": words, "text": text[:90]})
            print(f"{tid} {c.name:>7} {rows[-1]['dur']:6.2f}s words={words:3d}  {text[:70]}",
                  flush=True)
        report[tid] = {"clips": rows,
                       "no_speech": [r["clip"] for r in rows if r["words"] < MIN_WORDS]}
    print(json.dumps({k: v["no_speech"] for k, v in report.items()}, indent=1))
    (root.parent / "speech-check.json").write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
