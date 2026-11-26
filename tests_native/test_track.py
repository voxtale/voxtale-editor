"""Subject path and point tracking on synthetic frames (moving shapes), never real footage."""

import cv2
import numpy
import pytest

from voxtale_native.track import pick, read_frames, subject_path, subject_rows, track_frames, track_point

W, H, FPS = 640, 360, 25


def _texture(w: int, h: int, seed: int = 1) -> numpy.ndarray:
    rng = numpy.random.default_rng(seed)
    noise = rng.integers(0, 255, (h // 8, w // 8), numpy.uint8)
    base = cv2.resize(noise, (w, h), interpolation=cv2.INTER_NEAREST)
    return cv2.GaussianBlur(base, (0, 0), 1.2)


def _write(path, frames) -> str:
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, (W, H))
    assert writer.isOpened()
    for f in frames:
        writer.write(f if f.ndim == 3 else cv2.cvtColor(f, cv2.COLOR_GRAY2BGR))
    writer.release()
    return str(path)


def _blob(bgr):
    """Fake detector: the white disc's box."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    ys, xs = numpy.nonzero(gray > 200)
    if not len(xs):
        return []
    h, w = gray.shape
    return [((xs.min() + xs.max()) / 2 / w, (ys.min() + ys.max()) / 2 / h, (xs.max() - xs.min()) / w, (ys.max() - ys.min()) / h)]


def test_pick_keeps_the_subject_near_the_last_one():
    big, other = (0.3, 0.5, 0.2, 0.3), (0.8, 0.5, 0.18, 0.28)
    assert pick([big, other], None) == big
    assert pick([big, other], (0.79, 0.5)) == other
    assert pick([big, (0.8, 0.5, 0.05, 0.05)], (0.79, 0.5)) == big  # a small face in the back never wins


def test_subject_rows_follow_a_moving_disc(tmp_path):
    frames = []
    for k in range(50):
        f = numpy.full((H, W, 3), 40, numpy.uint8)
        cv2.circle(f, (100 + k * 8, 180), 30, (255, 255, 255), -1)
        frames.append(f)
    video = _write(tmp_path / "disc.avi", frames)
    rows = subject_rows(read_frames(video, 0, 2.0, 360, rate=5), faces=_blob, people=None)
    assert 9 <= len(rows) <= 11
    for t, cx, *_ in rows:
        assert cx == pytest.approx((100 + t * FPS * 8) / W, abs=0.02)


def test_person_stands_in_when_no_face():
    frame = numpy.zeros((10, 10, 3), numpy.uint8)
    rows = subject_rows(iter([(0.0, frame), (0.2, frame)]), faces=lambda _: [], people=lambda _: [(0.7, 0.2, 0.1, 0.1)])
    assert [r[1] for r in rows] == [0.7, 0.7] and rows[0][5] == "person"
    empty = subject_rows(iter([(0.0, frame)]), faces=lambda _: [], people=None)
    assert empty == [[0.0, None, None, None, None, None]]


def test_subject_path_without_faces_returns_empty_rows(tmp_path):
    video = _write(tmp_path / "flat.avi", [numpy.full((H, W, 3), 90, numpy.uint8)] * 20)
    out = subject_path(video, 0, 0.7, rate=5, people=False)
    assert out["faces"] == 0 and all(r[1] is None for r in out["frames"])


def test_track_follows_a_pan(tmp_path):
    big = _texture(W + 200, H + 100)
    frames = [big[2 * k:2 * k + H, 3 * k:3 * k + W] for k in range(40)]  # camera pans right and down
    rows = track_frames(frames, 20, (0.5, 0.5))
    for k, (x, y, s, _) in rows.items():
        assert x * W == pytest.approx(0.5 * W - 3 * (k - 20), abs=1.0)
        assert y * H == pytest.approx(0.5 * H - 2 * (k - 20), abs=1.0)
        assert s == pytest.approx(1.0, abs=0.01)


def test_track_follows_a_push_in():
    base = _texture(W, H, 3)
    frames = []
    for k in range(30):
        s = 1 + 0.01 * k
        M = cv2.getRotationMatrix2D((W / 2, H / 2), 0, s)
        frames.append(cv2.warpAffine(base, M, (W, H), borderMode=cv2.BORDER_REFLECT))
    rows = track_frames(frames, 0, (0.7, 0.4))
    x, y, s, _ = rows[29]
    want = 1.29
    assert s == pytest.approx(want, rel=0.01)
    assert x == pytest.approx(0.5 + (0.7 - 0.5) * want, abs=0.004)
    assert y == pytest.approx(0.5 + (0.4 - 0.5) * want, abs=0.004)


def test_track_ignores_a_shape_crossing_the_patch():
    big = _texture(W + 200, H, 5)
    frames = []
    for k in range(30):
        f = big[:, 4 * k:4 * k + W].copy()
        cv2.rectangle(f, (200 + 12 * k, 140), (260 + 12 * k, 220), 0, -1)  # something walks the other way
        frames.append(f)
    rows = track_frames(frames, 0, (0.5, 0.5))
    assert rows[29][0] * W == pytest.approx(0.5 * W - 4 * 29, abs=1.5)


def test_track_point_reads_a_video(tmp_path):
    big = _texture(W + 100, H, 7)
    video = _write(tmp_path / "pan.avi", [cv2.cvtColor(big[:, 2 * k:2 * k + W], cv2.COLOR_GRAY2BGR) for k in range(25)])
    out = track_point(video, 0, 0.96, 0.4, [0.5, 0.5])
    assert out["at"] == pytest.approx(0.4, abs=0.02)
    first, last = out["frames"][0], out["frames"][-1]
    assert (first[1] - last[1]) * W == pytest.approx(2 * (len(out["frames"]) - 1), abs=2.0)
