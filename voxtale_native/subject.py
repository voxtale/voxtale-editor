"""Subject mask for a span of a talking-head clip, so text can sit behind the speaker.

U2-Net-p (rembg's u2netp.onnx, Apache-2.0, 4.6 MB) run through cv2.dnn: no
GPU, no Mac-only API, so it runs wherever the face finder does. The model is
not committed: ``tools/fetch-subject-model.sh`` puts it in models/, or set
VOXTALE_SUBJECT_MODEL. Without it the op fails with a ``no-model:`` error and
the renderer draws the graphic over the speaker instead.

The mask is a greyscale MJPG AVI at the source's size, one frame per output
frame from ``start``: white = subject.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import cv2
import numpy

SUBJECT_MODEL = Path(os.environ.get("VOXTALE_SUBJECT_MODEL") or Path(__file__).resolve().parents[1] / "models/u2netp.onnx")
SIZE = 320
MEAN = numpy.array([0.485, 0.456, 0.406], numpy.float32)
STD = numpy.array([0.229, 0.224, 0.225], numpy.float32)
_local = threading.local()


class NoModel(FileNotFoundError):
    pass


def _net() -> "cv2.dnn.Net":
    if not hasattr(_local, "net"):
        if not SUBJECT_MODEL.exists():
            raise NoModel(f"no-model: subject model missing at {SUBJECT_MODEL} (tools/fetch-subject-model.sh)")
        _local.net = cv2.dnn.readNetFromONNX(str(SUBJECT_MODEL))
    return _local.net


def subject_map(bgr: numpy.ndarray) -> numpy.ndarray:
    """Subject probability (0-255 uint8) at the image's size."""
    height, width = bgr.shape[:2]
    small = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), (SIZE, SIZE), interpolation=cv2.INTER_AREA).astype(numpy.float32)
    small = (small / max(1.0, float(small.max())) - MEAN) / STD
    net = _net()
    net.setInput(small.transpose(2, 0, 1)[None])
    d0 = net.forward("1959")[0, 0]  # the fused side output; the others are coarser
    lo, hi = float(d0.min()), float(d0.max())
    d0 = (d0 - lo) / (hi - lo) if hi - lo > 1e-6 else numpy.zeros_like(d0)
    # Sharpen the soft edge a little, so the background does not show through as a halo.
    d0 = numpy.clip((d0 - 0.25) / 0.5, 0.0, 1.0)
    return cv2.GaussianBlur(cv2.resize((d0 * 255).astype(numpy.uint8), (width, height), interpolation=cv2.INTER_LINEAR), (0, 0), max(1.0, width / 640))


def subject_mask_video(video: str, out: str, start: float, end: float, fps: float) -> dict:
    """Mask frames for source seconds [start, end) at `fps`, written to `out`."""
    _net()  # fail before reading any video when the model is absent
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise ValueError(f"cannot open {video}")
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, start) * 1000)
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height), isColor=False)
        if not writer.isOpened():
            raise ValueError(f"cannot write {out}")
        count = max(1, round((end - start) * fps))
        frame, mask, at = None, None, None
        for k in range(count):
            t = start + k / fps
            # Read forward to the source frame showing at t; reuse its mask when the source is slower.
            while at is None or at + 1e-4 < t:
                ok, next_frame = cap.read()
                if not ok:
                    break
                frame, at, mask = next_frame, cap.get(cv2.CAP_PROP_POS_MSEC) / 1000, None
            if frame is None:
                break
            if mask is None:
                mask = subject_map(frame)
            writer.write(mask)
        writer.release()
    finally:
        cap.release()
    return {"out": out, "frames": count, "width": width, "height": height}


def subject_mask_still(image: str, out: str) -> dict:
    """Mask for one still (the agent's preview frames): greyscale PNG at its size, white = subject."""
    _net()
    bgr = cv2.imread(image, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"cannot read {image}")
    if not cv2.imwrite(out, subject_map(bgr)):
        raise ValueError(f"cannot write {out}")
    return {"out": out, "width": int(bgr.shape[1]), "height": int(bgr.shape[0])}
