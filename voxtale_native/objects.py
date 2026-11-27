"""Objects added to the subject mask or cut out of it, picked by point or box on one still and followed both ways from it.

Runs anywhere the face finder does:
MobileSAM (Apache-2.0 code, MIT ONNX export by Acly; 28 MB encoder + 16 MB decoder) through onnxruntime on the CPU.
Not in git: ``tools/fetch-object-model.sh`` puts both files in models/ (or set VOXTALE_OBJECT_ENCODER / _DECODER).
Without them, or without onnxruntime, the op fails with a ``no-model:`` error and the render falls back to the plain
subject mask (or none).

MobileSAM has no video memory, so following an object is code: each frame, the points inside last frame's mask move
by optical flow (Lucas-Kanade), and the frame is segmented again from the moved prompt (its box, one point deep inside
it, the excluded points shifted, last frame's mask as a hint). A frame where the answer jumps (empty, three times the
size, or off the moved shape) keeps the moved shape instead; after LOST frames of that the object counts as gone.

An object (fractions of the source frame): {mode: add|remove, t: source second, points: [[x, y]], exclude: [[x, y]],
box: [x, y, w, h]}. The mask is a greyscale MJPG AVI at the source's size, one frame per output frame from ``start``,
white = what goes back over the graphic: the person (when ``subject``) plus added objects, less removed ones.
"""

from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

import cv2
import numpy

from voxtale_native.subject import NoModel, frames_at, open_video, subject_map

_MODELS = Path(__file__).resolve().parents[1] / "models"
ENCODER = Path(os.environ.get("VOXTALE_OBJECT_ENCODER") or _MODELS / "mobile_sam_image_encoder.onnx")
DECODER = Path(os.environ.get("VOXTALE_OBJECT_DECODER") or _MODELS / "sam_mask_decoder_single.onnx")
SIDE = 1024  # SAM's input: long side 1024, padded square
LOW = 256  # SAM's low-res mask (the hint fed back the next frame)
PIXEL_MEAN = numpy.array([123.675, 116.28, 103.53], numpy.float32)
PIXEL_STD = numpy.array([58.395, 57.12, 57.375], numpy.float32)
LOST = 12  # frames an object may go unseen before it counts as gone
MAX_OBJECTS = 8
_local = threading.local()


class Segmenter:
    """Promptable segmenter: SAM's image encoder and mask decoder, as ONNX sessions (or anything with the same
    get_inputs/get_outputs/run, which is how tests stub it). Frames come in at the work size (long side SIDE)."""

    def __init__(self, encoder, decoder):
        self.encoder, self.decoder = encoder, decoder
        inp = encoder.get_inputs()[0]
        self._enc_input = inp.name
        # Acly's export takes HxWx3 RGB 0-255 and normalises and pads inside; a plain export takes 1x3x1024x1024.
        self._enc_preprocessed = len(inp.shape) == 4
        self._dec_outputs = [o.name for o in decoder.get_outputs()]

    @classmethod
    def load(cls) -> "Segmenter":
        if not hasattr(_local, "segmenter"):
            missing = [p for p in (ENCODER, DECODER) if not p.exists()]
            if missing:
                raise NoModel(f"no-model: object model missing at {missing[0]} (tools/fetch-object-model.sh)")
            try:
                import onnxruntime
            except ImportError as exc:
                raise NoModel("no-model: onnxruntime is not installed (pip install -r requirements.txt)") from exc
            opts = onnxruntime.SessionOptions()
            opts.log_severity_level = 3
            make = lambda p: onnxruntime.InferenceSession(str(p), opts, providers=["CPUExecutionProvider"])
            _local.segmenter = cls(make(ENCODER), make(DECODER))
        return _local.segmenter

    def encode(self, rgb: numpy.ndarray) -> numpy.ndarray:
        """Image embedding of an RGB uint8 frame whose long side is SIDE."""
        x = rgb.astype(numpy.float32)
        if self._enc_preprocessed:
            h, w = x.shape[:2]
            padded = numpy.zeros((SIDE, SIDE, 3), numpy.float32)  # SAM pads after normalising, so with 0
            padded[:h, :w] = (x - PIXEL_MEAN) / PIXEL_STD
            x = padded.transpose(2, 0, 1)[None]
        return self.encoder.run(None, {self._enc_input: x})[0]

    def decode(self, embedding, points, labels, size, hint=None) -> tuple[numpy.ndarray, numpy.ndarray, float]:
        """Mask logits at `size` (h, w), the low-res logits, and the decoder's own score. Points in work pixels;
        labels as SAM's: 1 in, 0 out, 2 and 3 a box's corners, -1 padding."""
        coords, labs = [list(p) for p in points], list(labels)
        if 2 not in labs:  # SAM's export expects a padding point when there is no box
            coords.append([0.0, 0.0])
            labs.append(-1)
        feeds = {
            "image_embeddings": embedding,
            "point_coords": numpy.array([coords], numpy.float32),
            "point_labels": numpy.array([labs], numpy.float32),
            "mask_input": (hint if hint is not None else numpy.zeros((LOW, LOW), numpy.float32))[None, None].astype(numpy.float32),
            "has_mask_input": numpy.array([1.0 if hint is not None else 0.0], numpy.float32),
            "orig_im_size": numpy.array(size, numpy.float32),
        }
        got = dict(zip(self._dec_outputs, self.decoder.run(None, feeds)))
        masks = got.get("masks", next(iter(got.values())))
        low = got.get("low_res_masks")
        score = got.get("iou_predictions")
        return masks[0, 0], (low[0, 0] if low is not None else None), float(score.ravel()[0]) if score is not None else 0.0


def work_size(width: int, height: int) -> tuple[int, int]:
    """(w, h) with the long side SIDE."""
    k = SIDE / max(width, height)
    return max(1, round(width * k)), max(1, round(height * k))


def _clip01(v) -> float:
    return min(1.0, max(0.0, float(v)))


def prompt(ob: dict, w: int, h: int) -> tuple[list[list[float]], list[int]]:
    """Points and SAM labels in work pixels: a box is its two corners (2, 3), points 1, excluded points 0."""
    pts, labels = [], []
    box = ob.get("box")
    if box and len(box) == 4:
        x0, y0 = _clip01(box[0]), _clip01(box[1])
        x1, y1 = _clip01(box[0] + box[2]), _clip01(box[1] + box[3])
        if x1 - x0 > 0.005 and y1 - y0 > 0.005:
            pts += [[x0 * w, y0 * h], [x1 * w, y1 * h]]
            labels += [2, 3]
    for p in ob.get("points") or []:
        pts.append([_clip01(p[0]) * w, _clip01(p[1]) * h])
        labels.append(1)
    for p in ob.get("exclude") or []:
        pts.append([_clip01(p[0]) * w, _clip01(p[1]) * h])
        labels.append(0)
    return pts, labels


def usable(ob: dict) -> bool:
    return ob.get("mode") in ("add", "remove") and any(l in (1, 2) for l in prompt(ob, 100, 100)[1])


def _bbox(mask: numpy.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = numpy.nonzero(mask)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _inner_point(mask: numpy.ndarray) -> list[float]:
    """The point deepest inside the mask (farthest from its edge)."""
    dist = cv2.distanceTransform(mask.astype(numpy.uint8), cv2.DIST_L2, 3)
    y, x = numpy.unravel_index(int(dist.argmax()), dist.shape)
    return [float(x), float(y)]


def flow_shift(prev_gray: numpy.ndarray, gray: numpy.ndarray, mask: numpy.ndarray) -> tuple[float, float]:
    """Median motion (px) of corners inside `mask` from one frame to the next; (0, 0) when too few track."""
    corners = cv2.goodFeaturesToTrack(prev_gray, 40, 0.01, 5, mask=mask.astype(numpy.uint8) * 255)
    if corners is None or len(corners) < 3:
        return 0.0, 0.0
    moved, status, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, corners, None, winSize=(21, 21), maxLevel=3)
    ok = status.ravel() == 1
    if ok.sum() < 3:
        return 0.0, 0.0
    d = (moved[ok] - corners[ok]).reshape(-1, 2)
    return float(numpy.median(d[:, 0])), float(numpy.median(d[:, 1]))


def _shift(img: numpy.ndarray, dx: float, dy: float, size: tuple[int, int] | None = None) -> numpy.ndarray:
    if abs(dx) < 1e-3 and abs(dy) < 1e-3:
        return img
    h, w = img.shape[:2]
    m = numpy.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(img, m, size or (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def _iou(a: numpy.ndarray, b: numpy.ndarray) -> float:
    u = numpy.logical_or(a, b).sum()
    return float(numpy.logical_and(a, b).sum() / u) if u else 0.0


class Track:
    """One object followed from its first frame: last mask (work size, bool), the decoder's low-res hint, excluded
    points, and how many frames it has gone unseen."""

    def __init__(self, mask, low, exclude):
        self.mask, self.low, self.exclude, self.unseen = mask, low, exclude, 0

    def copy(self) -> "Track":
        t = Track(self.mask.copy(), None if self.low is None else self.low.copy(), [list(p) for p in self.exclude])
        t.unseen = self.unseen
        return t


def first(seg: Segmenter, embedding, ob: dict, w: int, h: int) -> Track:
    pts, labels = prompt(ob, w, h)
    logits, low, _ = seg.decode(embedding, pts, labels, (h, w))
    return Track(logits > 0, low, [p for p, l in zip(pts, labels) if l == 0])


def step(seg: Segmenter, embedding, track: Track, prev_gray, gray) -> Track:
    """The track one frame on: its prompt moved by optical flow, segmented again; the moved shape when the answer jumps."""
    if not track.mask.any():
        return track
    h, w = track.mask.shape
    dx, dy = flow_shift(prev_gray, gray, track.mask)
    moved = _shift(track.mask.astype(numpy.uint8), dx, dy) > 0
    exclude = [[x + dx, y + dy] for x, y in track.exclude]
    box = _bbox(moved)
    if box is None:
        return Track(moved, None, exclude)
    x0, y0, x1, y1 = box
    pad = 0.05 * max(x1 - x0, y1 - y0)
    pts = [[max(0, x0 - pad), max(0, y0 - pad)], [min(w, x1 + pad), min(h, y1 + pad)], _inner_point(moved), *exclude]
    labels = [2, 3, 1, *[0] * len(exclude)]
    hint = None if track.low is None else _shift(track.low, dx * LOW / SIDE, dy * LOW / SIDE)
    logits, low, _ = seg.decode(embedding, pts, labels, (h, w), hint)
    got = logits > 0
    area, was = got.sum(), moved.sum()
    if area == 0 or area > 3 * was or _iou(got, moved) < 0.2:
        out = Track(moved, hint, exclude)
        out.unseen = track.unseen + 1
        if out.unseen > LOST:
            out.mask = numpy.zeros_like(moved)
        return out
    return Track(got, low, exclude)


def follow(seg: Segmenter, frames, objects: list[dict]) -> list[list[numpy.ndarray | None]]:
    """Each object's work-size mask in every frame (None where gone), followed forward and back from its frame `k`.
    `frames` is a sequence of RGB uint8 work-size frames. Each frame is encoded once per direction for all objects."""
    n = len(frames)
    if not n:
        return [[] for _ in objects]
    h, w = frames[0].shape[:2]
    out: list[list[numpy.ndarray | None]] = [[None] * n for _ in objects]
    starts = [min(n - 1, max(0, int(ob.get("k", 0)))) for ob in objects]
    seed: dict[int, Track] = {}
    gray = lambda k: cv2.cvtColor(frames[k], cv2.COLOR_RGB2GRAY)

    # Forward, from each object's frame.
    live: dict[int, Track] = {}
    prev = None
    for k in range(min(starts), n):
        due = [j for j, s in enumerate(starts) if s == k]
        if not due and not live:
            prev = None
            continue
        g, emb = gray(k), seg.encode(frames[k])
        for j in list(live):
            live[j] = step(seg, emb, live[j], prev, g)
        for j in due:
            live[j] = first(seg, emb, objects[j], w, h)
            seed[j] = live[j].copy()
        for j, t in live.items():
            out[j][k] = t.mask if t.mask.any() else None
        live = {j: t for j, t in live.items() if t.mask.any()}
        prev = g

    # Back, from the frame before each object's.
    live, prev = {}, None
    for k in range(max(starts) - 1, -1, -1):
        due = [j for j, s in enumerate(starts) if s == k + 1 and j in seed]
        if not due and not live:
            continue
        g, emb = gray(k), seg.encode(frames[k])
        for j in list(live):
            live[j] = step(seg, emb, live[j], prev, g)
        if due:
            after = gray(k + 1)
            for j in due:
                live[j] = step(seg, emb, seed[j], after, g)
        for j, t in live.items():
            out[j][k] = t.mask if t.mask.any() else None
        live = {j: t for j, t in live.items() if t.mask.any()}
        prev = g
    return out


def soft(mask: numpy.ndarray, width: int, height: int) -> numpy.ndarray:
    """A work-size bool mask as a 0-1 float map at the source size, edge softened a little."""
    big = cv2.resize(mask.astype(numpy.float32), (width, height), interpolation=cv2.INTER_LINEAR)
    return cv2.GaussianBlur(big, (0, 0), max(1.0, width / 960))


def combine(base: numpy.ndarray, layers: list[tuple[str, numpy.ndarray]]) -> numpy.ndarray:
    """The mask (0-1 float) with objects added (max) and removed (cut with a margin, crumbs near them dropped)."""
    m = base.astype(numpy.float32)
    h, w = m.shape
    for mode, p in layers:
        if mode == "add":
            m = numpy.maximum(m, p)
            continue
        # A 6 px margin, so the object's fringe goes with it (scaled to 1080p).
        r = max(1, round(6 * h / 1080))
        m = m * (1 - cv2.dilate(p, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))))
        # Near the removed object keep only what joins a big piece of the
        # mask (the person); bits of background taken with the object go.
        core = (m > 0.5).astype(numpy.uint8)
        count, lab, stats, _ = cv2.connectedComponentsWithStats(core, 8)
        if count > 1:
            big = numpy.isin(lab, [i for i in range(1, count) if stats[i, cv2.CC_STAT_AREA] >= 0.01 * h * w])
            rn = max(3, round(20 * h / 1080))
            near = cv2.dilate((p > 0.5).astype(numpy.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rn + 1, 2 * rn + 1))) > 0
            keep = cv2.dilate(big.astype(numpy.uint8), numpy.ones((5, 5), numpy.uint8)) > 0
            m = numpy.where(near & ~keep, 0.0, m)
    return numpy.clip(m, 0.0, 1.0)


def _check(objects: list[dict]) -> list[dict]:
    objects = [o for o in objects if usable(o)]
    if len(objects) > MAX_OBJECTS:
        raise ValueError(f"at most {MAX_OBJECTS} objects")
    return objects


def objects_mask_video(video: str, out: str, start: float, end: float, fps: float, objects: list[dict], subject: bool = True,
                       segmenter: Segmenter | None = None) -> dict:
    """Mask frames for source seconds [start, end) at `fps`: the subject (when asked) plus and minus the objects."""
    objects = _check(objects)
    seg = segmenter or (Segmenter.load() if objects else None)
    count = max(1, round((end - start) * fps))
    cap, width, height = open_video(video, start)
    ww, wh = work_size(width, height)
    tmp = tempfile.TemporaryDirectory(prefix="vx-objects-")
    try:
        # The span's frames at the work size, on disk (1.7 MB each at 16:9): followed both ways, then read again to write.
        frames = numpy.lib.format.open_memmap(os.path.join(tmp.name, "frames.npy"), "w+", numpy.uint8, (count, wh, ww, 3))
        n = 0
        for frame, _ in frames_at(cap, start, fps, count):
            frames[n] = cv2.cvtColor(cv2.resize(frame, (ww, wh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
            n += 1
        cap.release()
        frames = frames[:n]
        obs = [{**o, "k": round((float(o.get("t", start)) - start) * fps)} for o in objects]
        tracks = follow(seg, frames, obs) if objects else []
        writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height), isColor=False)
        if not writer.isOpened():
            raise ValueError(f"cannot write {out}")
        seen = [0] * len(objects)
        for k in range(n):
            base = (cv2.resize(subject_map(cv2.cvtColor(frames[k], cv2.COLOR_RGB2BGR)), (width, height)).astype(numpy.float32) / 255
                    if subject else numpy.zeros((height, width), numpy.float32))
            layers = []
            for j, ob in enumerate(objects):
                if tracks[j][k] is not None:
                    seen[j] += 1
                    layers.append((ob["mode"], soft(tracks[j][k], width, height)))
            writer.write((combine(base, layers) * 255).astype(numpy.uint8))
        writer.release()
    finally:
        cap.release()
        tmp.cleanup()
    return {"out": out, "frames": count, "width": width, "height": height, "seen": seen}


COLOURS = [(60, 200, 255), (255, 120, 60), (120, 255, 120), (255, 80, 200), (80, 160, 255), (255, 220, 60), (200, 120, 255), (60, 255, 220)]


def objects_still(image: str, out: str, objects: list[dict], subject: bool = False, overlay: str | None = None,
                  segmenter: Segmenter | None = None) -> dict:
    """One still: the mask PNG (white = drawn back over the graphic) and, for the agent, an overlay JPEG with each
    object tinted, outlined and numbered, and its points (green in, red out) and box drawn. Per object: share of the
    frame it covers, its box (fractions) and the decoder's score."""
    objects = [o for o in objects if usable(o)]
    if len(objects) > MAX_OBJECTS:
        raise ValueError(f"at most {MAX_OBJECTS} objects")
    bgr = cv2.imread(image, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"cannot read {image}")
    height, width = bgr.shape[:2]
    seg = segmenter or (Segmenter.load() if objects else None)
    ww, wh = work_size(width, height)
    rgb = cv2.cvtColor(cv2.resize(bgr, (ww, wh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    emb = seg.encode(rgb) if objects else None
    base = subject_map(bgr).astype(numpy.float32) / 255 if subject else numpy.zeros((height, width), numpy.float32)
    layers, found = [], []
    for ob in objects:
        pts, labels = prompt(ob, ww, wh)
        logits, _, score = seg.decode(emb, pts, labels, (wh, ww))
        mask = logits > 0
        box = _bbox(mask)
        found.append({"mode": ob["mode"], "area": round(float(mask.mean()), 4), "score": round(score, 3),
                      "box": None if box is None else [round(box[0] / ww, 3), round(box[1] / wh, 3), round((box[2] - box[0]) / ww, 3), round((box[3] - box[1]) / wh, 3)]})
        layers.append((ob["mode"], soft(mask, width, height)))
    if not cv2.imwrite(out, (combine(base, layers) * 255).astype(numpy.uint8)):
        raise ValueError(f"cannot write {out}")
    if overlay:
        view = bgr.astype(numpy.float32)
        for j, (mode, p) in enumerate(layers):
            colour = numpy.array(COLOURS[j % len(COLOURS)], numpy.float32)
            view = view * (1 - 0.45 * p[..., None]) + colour * 0.45 * p[..., None]
        view = view.astype(numpy.uint8)
        thick = max(1, round(width / 480))
        for j, (ob, (mode, p)) in enumerate(zip(objects, layers)):
            colour = COLOURS[j % len(COLOURS)]
            contours, _ = cv2.findContours((p > 0.5).astype(numpy.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(view, contours, -1, colour, thick)
            pts, labels = prompt(ob, width, height)
            for (x, y), l in zip(pts, labels):
                if l in (0, 1):
                    cv2.circle(view, (round(x), round(y)), 3 * thick + 2, (60, 220, 60) if l == 1 else (40, 40, 230), -1)
            corners = [(round(x), round(y)) for (x, y), l in zip(pts, labels) if l in (2, 3)]
            if len(corners) == 2:
                cv2.rectangle(view, corners[0], corners[1], colour, thick)
            box = found[j]["box"]
            if box:
                at = (round(box[0] * width) + 4, max(16, round(box[1] * height) - 6))
                cv2.putText(view, f"{j + 1} {mode}", at, cv2.FONT_HERSHEY_SIMPLEX, 0.5 * thick, colour, thick, cv2.LINE_AA)
        if not cv2.imwrite(overlay, view, [cv2.IMWRITE_JPEG_QUALITY, 85]):
            raise ValueError(f"cannot write {overlay}")
    return {"out": out, "width": width, "height": height, "objects": found, **({"overlay": overlay} if overlay else {})}
