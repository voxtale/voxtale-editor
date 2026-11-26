"""Largest face per still (YuNet), for zoom focus in the video editor.

Boxes and the eyes' midpoint come back as fractions of the frame so callers
never see pixels.
"""

from __future__ import annotations

import cv2
import numpy

import threading
from pathlib import Path

YUNET_MODEL = Path(__file__).resolve().parents[1] / "models/face_detection_yunet_2023mar.onnx"
_detector_local = threading.local()


def _detector() -> "cv2.FaceDetectorYN":
    # FaceDetectorYN is stateful (setInputSize) and not thread-safe.
    if not hasattr(_detector_local, "detector"):
        if not YUNET_MODEL.exists():
            raise FileNotFoundError(f"YuNet face model missing at {YUNET_MODEL}")
        _detector_local.detector = cv2.FaceDetectorYN.create(str(YUNET_MODEL), "", (0, 0))
    return _detector_local.detector



def largest_face(jpeg: bytes) -> dict | None:
    image = cv2.imdecode(numpy.frombuffer(jpeg, numpy.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    height, width = image.shape[:2]
    detector = _detector()
    detector.setInputSize((width, height))
    _, faces = detector.detect(image)
    if faces is None or len(faces) == 0:
        return None
    face = max(faces, key=lambda f: f[2] * f[3])
    x, y, w, h = face[:4]
    # YuNet landmarks: right eye (4, 5), left eye (6, 7), then nose and mouth.
    eye_x, eye_y = (face[4] + face[6]) / 2, (face[5] + face[7]) / 2
    clamp = lambda v: float(min(1.0, max(0.0, v)))
    return {
        "x": clamp((x + w / 2) / width),
        "y": clamp((y + h / 2) / height),
        "w": clamp(w / width),
        "h": clamp(h / height),
        "eyes": {"x": clamp(eye_x / width), "y": clamp(eye_y / height)},
    }
