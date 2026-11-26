"""Object picks with a stub segmenter: no model, no onnxruntime. The stub "encodes" a frame as itself and "decodes" the
colour blob under the prompt (the first point, else the box's centre), the way a real segmenter answers a click."""

import json
import os
import subprocess
import sys
from types import SimpleNamespace

import cv2
import numpy

from voxtale_native import objects


class _Enc:
    def get_inputs(self):
        return [SimpleNamespace(name="input_image", shape=["h", "w", 3])]

    def run(self, _, feeds):
        return [feeds["input_image"]]


class _Dec:
    def __init__(self):
        self.calls = []

    def get_outputs(self):
        return [SimpleNamespace(name=n) for n in ("masks", "iou_predictions", "low_res_masks")]

    def run(self, _, feeds):
        self.calls.append(feeds)
        img = feeds["image_embeddings"]
        h, w = (int(v) for v in feeds["orig_im_size"])
        coords, labels = feeds["point_coords"][0], feeds["point_labels"][0]
        at = [c for c, l in zip(coords, labels) if l == 1]
        if not at and 2 in labels:
            a, b = coords[list(labels).index(2)], coords[list(labels).index(3)]
            at = [(a + b) / 2]
        x, y = (int(round(v)) for v in at[0])
        x, y = min(w - 1, max(0, x)), min(h - 1, max(0, y))
        near = numpy.abs(img.astype(numpy.float32) - img[y, x].astype(numpy.float32)).sum(-1) < 30
        _, lab = cv2.connectedComponents(near.astype(numpy.uint8))
        mask = (lab == lab[y, x]).astype(numpy.float32) * 2 - 1
        return [mask[None, None], numpy.array([[0.9]], numpy.float32), numpy.zeros((1, 1, 256, 256), numpy.float32)]


def _seg():
    return objects.Segmenter(_Enc(), _Dec())


def _frame(k: int) -> numpy.ndarray:
    img = numpy.full((180, 320, 3), 90, numpy.uint8)
    cv2.circle(img, (100 + 4 * k, 90), 30, (40, 120, 230), -1)  # moves right
    cv2.rectangle(img, (230, 40), (290, 140), (200, 200, 40), -1)  # stays
    return img


def _clip(path: str, frames: int = 10, fps: float = 10) -> None:
    w = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), fps, (320, 180))
    for k in range(frames):
        w.write(_frame(k))
    w.release()


def test_prompt_maps_box_points_and_exclusions_to_sam_labels():
    pts, labels = objects.prompt({"box": [0.1, 0.2, 0.5, 0.5], "points": [[0.5, 0.5]], "exclude": [[0.9, 0.9]]}, 1000, 500)
    assert labels == [2, 3, 1, 0]
    assert pts[0] == [100, 100] and pts[1] == [600, 350] and pts[2] == [500, 250]
    assert objects.usable({"mode": "add", "points": [[0.5, 0.5]]})
    assert not objects.usable({"mode": "add", "exclude": [[0.5, 0.5]]})
    assert not objects.usable({"mode": "blur", "points": [[0.5, 0.5]]})


def test_decode_pads_a_point_prompt_and_normalises_a_four_d_encoder():
    dec = _Dec()
    seg = objects.Segmenter(_Enc(), dec)
    img = numpy.zeros((10, 20, 3), numpy.uint8)
    seg.decode(img, [[5, 5]], [1], (10, 20))
    assert list(dec.calls[0]["point_labels"][0]) == [1, -1]
    assert dec.calls[0]["has_mask_input"][0] == 0
    seg.decode(img, [[0, 0], [5, 5]], [2, 3], (10, 20), numpy.ones((256, 256), numpy.float32))
    assert list(dec.calls[1]["point_labels"][0]) == [2, 3] and dec.calls[1]["has_mask_input"][0] == 1

    class Enc4(_Enc):
        def get_inputs(self):
            return [SimpleNamespace(name="x", shape=[1, 3, 1024, 1024])]

        def run(self, _, feeds):
            return [feeds["x"]]

    out = objects.Segmenter(Enc4(), dec).encode(numpy.full((576, 1024, 3), 255, numpy.uint8))
    assert out.shape == (1, 3, 1024, 1024) and out[0, 0, 0, 0] > 1 and out[0, 0, 1000, 0] == 0


def test_follow_tracks_a_moving_object_both_ways():
    frames = [cv2.cvtColor(_frame(k), cv2.COLOR_BGR2RGB) for k in range(9)]
    got = objects.follow(_seg(), frames, [{"mode": "add", "points": [[(100 + 16) / 320, 0.5]], "k": 4}])[0]
    assert all(m is not None for m in got)
    for k, m in enumerate(got):
        cx = numpy.nonzero(m)[1].mean()
        assert abs(cx - (100 + 4 * k)) < 3, (k, cx)
        assert not m[90, 260]  # never the box


def test_combine_adds_and_removes_with_a_margin():
    base = numpy.zeros((100, 100), numpy.float32)
    base[20:80, 20:60] = 1
    lamp = numpy.zeros_like(base)
    lamp[10:30, 70:90] = 1
    out = objects.combine(base, [("add", lamp)])
    assert out[20, 80] == 1 and out[50, 40] == 1
    hand = numpy.zeros_like(base)
    hand[40:60, 20:40] = 1
    out = objects.combine(base, [("remove", hand)])
    assert out[50, 30] == 0 and out[50, 55] == 1 and out[50, 40] == 0  # the margin goes too (1 px at this size)


def test_still_writes_mask_overlay_and_object_report(tmp_path):
    src = str(tmp_path / "in.png")
    cv2.imwrite(src, _frame(0))
    out, overlay = str(tmp_path / "m.png"), str(tmp_path / "o.jpg")
    r = objects.objects_still(src, out, [{"mode": "add", "box": [230 / 320, 40 / 180, 60 / 320, 100 / 180]}], subject=False, overlay=overlay,
                              segmenter=_seg())
    m = cv2.imread(out, cv2.IMREAD_GRAYSCALE)
    assert m[90, 260] > 200 and m[90, 100] < 30
    assert os.path.exists(overlay) and r["objects"][0]["mode"] == "add"
    x, y, w, h = r["objects"][0]["box"]
    assert abs(x - 230 / 320) < 0.02 and abs(w - 61 / 320) < 0.02 and 0.05 < r["objects"][0]["area"] < 0.15


def test_video_mask_follows_object_without_subject(tmp_path):
    src, out = str(tmp_path / "in.avi"), str(tmp_path / "m.avi")
    _clip(src)
    r = objects.objects_mask_video(src, out, 0.0, 0.8, 10, [{"mode": "add", "t": 0.4, "points": [[116 / 320, 0.5]]}], subject=False, segmenter=_seg())
    assert (r["frames"], r["width"], r["height"]) == (8, 320, 180) and r["seen"] == [8]
    cap = cv2.VideoCapture(out)
    for k in range(8):
        ok, m = cap.read()
        assert ok
        assert m[90, 100 + 4 * k, 0] > 128 and m[90, 260, 0] < 60 and m[10, 10, 0] < 60, k
    cap.release()


def test_missing_object_model_is_a_no_model_error(tmp_path):
    env = {**os.environ, "VOXTALE_OBJECT_ENCODER": str(tmp_path / "none.onnx")}
    src = str(tmp_path / "x.png")
    cv2.imwrite(src, _frame(0))
    req = json.dumps({"image": src, "out": str(tmp_path / "m.png"), "objects": [{"mode": "add", "points": [[0.5, 0.5]]}]})
    p = subprocess.run([sys.executable, "-m", "voxtale_native", "objects_still"], input=req, capture_output=True, text=True, env=env)
    assert p.returncode == 1 and json.loads(p.stdout)["error"].startswith("NoModel: no-model:")
