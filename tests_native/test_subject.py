import json
import os
import subprocess
import sys

import cv2
import numpy
import pytest

from voxtale_native import subject

needs_model = pytest.mark.skipif(not subject.SUBJECT_MODEL.exists(), reason="subject model absent (tools/fetch-subject-model.sh)")


def _clip(path: str, frames: int = 12, fps: float = 24) -> None:
    w = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), fps, (320, 180))
    for k in range(frames):
        img = numpy.full((180, 320, 3), 90, numpy.uint8)
        cv2.circle(img, (160 + k, 100), 55, (40, 120, 230), -1)
        w.write(img)
    w.release()


@needs_model
def test_mask_video_marks_the_subject(tmp_path):
    src, out = str(tmp_path / "in.avi"), str(tmp_path / "mask.avi")
    _clip(src)
    r = subject.subject_mask_video(src, out, 0.0, 0.25, 24)
    assert (r["frames"], r["width"], r["height"]) == (6, 320, 180)
    cap = cv2.VideoCapture(out)
    ok, m = cap.read()
    assert ok and int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) == 6
    gray = m[..., 0]
    assert gray[100, 160] > 128 > gray[10, 10]


def test_missing_model_is_a_no_model_error(tmp_path):
    env = {**os.environ, "VOXTALE_SUBJECT_MODEL": str(tmp_path / "none.onnx")}
    req = json.dumps({"video": "x.mp4", "out": str(tmp_path / "m.avi"), "start": 0, "end": 1, "fps": 24})
    p = subprocess.run([sys.executable, "-m", "voxtale_native", "subject"], input=req, capture_output=True, text=True, env=env)
    assert p.returncode == 1 and json.loads(p.stdout)["error"].startswith("NoModel: no-model:")
