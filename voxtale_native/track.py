"""Subject path (auto reframe) and point tracking (title motion tracking).

``subject_path``: where the speaker is, frame by frame, over a span of a clip,
so a tall crop of a wide shot can follow them. Largest YuNet face; where no
face shows (back turned, too small), a person found by OpenCV's HOG people
detector stands in, aimed at the head (top fifth of the body box). Between
frames the subject nearest the last one wins among the big ones, so a passer-by
in the back does not take the crop. Output rows: [t, cx, cy, w, h] in fractions
of the frame, or [t, None, None, None, None] when nobody is seen.

``track_point``: a point of the set followed as the camera moves (After
Effects Track Motion): corners near the point are followed frame to frame
with pyramidal Lucas-Kanade, kept when the backward track lands home, and the
similarity (shift, scale, rotation) that best explains them is fitted with
RANSAC, so a person walking through the patch does not drag it. Output rows:
[t, x, y, scale, rotation_deg] relative to the anchor frame.

Both read the video with cv2.VideoCapture; no model download beyond YuNet.
"""

from __future__ import annotations

from typing import Callable, Iterator, Sequence

import cv2
import numpy

Box = tuple[float, float, float, float]  # cx, cy, w, h as fractions of the frame
Detector = Callable[[numpy.ndarray], list[Box]]

SUBJECT_HEIGHT = 360  # px the subject is looked for at: a face a tenth of the frame tall is still found
TRACK_HEIGHT = 540  # px points are tracked at: enough texture on a facade, quick
MAX_RATE = 10  # subject samples per second at most: a smoothed crop needs no more
MAX_SUBJECT_S = 3600
MAX_TRACK_S = 120


def read_frames(video: str, start: float, end: float, height: int, rate: float | None = None) -> Iterator[tuple[float, numpy.ndarray]]:
    """(source second, BGR frame scaled to `height`) for frames in [start, end], at most `rate` a second (None: every frame)."""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise ValueError(f"cannot open {video}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        if not 1 <= fps <= 240:
            fps = 30.0
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, start - 0.5 / fps) * 1000)
        step = 0.0 if rate is None else 1.0 / rate
        next_t = start
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
            if t < start - 0.5 / fps:
                continue
            if t > end + 0.5 / fps:
                break
            if t + 0.5 / fps < next_t:
                continue
            next_t = t + step
            h, w = frame.shape[:2]
            if h > height:
                frame = cv2.resize(frame, (round(w * height / h / 2) * 2, height), interpolation=cv2.INTER_AREA)
            yield round(t, 4), frame
    finally:
        cap.release()


# ---- subject path (auto reframe) --------------------------------------------


def yunet_faces(bgr: numpy.ndarray) -> list[Box]:
    from voxtale_native.faces import _detector

    height, width = bgr.shape[:2]
    detector = _detector()
    detector.setInputSize((width, height))
    _, faces = detector.detect(bgr)
    if faces is None:
        return []
    return [((f[0] + f[2] / 2) / width, (f[1] + f[3] / 2) / height, f[2] / width, f[3] / height) for f in faces if f[-1] >= 0.6]


_hog: cv2.HOGDescriptor | None = None


def hog_people(bgr: numpy.ndarray) -> list[Box]:
    """People (HOG + linear SVM, built into OpenCV), each aimed at the head: the top fifth of the body box."""
    global _hog
    if _hog is None:
        _hog = cv2.HOGDescriptor()
        _hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    height, width = bgr.shape[:2]
    rects, weights = _hog.detectMultiScale(bgr, winStride=(8, 8), padding=(8, 8), scale=1.05)
    out = []
    for (x, y, w, h), score in zip(rects, numpy.ravel(weights) if len(rects) else []):
        if score < 0.5:
            continue
        out.append(((x + w / 2) / width, (y + h / 10) / height, w / width, h / 5 / height))
    return out


def pick(found: Sequence[Box], last: tuple[float, float] | None) -> Box | None:
    """The subject among those found: the biggest, unless one nearly as big is nearer the last one."""
    if not found:
        return None
    big = max(f[2] * f[3] for f in found)
    near = [f for f in found if f[2] * f[3] >= 0.5 * big]  # the ones that count: not a passer-by in the back
    if last is None:
        return max(near, key=lambda f: f[2] * f[3])
    return min(near, key=lambda f: (f[0] - last[0]) ** 2 + (f[1] - last[1]) ** 2)


def subject_rows(frames: Iterator[tuple[float, numpy.ndarray]], faces: Detector = yunet_faces, people: Detector | None = hog_people) -> list[list]:
    """One row per frame: [t, cx, cy, w, h, kind] (kind "face" or "person"), or [t, None x4, None] when nobody is seen."""
    rows, last = [], None
    for t, bgr in frames:
        kind, found = "face", faces(bgr)
        if not found and people is not None:
            kind, found = "person", people(bgr)
        f = pick(found, last)
        if f:
            last = (f[0], f[1])
            rows.append([t, *(round(float(v), 4) for v in f), kind])
        else:
            rows.append([t, None, None, None, None, None])
    return rows


def subject_path(video: str, start: float, end: float, rate: float = 5.0, people: bool = True) -> dict:
    if end <= start:
        raise ValueError("end must be after start")
    if end - start > MAX_SUBJECT_S:
        raise ValueError(f"at most {MAX_SUBJECT_S} s at a time")
    rows = subject_rows(read_frames(video, start, end, SUBJECT_HEIGHT, min(MAX_RATE, max(0.5, rate))), people=hog_people if people else None)
    return {"frames": rows, "faces": sum(r[5] == "face" for r in rows), "people": sum(r[5] == "person" for r in rows)}


# ---- point tracking (title motion tracking) ---------------------------------

MIN_POINTS = 12


def _corners(gray: numpy.ndarray, zone: tuple[int, int, int, int]) -> numpy.ndarray | None:
    x0, y0, x1, y1 = zone
    mask = numpy.zeros_like(gray)
    mask[y0:y1, x0:x1] = 255
    return cv2.goodFeaturesToTrack(gray, maxCorners=200, qualityLevel=0.01, minDistance=6, mask=mask, blockSize=7)


def _zone_px(center: numpy.ndarray, half: numpy.ndarray, w: int, h: int) -> tuple[int, int, int, int]:
    x0, y0 = numpy.maximum(0, center - half).astype(int)
    x1, y1 = numpy.minimum([w, h], center + half).astype(int)
    return int(x0), int(y0), int(x1), int(y1)


LK = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))


def step_similarity(a: numpy.ndarray, b: numpy.ndarray, pts: numpy.ndarray) -> tuple[numpy.ndarray | None, numpy.ndarray]:
    """The similarity (2x3) taking frame a to frame b, from corners `pts` of a, and the corners that held (in b)."""
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(a, b, pts, None, **LK)
    back, st2, _ = cv2.calcOpticalFlowPyrLK(b, a, nxt, None, **LK)
    ok = (st.ravel() == 1) & (st2.ravel() == 1) & (numpy.linalg.norm((back - pts).reshape(-1, 2), axis=1) < 1.0)
    if ok.sum() < 4:
        return None, nxt[ok]
    M, inliers = cv2.estimateAffinePartial2D(pts[ok], nxt[ok], method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=2000, confidence=0.99)
    if M is None or inliers is None or inliers.sum() < 4:
        return None, nxt[ok]
    return M, nxt[ok][inliers.ravel() == 1]


def track_frames(frames: list[numpy.ndarray], k0: int, point: tuple[float, float], zone: tuple[float, float, float, float] | None = None) -> dict[int, tuple[float, float, float, float]]:
    """Frame index -> (x, y, scale, rotation) of `point` (fractions, at frame k0), following frames out from k0 both ways."""
    grays = [f if f.ndim == 2 else cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]
    h, w = grays[0].shape[:2]
    zx, zy, zw, zh = zone or (point[0] - 0.3, point[1] - 0.25, 0.6, 0.5)
    p0 = numpy.array([point[0] * w, point[1] * h])
    # The zone rides with the point: its centre's offset from the point and its half size scale with the set.
    offset0 = numpy.array([(zx + zw / 2) * w, (zy + zh / 2) * h]) - p0
    half0 = numpy.array([zw * w / 2, zh * h / 2])
    out = {k0: (point[0], point[1], 1.0, 0.0)}
    for direction in (1, -1):
        p, s, r = p0.copy(), 1.0, 0.0
        rot = numpy.eye(2)
        pts = None
        i = k0
        while 0 <= i + direction < len(grays):
            j = i + direction
            zone_i = _zone_px(p + s * (rot @ offset0), s * half0, w, h)
            if pts is None or len(pts) < MIN_POINTS:
                pts = _corners(grays[i], zone_i)
            M = None
            if pts is not None and len(pts) >= 4:
                M, held = step_similarity(grays[i], grays[j], pts)
                pts = held.reshape(-1, 1, 2).astype(numpy.float32) if len(held) else None
            if M is not None:
                # A frame with nothing reliable (a cut, motion blur) keeps the last place.
                p = M[:, :2] @ p + M[:, 2]
                k = float(numpy.hypot(M[0, 0], M[1, 0]))
                a = float(numpy.arctan2(M[1, 0], M[0, 0]))
                s *= k
                r += numpy.degrees(a)
                rot = numpy.array([[numpy.cos(numpy.radians(r)), -numpy.sin(numpy.radians(r))], [numpy.sin(numpy.radians(r)), numpy.cos(numpy.radians(r))]])
            else:
                pts = None
            i = j
            out[i] = (float(p[0] / w), float(p[1] / h), s, r)
    return out


def track_point(video: str, start: float, end: float, at: float, point: Sequence[float], zone: Sequence[float] | None = None) -> dict:
    """Follow `point` (fractions of the frame, at source second `at`) from `start` to `end`; `zone` (x, y, w, h fractions) is the set that drives it."""
    if not start <= at <= end:
        raise ValueError("at must be between start and end")
    if end - start > MAX_TRACK_S:
        raise ValueError(f"at most {MAX_TRACK_S} s at a time")
    read = list(read_frames(video, start, end, TRACK_HEIGHT))
    if not read:
        raise ValueError(f"no frames between {start:.2f} and {end:.2f} s")
    times = [t for t, _ in read]
    k0 = min(range(len(times)), key=lambda k: abs(times[k] - at))
    rows = track_frames([f for _, f in read], k0, (float(point[0]), float(point[1])), tuple(zone) if zone else None)  # type: ignore[arg-type]
    return {"at": times[k0], "frames": [[times[k], round(x, 5), round(y, 5), round(s, 5), round(r, 3)] for k, (x, y, s, r) in sorted(rows.items())]}
