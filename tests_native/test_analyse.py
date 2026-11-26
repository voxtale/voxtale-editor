"""The style analyser's pure parts on synthetic frames: no video, no ffmpeg."""
import numpy as np
from scipy.ndimage import gaussian_filter, zoom

from voxtale_native.analyse import classify, find_cuts, split_flashes


def _metrics(n=120, peaks=(), color=()):
    d = np.full(n, 2.0)
    for i in peaks:
        d[i] = 60.0
    c = np.zeros(n)
    for i in color:
        c[i] = 0.6
    return {"diff": d, "color": c}


def test_cuts_are_the_difference_peaks():
    assert find_cuts(_metrics(peaks=(30, 31, 80)), 30.0) == [30, 80]  # 30 and 31: one cut


def test_a_flash_back_to_the_same_shot_is_no_cut():
    m = _metrics(peaks=(40, 42))
    m["luma"] = np.full(120, 100.0)
    m["luma"][40:42] = 250.0
    m["back"] = np.zeros(120)
    cuts, flashes = split_flashes([40, 42, 90], m)
    assert flashes == [40] and cuts == [90]


def _scene(h=90, w=160):
    rng = np.random.default_rng(1)
    return gaussian_filter(rng.random((h, w)) * 255, 3)


def test_same_framing_and_a_punch_in():
    a = _scene()
    assert classify(a, a.copy())["kind"] == "same"
    h, w = a.shape
    crop = a[h // 8:h - h // 8, w // 8:w - w // 8]
    b = zoom(crop, (h / crop.shape[0], w / crop.shape[1]), order=1)[:h, :w]
    r = classify(a, b)
    assert r["kind"] == "zoom-in" and 1.2 < r["scale"] < 1.45


def test_another_shot_is_a_cut():
    assert classify(_scene(), np.random.default_rng(9).random((90, 160)) * 255)["kind"] == "cut"
