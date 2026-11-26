# /// script
# requires-python = ">=3.10"
# dependencies = ["opencv-python-headless>=4.8,<5", "numpy"]
# ///
"""Largest face per still (YuNet), for zoom in the local editor MCP.

Standalone copy of faces.py in this folder: `uv run --script uv_faces.py`
fetches Python and OpenCV on first use, so a machine without the .venv still
finds faces (src/native/uv-faces.ts). Reads {"images_b64": [...]}
on stdin, writes {"faces": [...]}; boxes and the eyes' midpoint are fractions
of the frame. The model path is the first argument, else the .onnx next to
this file.
"""

import base64
import json
import sys
from pathlib import Path

import cv2
import numpy

MODEL = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent / "face_detection_yunet_2023mar.onnx"


def largest_face(detector, jpeg: bytes):
    image = cv2.imdecode(numpy.frombuffer(jpeg, numpy.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    height, width = image.shape[:2]
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


def main() -> None:
    if not MODEL.exists():
        json.dump({"error": f"face model missing at {MODEL}"}, sys.stdout)
        return
    detector = cv2.FaceDetectorYN.create(str(MODEL), "", (0, 0))
    request = json.load(sys.stdin)
    faces = [largest_face(detector, base64.b64decode(b)) for b in request.get("images_b64", [])]
    json.dump({"faces": faces}, sys.stdout)


if __name__ == "__main__":
    main()
