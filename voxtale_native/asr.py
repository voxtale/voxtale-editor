"""Local speech-to-text: Parakeet TDT 0.6B v3 on this machine, free, no key.

Apple Silicon: parakeet-mlx (the GPU through MLX). Elsewhere (Windows, Linux,
Intel Mac, or VOXTALE_EDITOR_ASR=cpu): the same model as int8 ONNX through
sherpa-onnx on the CPU. Weights come from tools/fetch-parakeet.sh into
models/parakeet/ and are never fetched here: no model, a ``no-model:`` error.

``python -m voxtale_native asr`` reads {wav, models?} (a 16 kHz mono 16-bit
WAV) and writes {engine, model, words: [{text, start, end, confidence}]},
seconds from the WAV's start.
"""

from __future__ import annotations

import os
import platform
import re
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 16000
# CHUNK: cut every ~15 s at the quietest
# spot within ±5 s. One hour at once does not fit in memory; 2-min pieces let a
# quiet voice drift into the wrong language with minutes of missing words.
CHUNK = 15

SHERPA_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
MLX_NAME = "parakeet-tdt-0.6b-v3-mlx"
REPO_MODELS = Path(__file__).resolve().parent.parent / "models" / "parakeet"
# MLX_RESERVE: MLX keeps freed memory for
# reuse; capped at 256 MB peak use fell from 5.9 to 3.4 GB, same speed and words.
MLX_RESERVE = 256 * 2**20


def use_mlx() -> bool:
    """Apple Silicon unless VOXTALE_EDITOR_ASR=cpu."""
    return sys.platform == "darwin" and platform.machine() == "arm64" and os.environ.get("VOXTALE_EDITOR_ASR") != "cpu"


def model_dir(models: Path | None = None) -> tuple[str, Path]:
    """(backend, folder) for this machine: 'mlx' or 'onnx'."""
    root = models or REPO_MODELS
    return ("mlx", root / MLX_NAME) if use_mlx() else ("onnx", root / SHERPA_NAME)


MLX_FILES = ("config.json", "model.safetensors")
ONNX_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")


def model_ready(models: Path | None = None) -> dict:
    """{backend, dir, ready, missing}: what the fetch script still has to bring."""
    backend, d = model_dir(models)
    need = MLX_FILES if backend == "mlx" else ONNX_FILES
    missing = [f for f in need if not (d / f).is_file()]
    return {"backend": backend, "dir": str(d), "ready": not missing, "missing": missing}


def merge_tokens(tokens: list[dict]) -> list[dict]:
    """Parakeet gives word pieces (' H', 'ello', ','); a leading space starts a new word.
    A word's confidence is its lowest piece's."""
    words: list[dict] = []
    for t in tokens:
        c = float(t.get("confidence", 1.0))
        if t["text"].startswith(" ") or not words:
            words.append({"text": t["text"].strip(), "start": t["start"], "end": t["end"], "confidence": c})
        else:
            words[-1]["text"] += t["text"]
            words[-1]["end"] = t["end"]
            words[-1]["confidence"] = min(words[-1]["confidence"], c)
    return [w for w in words if w["text"]]


GLUED = re.compile(r"^([a-z]{2,})(\d[\d.,:%]*\W*)$")


def split_glued(words: list[dict]) -> list[dict]:
    """'of2026' -> 'of', '2026': the model sometimes glues a number to the word before (never
    in capitals: MP4, M4 stay). The time splits by the length of the two parts."""
    out: list[dict] = []
    for w in words:
        m = GLUED.match(w["text"])
        if not m:
            out.append(w)
            continue
        a, b = m.groups()
        cut = round(w["start"] + (w["end"] - w["start"]) * len(a) / len(w["text"]), 3)
        out += [{**w, "text": a, "end": cut}, {**w, "text": b, "start": cut}]
    return out


def read_wav(path: Path) -> np.ndarray:
    """A 16 kHz mono 16-bit WAV as samples in [-1, 1]."""
    with wave.open(str(path)) as w:
        if w.getframerate() != RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"expected a 16 kHz mono 16-bit WAV: {path}")  # else word times would be wrong
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def cuts(audio: np.ndarray) -> list[int]:
    """Where to cut long speech: about every CHUNK s, at the quietest 0.1 s within ±5 s."""
    win = RATE // 10
    if len(audio) < win:
        return []
    energy = np.sqrt(np.convolve(audio.astype(np.float64) ** 2, np.ones(win) / win, mode="valid"))
    out = []
    for t in range(CHUNK * RATE, len(audio) - 10 * RATE, CHUNK * RATE):
        a, b = t - 5 * RATE, min(t + 5 * RATE, len(energy))
        out.append(a + int(np.argmin(energy[a:b])) + win // 2)
    return out


def missed(audio: np.ndarray, toks: list[dict]) -> list[tuple[int, int]]:
    """Gaps of 1 s or more between words where a voice sounds (0.5 s at 15 dB over the floor):
    Parakeet sometimes drops a whole quiet passage it hears fine on its own."""
    win = RATE // 10
    n = len(audio) // win
    if not n:
        return []
    db = 20 * np.log10(np.sqrt(np.mean(audio[:n * win].astype(np.float64).reshape(n, win) ** 2, axis=1)) + 1e-9)
    voiced = db > np.percentile(db, 10) + 15
    edges = [0.0, *[x for t in sorted(toks, key=lambda t: t["start"]) for x in (t["start"], t["end"])], len(audio) / RATE]
    out = []
    for a, b in zip(edges[::2], edges[1::2]):
        if b - a >= 1 and voiced[int(a * 10):int(b * 10)].sum() >= 5:
            out.append((int(a * RATE), int(b * RATE)))
    return out


def segmented(audio: np.ndarray, decode) -> list[dict]:
    """Word pieces timed on the whole recording. `decode(samples)` gives pieces timed on its
    own samples. Cut at quiet spots, then each voiced gap goes again on its own."""
    def run(a: int, b: int) -> list[dict]:
        return [{**t, "start": round(a / RATE + t["start"], 3), "end": round(a / RATE + t["end"], 3)} for t in decode(audio[a:b])]

    bounds = [0, *cuts(audio), len(audio)]
    out = [t for a, b in zip(bounds, bounds[1:]) for t in run(a, b)]
    out += [t for a, b in missed(audio, out) for t in run(a, b)]
    return sorted(out, key=lambda t: t["start"])


def _mlx_decoder(d: Path):
    """parakeet-mlx loaded from the local folder only (from_pretrained would try Hugging Face first)."""
    import json

    import mlx.core as mx
    from mlx.utils import tree_flatten, tree_unflatten
    from parakeet_mlx.audio import get_logmel
    from parakeet_mlx.utils import from_config

    mx.set_cache_limit(MLX_RESERVE)
    model = from_config(json.loads((d / "config.json").read_text()))
    model.load_weights(str(d / "model.safetensors"))
    model.update(tree_unflatten([(k, v.astype(mx.bfloat16)) for k, v in tree_flatten(model.parameters())]))
    cfg = model.preprocessor_config

    def decode(x: np.ndarray) -> list[dict]:
        if len(x) < cfg.hop_length:
            return []
        r = model.generate(get_logmel(mx.array(x), cfg))[0]
        return [{"text": t.text, "start": t.start, "end": t.start + t.duration, "confidence": float(t.confidence)} for t in r.tokens]

    return decode


def _onnx_decoder(d: Path):
    import sherpa_onnx

    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(d / "encoder.int8.onnx"), decoder=str(d / "decoder.int8.onnx"), joiner=str(d / "joiner.int8.onnx"),
        tokens=str(d / "tokens.txt"), model_type="nemo_transducer", num_threads=max(1, (os.cpu_count() or 2) // 2))

    def decode(x: np.ndarray) -> list[dict]:
        if not len(x):
            return []
        s = rec.create_stream()
        s.accept_waveform(RATE, x)
        rec.decode_stream(s)
        r = s.result
        ends = list(r.timestamps[1:]) + [len(x) / RATE]
        durations = getattr(r, "durations", None) or [e - t for t, e in zip(r.timestamps, ends)]
        return [{"text": t, "start": ts, "end": ts + du} for t, ts, du in zip(r.tokens, r.timestamps, durations)]

    return decode


def transcribe_wav(wav: str, models: str | None = None) -> dict:
    state = model_ready(Path(models) if models else None)
    if not state["ready"]:
        raise FileNotFoundError(f"no-model: {state['dir']} lacks {', '.join(state['missing'])} (run tools/fetch-parakeet.sh)")
    d = Path(state["dir"])
    decode = _mlx_decoder(d) if state["backend"] == "mlx" else _onnx_decoder(d)
    words = split_glued(merge_tokens(segmented(read_wav(Path(wav)), decode)))
    # Ends never before starts (a zero-length last piece), rounded to the ms.
    words = [{**w, "start": round(w["start"], 3), "end": round(max(w["end"], w["start"] + 0.01), 3),
              "confidence": round(min(1.0, max(0.0, w["confidence"])), 4)} for w in words]
    engine = "parakeet-mlx" if state["backend"] == "mlx" else "parakeet-onnx"
    return {"engine": engine, "model": "parakeet-tdt-0.6b-v3", "words": words}


def handle(req: dict) -> dict:
    if req.get("check"):
        return model_ready(Path(req["models"]) if req.get("models") else None)
    return transcribe_wav(req["wav"], req.get("models"))
