"""Local ASR helpers with a stub decoder: no model, no MLX or sherpa-onnx needed."""

import numpy as np
import pytest

from voxtale_native import asr


def test_merge_tokens_joins_pieces_and_keeps_lowest_confidence():
    toks = [{"text": " He", "start": 0.0, "end": 0.1, "confidence": 0.9}, {"text": "llo", "start": 0.1, "end": 0.3, "confidence": 0.6},
            {"text": ",", "start": 0.3, "end": 0.32}, {"text": " world", "start": 0.5, "end": 0.9, "confidence": 0.95}]
    assert asr.merge_tokens(toks) == [{"text": "Hello,", "start": 0.0, "end": 0.32, "confidence": 0.6},
                                      {"text": "world", "start": 0.5, "end": 0.9, "confidence": 0.95}]


def test_split_glued_number():
    out = asr.split_glued([{"text": "of2026", "start": 0.0, "end": 0.6, "confidence": 1.0}, {"text": "MP4", "start": 1, "end": 1.2, "confidence": 1.0}])
    assert [w["text"] for w in out] == ["of", "2026", "MP4"]
    assert out[0]["end"] == out[1]["start"] == pytest.approx(0.2)


def test_segmented_cuts_long_audio_and_times_on_whole_recording():
    rate = asr.RATE
    audio = np.zeros(40 * rate, dtype=np.float32)
    seen = []

    def decode(x):
        seen.append(len(x) / rate)
        return [{"text": " w", "start": 0.0, "end": 0.2}]

    toks = asr.segmented(audio, decode)
    assert len(seen) >= 2 and sum(seen) == pytest.approx(40, abs=0.01)  # cut into pieces covering the whole input
    assert toks[0]["start"] == 0.0 and toks[1]["start"] > 5  # second piece timed on the recording


def test_model_ready_names_missing_files(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXTALE_EDITOR_ASR", "cpu")
    state = asr.model_ready(tmp_path)
    assert state["backend"] == "onnx" and not state["ready"] and "tokens.txt" in state["missing"]
    with pytest.raises(FileNotFoundError, match="fetch-parakeet.sh"):
        asr.transcribe_wav("x.wav", str(tmp_path))
