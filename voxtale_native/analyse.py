# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "scipy"]
# ///
"""Measure the editing style of reference videos: speech, cuts and zooms,
sound, picture look, and contact sheets the agent looks at to write the style.
All on this machine, no model, no tokens. The numbers are orders of magnitude:
the agent checks them on the sheets.

Reads one JSON request on stdin:
  {"video": path, "out": dir, "words": [{text,start,end}]?, "only": "0-30,60-"?,
   "exclude": "314-391"?}
writes report.json, cuts.json, sound_events.json, sheets.json + sheets/*.jpg
into `out`, and prints {"report": {...}, "cut_times": [...]} on stdout.

Run with `uv run --script analyse.py` (fetches numpy and scipy once) or
`python -m voxtale_native analyse` from a venv that has them.
"""
from __future__ import annotations

import functools
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, laplace, map_coordinates, median_filter
from scipy.ndimage import zoom as rescale
from scipy.signal import fftconvolve

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
SMALL = 160  # long side of the measuring frames
FILLERS = {"um", "uh", "uhm", "umm", "erm", "er", "hmm", "mm"}


# ---------------------------------------------------------------- inputs

def seconds(s: str) -> float:
    """'83', '1:23' or '1:02:03.5' -> seconds."""
    t = 0.0
    for part in s.strip().split(":"):
        t = t * 60 + float(part)
    return t


def parse_ranges(s: str | None, duration: float) -> list[tuple[float, float]]:
    """'314-391,802-' -> [(314, 391), (802, duration)]; empty or 'none' -> []."""
    if not s or s.strip().lower() in ("none", "-"):
        return []
    out = []
    for part in s.split(","):
        a, _, b = part.strip().partition("-")
        out.append((seconds(a), seconds(b) if b.strip() else duration))
    return out


def merge_ranges(rs: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for a, b in sorted(rs):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def overlay(parts: list[np.ndarray], ranges: list[tuple[int, int]], fill: float) -> np.ndarray:
    """Arrays measured part by part (each indexed from the video's start) -> one array; `fill` elsewhere."""
    out = np.full((max(min(len(a), r[1]) for a, r in zip(parts, ranges)), *parts[0].shape[1:]), fill, np.float32)
    for a, (f, l) in zip(parts, ranges):
        l = min(l, len(a), len(out))
        out[f:l] = a[f:l]
    return out


def kept(t, excluded: list[tuple[float, float]]):
    t = np.asarray(t, dtype=float)
    ok = np.ones(t.shape, bool)
    for a, b in excluded:
        ok &= ~((t >= a) & (t < b))
    return ok


def probe(p: Path) -> dict:
    o = json.loads(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
                                   "-of", "json", str(p)], check=True, capture_output=True, text=True).stdout)
    v = next((s for s in o["streams"] if s["codec_type"] == "video"), None)
    if not v:
        raise ValueError(f"No picture in {p.name}")
    n, d = v["avg_frame_rate"].split("/")
    return {"duration": float(o["format"]["duration"]), "codec": v["codec_name"], "width": v["width"], "height": v["height"],
            "fps": float(n) / float(d) if float(d) else 25.0, "audio": any(s["codec_type"] == "audio" for s in o["streams"])}


@functools.lru_cache
def true_colors(p: Path) -> str:
    """Scale options with faithful colours: the file's matrix tag; untagged, BT.709 from 720 lines up, BT.601 below.
    Out: BT.601 full range, as JPEGs expect."""
    v = json.loads(subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,color_space",
                                   "-of", "json", str(p)], check=True, capture_output=True, text=True).stdout)["streams"][0]
    untagged, hd = v.get("color_space", "unknown") == "unknown", min(v["width"], v["height"]) >= 720
    return f"in_color_matrix={'bt709' if untagged and hd else 'auto'}:out_color_matrix=bt601:out_range=pc"


def size(info: dict, long: int) -> tuple[int, int]:
    """Even size in the video's shape, long side = long."""
    w, h = info["width"], info["height"]
    k = long / max(w, h)
    return max(2, round(w * k / 2) * 2), max(2, round(h * k / 2) * 2)


# ---------------------------------------------------------------- picture: cuts, zooms, slow changes

def frames(p: Path, fps: float, w: int, h: int, first: int = 0, last: int | None = None, select: list[int] | None = None):
    """RGB frames at a fixed rate: frame i is at time i / fps. From `first` to `last` (excluded);
    `select` = only these numbers, in order (60 at most: see pick)."""
    seek = (["-ss", f"{first / fps:.6f}"] if first else []) + (["-t", f"{(last - first) / fps:.6f}"] if last is not None else [])
    vf = f"fps={fps}" + (f",select='{'+'.join(f'eq(n,{i - first})' for i in select)}'" if select is not None else "") + f",scale={w}:{h}:flags=area:{true_colors(p)}"
    proc = subprocess.Popen([FFMPEG, "-v", "error", *seek, "-i", str(p), "-map", "0:v:0", "-vf", vf,
                             "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=w * h * 3 * 8)
    n, got = w * h * 3, 0
    try:
        while len(b := proc.stdout.read(n)) == n:
            got += 1
            yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace")
        proc.wait()
    if not got and (select is None or select):
        raise ValueError(f"Could not read the pictures of {p.name}: {err.strip()[-400:]}")


def pick(p: Path, fps: float, w: int, h: int, idxs: list[int]):
    """(number, frame) for each number asked, in batches of close moments (one ffmpeg read per batch)."""
    idxs = sorted(set(idxs))
    chunks: list[list[int]] = []
    for i in idxs:  # 60 numbers at most: ffmpeg's select expression fails past about 1,000 characters
        if chunks and len(chunks[-1]) < 60 and i - chunks[-1][-1] < 10 * fps and i - chunks[-1][0] < 9000:
            chunks[-1].append(i)
        else:
            chunks.append([i])
    for c in chunks:
        yield from zip(c, frames(p, fps, w, h, c[0], c[-1] + 1, c))


def gray(img: np.ndarray) -> np.ndarray:
    return img.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)


def hist(img: np.ndarray) -> np.ndarray:
    q = (img >> 6).astype(np.int32)  # 4 levels per colour -> 64 bins
    h = np.bincount((q[..., 0] * 16 + q[..., 1] * 4 + q[..., 2]).ravel(), minlength=64).astype(np.float32)
    return h / h.sum()


def bhatt(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.sqrt(np.clip(1 - np.sum(np.sqrt(a * b), axis=-1), 0, 1))


BANDS = 8  # horizontal bands of the frame: the one where captions change (caption_timing)
FRAME_KEYS = ("diff", "color", "slow", "bands", "luma", "back")


def measure_frames(p: Path, fps: float, w: int, h: int, first: int = 0, last: int | None = None) -> dict:
    """Pass 1: frame-to-frame difference (hard cuts) and colour difference 6 frames apart (slow changes); difference per
    horizontal band (captions), brightness (flashes) and distance to the closest frame 2 to 5 frames back (a flash that
    returns to the same shot). Arrays start at frame 0 of the video (zero before `first`)."""
    diff, col, hists, prev = [0.0] * first, [0.0] * first, [np.full(64, 1 / 64, np.float32)] * first, None
    bands, luma = [np.zeros(BANDS, np.float32)] * first, [0.0] * first
    for img in frames(p, fps, w, h, first, last):
        g, hs = gray(img), hist(img)
        diff.append(0.0 if prev is None else float(np.mean(np.abs(g - prev[0]))))
        col.append(0.0 if prev is None else float(bhatt(hs, prev[1])))
        bands.append(np.zeros(BANDS, np.float32) if prev is None
                     else np.array([b.mean() for b in np.array_split(np.abs(g - prev[0]), BANDS, axis=0)], np.float32))
        luma.append(float(g.mean()))
        hists.append(hs)
        prev = (g, hs)
    return frame_arrays(diff, col, hists, bands, luma)


def frame_arrays(diff, col, hists, bands, luma) -> dict:
    hs = np.array(hists)
    slow = np.zeros(len(hs), np.float32)
    if len(hs) > 6:
        slow[6:] = bhatt(hs[6:], hs[:-6])
    back = np.ones(len(hs), np.float32)
    for k in range(2, 6):
        if len(hs) > k:
            back[k:] = np.minimum(back[k:], bhatt(hs[k:], hs[:-k]))
    return {"diff": np.array(diff, np.float32), "color": np.array(col, np.float32), "slow": slow,
            "bands": np.array(bands, np.float32), "luma": np.array(luma, np.float32), "back": back}


def find_cuts(m: dict, fps: float) -> list[int]:
    """First frame of each shot: a frame-difference peak well above its neighbourhood (paired-diff median), or a
    colour-histogram jump."""
    d, c = m["diff"], m["color"]
    # An animation "on twos" (each frame held twice) puts a zero difference every other frame: the neighbourhood is measured
    # on the larger difference of each pair, else the median fell to zero and every moving frame passed for a cut.
    held = np.maximum(d, np.concatenate([d[:1], d[:-1]]))
    base = median_filter(held, size=max(3, int(fps)) | 1, mode="nearest")
    cand = np.nonzero(((d > np.maximum(12, 4 * base)) | (c > 0.45)) & (d > 6))[0]
    cuts: list[int] = []
    for i in cand:  # two peaks under 3 frames apart = one cut (the stronger)
        if cuts and i - cuts[-1] < 3:
            if d[i] > d[cuts[-1]]:
                cuts[-1] = int(i)
        else:
            cuts.append(int(i))
    return cuts


def split_flashes(cuts: list[int], m: dict) -> tuple[list[int], list[int]]:
    """A flash (up to 4 very bright frames) or a dip to black makes two difference peaks: it does not count as two cuts. If it
    comes back to the same shot (the frame after looks like the one before), it is no cut; else, one. Returns (cuts, flashes)."""
    luma, back = m.get("luma"), m.get("back")
    if luma is None or back is None:
        return cuts, []
    out, flashes, i = [], [], 0
    while i < len(cuts):
        a = cuts[i]
        b = cuts[i + 1] if i + 1 < len(cuts) else None
        if b is not None and b - a <= 4 and (luma[a:b].min() > 225 or luma[a:b].max() < 20):
            flashes.append(a)
            if back[b] > 0.25:  # the frame after is not the one before: the flash hides a real cut
                out.append(b)
            i += 2
            continue
        out.append(a)
        i += 1
    return out, flashes


def caption_timing(m: dict, cuts: list[int], words: list[dict], fps: float) -> dict | None:
    """A reference's captions, read off the picture: the band where the picture changes most often right at a word's start,
    how far (negative = early) those changes lead or lag the voice, and the words said between two changes. None without
    visible captions."""
    bands = m.get("bands")
    if bands is None or bands.ndim != 2 or len(words) < 10:
        return None
    starts = np.array(sorted(w["start"] for w in words))
    near_cut = {j for c in cuts for j in range(c - 2, c + 3)}
    best = None
    for k in range(bands.shape[1]):
        x = bands[:, k]
        base = median_filter(x, size=max(3, int(fps)) | 1, mode="nearest")
        # A caption appears at once and only in its band: a sharp peak (well above the frames around) and local (well above
        # the other bands). A talking mouth also moves at word starts, but steadily and over several bands.
        others = np.median(np.delete(bands, k, axis=1), axis=1)
        ev = [i for i in range(2, len(x) - 2) if x[i] > max(4.0, 3 * base[i]) and x[i] > 2.5 * max(x[i - 2], x[i + 2])
              and x[i] > 3 * others[i] and x[i] >= x[i - 1] and x[i] >= x[i + 1] and i not in near_cut]
        if len(ev) < 8:
            continue
        t = np.array(ev) / fps
        gap = t[:, None] - starts[None, :]
        nearest = gap[np.arange(len(t)), np.abs(gap).argmin(1)]
        hits = np.abs(nearest) <= 0.3
        if best is None or hits.mean() > best[0]:
            best = (float(hits.mean()), k, t, nearest[hits])
    if best is None or best[0] < 0.5:  # changes unrelated to the voice: not captions
        return None
    score, k, t, off = best
    per_change = np.diff(np.searchsorted(starts, t))
    return {"band": k, "bands": BANDS, "changes": int(len(t)), "on_words_share": r2(score), "lead_s": r2(float(np.median(off))),
            "words_per_change": r1(float(np.median(per_change))) if len(per_change) else None}


def shot_motion(d: np.ndarray, a: int, b: int) -> str:
    """A shot's motion (frames a to b): 'still' a held image (photo, screenshot, held card), 'moving' otherwise.
    A photo that slides or zooms passes for 'moving'."""
    x = d[a + 1:b]
    return "still" if len(x) >= 3 and float(np.median(x)) < 0.4 else "moving"


def look(imgs: list[np.ndarray]) -> dict:
    """The picture's look (median over the overview frames): brightness, contrast (5-95% luminance spread), saturation,
    warmth (red minus blue), share of black-and-white frames. All 0-1 (warmth -1 to 1)."""
    if not imgs:
        return {}
    rows = []
    for img in imgs:
        f = img.astype(np.float32) / 255
        y = f @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        mx, mn = f.max(-1), f.min(-1)
        sat = np.where(mx > 0.04, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
        rows.append((y.mean(), np.percentile(y, 95) - np.percentile(y, 5), sat.mean(), f[..., 0].mean() - f[..., 2].mean()))
    a = np.array(rows)
    return {"brightness": r2(float(np.median(a[:, 0]))), "contrast": r2(float(np.median(a[:, 1]))), "saturation": r2(float(np.median(a[:, 2]))),
            "warmth": r2(float(np.median(a[:, 3]))), "bw_share": r2(float(np.mean(a[:, 2] < 0.06))), "frames": len(rows)}


def find_progressive(m: dict, cuts: list[int], fps: float) -> list[int]:
    """Colour changes spread over several frames with no hard cut: fade, slide, push in... or a camera move."""
    s, out = m["slow"], []
    near = np.zeros(len(s), bool)
    for c in cuts:
        near[max(0, c - 8):c + 9] = True
    for i in np.nonzero((s > 0.35) & ~near)[0]:
        if s[i] < s[max(0, i - 3):i + 4].max():
            continue
        if not out or i - out[-1] > fps:
            out.append(int(i))
    return out


def best_match(big: np.ndarray, small: np.ndarray) -> tuple[float, int, int]:
    """Highest normalised correlation of `small` placed inside `big` (and where)."""
    h, w = small.shape
    t = small - small.mean()
    tn = np.sqrt(np.sum(t * t))
    if tn < 1e-3:
        return 0.0, 0, 0
    num = fftconvolve(big, t[::-1, ::-1], mode="valid")
    ones = np.ones((h, w))
    s1, s2 = fftconvolve(big, ones, mode="valid"), fftconvolve(big * big, ones, mode="valid")
    var = s2 - s1 * s1 / (h * w)
    # An almost flat area (black, white background) proves nothing: its correlation counts as zero.
    ncc = np.where(var > h * w * 4.0, num / (np.sqrt(np.maximum(var, 1e-6)) * tn), 0.0)
    y, x = np.unravel_index(int(np.argmax(ncc)), ncc.shape)
    return float(ncc[y, x]), int(y), int(x)


# 4% steps: coarse, refined to the percent after. Past 1.8 a small frame "matches" dark shots by chance: stronger zooms
# are rare and count as another shot.
SCALES = list(np.geomspace(1.05, 1.8, 15))


def shrink(img: np.ndarray, s: float) -> np.ndarray:
    """The frame shrunk by exactly s (scipy's zoom rounds the ratio to the output size)."""
    h, w = img.shape
    ys, xs = (np.arange(int(h / s)) + 0.5) * s - 0.5, (np.arange(int(w / s)) + 0.5) * s - 0.5
    return map_coordinates(img, np.meshgrid(ys, xs, indexing="ij"), order=1, mode="nearest")


def zoom_score(big: np.ndarray, small: np.ndarray, s: float) -> float:
    return best_match(big, shrink(small, s))[0]


def sharpness(g: np.ndarray) -> float:
    """Sharpness (fine detail), not counting grain."""
    return float(np.var(laplace(gaussian_filter(g, 1)))) + 1e-6


def classify(a: np.ndarray, b: np.ndarray) -> dict:
    """The change from frame a (end of a shot) to b (start of the next), in greys:
    'zoom-in' (b = a enlarged, with the ratio), 'zoom-out', 'blur' (same frame going soft or sharp: a blur effect),
    'same' (same framing: a jump cut, or overlays changing on the same shot) or 'cut' (another shot)."""
    sharp = sharpness(b) / sharpness(a)
    # Light blur: the match tolerates half a pixel and what moves between the two frames (mouth, hands).
    a, b = gaussian_filter(a, 2), gaussian_filter(b, 2)
    h, w = a.shape
    my, mx = h // 10, w // 10
    same, dy, dx = best_match(a, b[my:h - my, mx:w - mx])
    best = {"kind": "same", "scale": 1.0, "score": same, "shift": [dx - mx, dy - my]}
    if same < 0.95:
        # Coarse ratios, then refined around the best two.
        coarse = sorted(((zoom_score(big, small, s), s, kind) for s in SCALES
                         for kind, big, small in (("zoom-in", a, b), ("zoom-out", b, a))), reverse=True)[:2]
        for _, s0, kind in coarse:
            big, small = (a, b) if kind == "zoom-in" else (b, a)
            for s in np.linspace(s0 * 0.97, s0 * 1.03, 7):
                score = zoom_score(big, small, s)
                if score > best["score"] + 0.02:  # a zoom must do clearly better than "same framing"
                    best = {"kind": kind, "scale": round(float(s), 2), "score": score}
    if best["kind"].startswith("zoom") and best["scale"] < 1.06:
        best["kind"] = "same"  # under 6%: invisible as a zoom, it is the same framing
    # Thresholds set on real intros: a title staying on screen over a camera change makes the two frames alike (~0.75);
    # a true same framing passes 0.85, a true zoom 0.8.
    if best["score"] < (0.8 if best["kind"].startswith("zoom") else 0.85):
        best["kind"] = "cut"
    elif best["kind"] == "same" and not 0.4 < sharp < 2.5:
        best["kind"] = "blur"
    best["score"] = round(float(best["score"]), 3)
    return best


# ---------------------------------------------------------------- contact sheets

FONT = {  # 3 x 5: enough to read "12:03.4 Z+1.25"
    "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
    "5": "111100111001111", "6": "111100111101111", "7": "111001001001001", "8": "111101111101111", "9": "111101111001111",
    ":": "000010000010000", ".": "000000000000010", "+": "000010111010000", "-": "000000111000000", " ": "000000000000000",
    "Z": "111001010100111", "B": "110101110101110", "J": "001001001101111", "x": "000101010101000", "/": "001001010100100",
}


def label(img: np.ndarray, text: str, k: int = 3) -> None:
    """White text on black, top left of the frame."""
    text = "".join(ch for ch in text if ch in FONT)
    h, w = 5 * k + 2 * k, (4 * len(text) + 1) * k
    img[:min(h, img.shape[0]), :min(w, img.shape[1])] = 0
    for n, ch in enumerate(text):
        g = np.array([int(v) for v in FONT[ch]], bool).reshape(5, 3)
        block = np.kron(g, np.ones((k, k), bool))
        y, x = k, k + n * 4 * k
        if x + 3 * k <= img.shape[1]:
            img[y:y + 5 * k, x:x + 3 * k][block] = 255


def mmss(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:04.1f}" if t >= 3600 else f"{int(t // 60)}:{t % 60:04.1f}"


def write_jpg(img: np.ndarray, out: Path) -> None:
    h, w = img.shape[:2]
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-",
                    "-q:v", "3", "-pix_fmt", "yuvj420p", str(out)], input=np.ascontiguousarray(img).tobytes(), check=True)


def resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    k = (h / img.shape[0], w / img.shape[1], 1)
    out = rescale(img, k, order=1)
    return out[:h, :w].astype(np.uint8)


class Sheet:
    """A sheet of tiles; each tile has its time (and a note) written on it."""

    def __init__(self, path: Path, cols: int, rows: int, tw: int, th: int, kind: str):
        self.path, self.cols, self.tw, self.th, self.kind = path, cols, tw, th, kind
        self.canvas = np.full((rows * th, cols * tw, 3), 40, np.uint8)
        self.tiles: list[dict] = []

    def put(self, slot: int, img: np.ndarray, t: float, note: str = "") -> None:
        y, x = divmod(slot, self.cols)
        tile = img if img.shape[:2] == (self.th, self.tw) else resize(img, self.tw, self.th)
        tile = tile.copy()
        label(tile, f"{mmss(t)} {note}".strip())
        self.canvas[y * self.th:(y + 1) * self.th, x * self.tw:(x + 1) * self.tw] = tile
        self.tiles.append({"slot": slot, "t": round(t, 2), **({"note": note} if note else {})})


# ---------------------------------------------------------------- sound

HOP = 0.05


def window_args(win: tuple[float, float]) -> list[str]:
    return ["-ss", f"{win[0]:.3f}", "-t", f"{win[1] - win[0]:.3f}"]


def loudness(p: Path, wins: list[tuple[float, float]]) -> dict:
    """Integrated loudness (LUFS) and true peak; several parts: energy mean weighted by length, highest peak."""
    parts = [(b - a, loudness_one(p, (a, b))) for a, b in wins]
    lufs = [(d, x["lufs"]) for d, x in parts if x["lufs"] is not None]
    peaks = [x["true_peak_db"] for _, x in parts if x["true_peak_db"] is not None]
    return {"lufs": r1(10 * np.log10(sum(d * 10 ** (l / 10) for d, l in lufs) / sum(d for d, _ in lufs))) if lufs else None,
            "true_peak_db": max(peaks) if peaks else None}


def loudness_one(p: Path, win: tuple[float, float]) -> dict:
    r = subprocess.run([FFMPEG, "-nostats", *window_args(win), "-i", str(p), "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    tail = r.stderr[r.stderr.rfind("Summary:"):]
    i = re.search(r"I:\s*(-?[\d.]+) LUFS", tail)
    pk = re.search(r"Peak:\s*(-?[\d.]+|-inf) dBFS", tail)
    return {"lufs": float(i.group(1)) if i else None, "true_peak_db": float(pk.group(1)) if pk and pk.group(1) != "-inf" else None}


def audio_frames(p: Path, win: tuple[float, float], hop: float = HOP, sr: int = 16000):
    """Per 50 ms slice from the video's start: level (dBFS) and spectral flatness (0 = tonal, music; 1 = noise).
    Outside the window `win`: silence."""
    n = int(sr * hop)
    proc = subprocess.Popen([FFMPEG, "-v", "error", *window_args(win), "-i", str(p), "-map", "0:a:0", "-ac", "1", "-ar", str(sr),
                             "-f", "f32le", "-"], stdout=subprocess.PIPE)
    pad = int(round(win[0] / hop))
    lv, fl = [np.full(pad, -120.0)], [np.ones(pad)]
    hann = np.hanning(n).astype(np.float32)
    while len(b := proc.stdout.read(n * 4 * 200)) >= n * 4:
        x = np.frombuffer(b[:len(b) // (n * 4) * n * 4], np.float32).reshape(-1, n)
        lv.append(10 * np.log10(np.mean(x * x, axis=1) + 1e-12))
        spec = np.abs(np.fft.rfft(x * hann, axis=1))[:, 4:] + 1e-9
        fl.append(np.exp(np.mean(np.log(spec), axis=1)) / np.mean(spec, axis=1))
    proc.wait()
    return np.concatenate(lv), np.concatenate(fl)


def voice_level(lv: np.ndarray, words: list[dict], excluded) -> float | None:
    voice = np.zeros(len(lv), bool)
    for w in words:
        voice[int(w["start"] / HOP):int(w["end"] / HOP) + 1] = True
    voice &= kept(np.arange(len(lv)) * HOP, excluded)
    return float(np.median(lv[voice])) if voice.any() else None


def measure_sound(p: Path | None, words: list[dict], lv: np.ndarray, fl: np.ndarray, excluded, wins: list[tuple[float, float]]) -> dict:
    hop = HOP
    t = np.arange(len(lv)) * hop
    voice = np.zeros(len(lv), bool)
    for w in words:
        voice[int(max(0, w["start"] - 0.1) / hop):int((w["end"] + 0.1) / hop) + 1] = True
    ok = kept(t, excluded)
    # Gaps in the voice of 0.4 s or more: what plays there is the bed (music, room tone or silence).
    gap = ~voice & ok
    runs = np.diff(np.concatenate([[0], gap.astype(np.int8), [0]]))
    starts, ends = np.nonzero(runs == 1)[0], np.nonzero(runs == -1)[0]
    pause = np.zeros(len(lv), bool)
    for a, b in zip(starts, ends):
        if (b - a) * hop >= 0.4:
            pause[a + 2:b - 2] = True  # without the edges, where a word's tail lingers
    vmask = voice & ok
    voice_db = float(np.median(lv[vmask])) if vmask.any() else None
    out: dict = {"voice_db": r1(voice_db), **(loudness(p, wins) if p is not None else {})}
    if pause.any() and voice_db is not None:
        bed = lv[pause]
        tonal = (fl[pause] < 0.25) & (bed > voice_db - 45)
        out |= {
            "bed_under_voice_db": r1(float(np.median(bed)) - voice_db),  # bed during pauses, against the voice
            "pauses_with_tonal_bed": r2(float(np.mean(tonal))),  # share of pauses with something tonal (music)
            "pauses_near_silent": r2(float(np.mean(bed < voice_db - 50))),
        }
    # One-off sounds outside the voice: well above the bed of the 2.5 s around.
    if len(lv) and voice_db is not None:
        base = median_filter(lv, size=int(2.5 / hop) | 1, mode="nearest")
        hit = (lv > base + 8) & (lv > voice_db - 30) & ~voice & ok
        ev = np.nonzero(np.diff(np.concatenate([[0], hit.astype(np.int8)])) == 1)[0]
        minutes = max(1e-6, float(ok.sum()) * hop / 60)
        out |= {"sound_events_per_min": r1(len(ev) / minutes), "sound_events": [r2(i * hop) for i in ev[:400]]}
    return out


# ---------------------------------------------------------------- speech

def quiet_between(a: dict, b: dict, quiet: np.ndarray) -> float:
    """Silence between two words, measured on the sound (word times often touch): the longest run of slices well under the
    voice, between the middle of one and the middle of the other."""
    i, j = int((a["start"] + a["end"]) / 2 / HOP), int((b["start"] + b["end"]) / 2 / HOP) + 1
    q = quiet[i:j]
    if not q.any():
        return 0.0
    runs = np.diff(np.concatenate([[0], q.astype(np.int8), [0]]))
    return float(np.max(np.nonzero(runs == -1)[0] - np.nonzero(runs == 1)[0])) * HOP


def measure_speech(words: list[dict], duration: float, excluded, quiet: np.ndarray | None = None) -> dict:
    """`quiet`: 50 ms slices well under the voice's level; without it, pauses are read from the word times."""
    ws = [w for w in words if kept(w["start"], excluded)]
    minutes = max(1e-6, (duration - sum(b - a for a, b in excluded)) / 60)
    if not ws:
        return {"words": 0}
    end_gaps, mid_gaps, silent, talk = [], [], [], 0.0
    for a, b in zip(ws, ws[1:]):
        g = b["start"] - a["end"] if quiet is None else quiet_between(a, b, quiet)
        if g < 0 or not kept(a["end"], excluded) or not kept(b["start"], excluded):
            continue
        if g >= 3:  # over 3 s without speech: a stretch with no voice (music, card, animation), not a pause
            silent.append(g)
            continue
        (end_gaps if re.search(r"[.!?…]$", a["text"]) else mid_gaps).append(g)
        talk += (b["start"] - a["start"]) if g < 0.7 else (a["end"] - a["start"])
    fillers = sum(re.sub(r"[^\w]", "", w["text"].lower()) in FILLERS for w in ws)
    q = lambda xs, p: r2(float(np.percentile(xs, p))) if xs else None
    allg = end_gaps + mid_gaps
    real_mid = [g for g in mid_gaps if g > 0.05]
    return {
        "words": len(ws), "words_per_min": r1(len(ws) / minutes), "words_per_min_while_talking": r1(len(ws) / max(talk, 1e-6) * 60),
        "pause_after_sentence_s": {"median": q(end_gaps, 50), "p75": q(end_gaps, 75), "p90": q(end_gaps, 90)},
        "pause_inside_sentence_s": {"median": q(real_mid, 50), "p90": q(real_mid, 90)},  # real pauses only
        "pauses_over_1s_per_min": r1(sum(g > 1.0 for g in allg) / minutes),
        "longest_pause_s": r2(max(allg)) if allg else None,
        "stretches_without_speech": {"count": len(silent), "seconds": r1(sum(silent))},
        "hesitations_per_min": r1(fillers / minutes),
    }


def sentences(words: list[dict]) -> list[tuple[float, float]]:
    out, start = [], None
    for w in words:
        start = w["start"] if start is None else start
        if re.search(r"[.!?…]$", w["text"]):
            out.append((start, w["end"]))
            start = None
    return out


# ---------------------------------------------------------------- one video

def r1(x):
    return None if x is None else round(float(x), 1)


def r2(x):
    return None if x is None else round(float(x), 2)


def analyse_one(p: Path, out: Path, words: list[dict], exclude: str | None = None, only: str | None = None,
                log=lambda s: None) -> tuple[dict, list[float]]:
    """Report for one video, and the times of its real cuts (another shot or a zoom) for the caller's beat check."""
    info = probe(p)
    out.mkdir(parents=True, exist_ok=True)
    dur = info["duration"]
    # only: just these parts (the intro, an animated stretch...); the rest is not read.
    wins = merge_ranges([(max(0.0, a), min(dur, b)) for a, b in (parse_ranges(only, dur) or [(0.0, dur)]) if min(dur, b) > a])
    if not wins:
        raise ValueError(f"only: no part inside the video ({mmss(dur)}): {only}")
    gaps = [(a, b) for a, b in zip([0.0] + [w[1] for w in wins], [w[0] for w in wins] + [dur]) if b > a]
    excluded = parse_ranges(exclude, dur) + gaps
    fps = min(info["fps"], 30.0)
    fwins = [(int(round(a * fps)), int(round(b * fps))) for a, b in wins]
    first = fwins[0][0]
    words = [w for w in words if isinstance(w, dict) and "start" in w and "end" in w and "text" in w]
    log(f"{p.name}: {mmss(dur)}, {info['width']}x{info['height']}, {info['fps']:.2f} fps")

    log("finding cuts")
    parts = [measure_frames(p, fps, *size(info, SMALL), f, l) for f, l in fwins]
    m = {k: overlay([pt[k] for pt in parts], fwins, 1.0 if k == "back" else 0.0) for k in FRAME_KEYS}
    n = len(m["diff"])
    cuts, flashes = split_flashes([c for c in find_cuts(m, fps) if kept(c / fps, excluded)], m)
    progressive = [i for i in find_progressive(m, cuts, fps) if kept(i / fps, excluded)]

    # Pass 2: the sheets' frames, and the ones around each cut to tell zooms apart.
    log("making contact sheets")
    sheets_dir = out / "sheets"
    sheets_dir.mkdir(exist_ok=True)
    for f in sheets_dir.glob("*.jpg"):
        f.unlink()
    want: dict[int, list[tuple[Sheet, int]]] = {}
    sheets: list[Sheet] = []

    def plan(kind: str, idxs: list[int], cols: int, rows: int, long: int):
        tw, th = size(info, long)
        per = cols * rows
        for s0 in range(0, len(idxs), per):
            sh = Sheet(sheets_dir / f"{kind}-{sum(x.kind == kind for x in sheets) + 1:02d}.jpg", cols, rows, tw, th, kind)
            sheets.append(sh)
            for slot, i in enumerate(idxs[s0:s0 + per]):
                want.setdefault(i, []).append((sh, slot))

    keep = lambda idxs: [i for i in idxs if 0 <= i < n and kept(i / fps, excluded)]
    plan("hook", keep(list(range(first, first + int(30 * fps), max(1, round(fps / 2)))))[:60], 10, 6, 256)  # 30 s at 2 frames/s
    plan("overview", keep(list(range(first, n, max(1, round(5 * fps))))), 10, 6, 192)
    # One frame per sentence, 1.5 s (a short part: each caption shows) to 8 s (a whole video) apart.
    spacing = min(8.0, max(1.5, sum(b - a for a, b in wins) / 300))
    mids, prev_t = [], -1e9
    for a, b in sentences([x for x in words if kept(x["start"], excluded)]):
        t = (a + b) / 2
        if t - prev_t >= spacing:
            mids.append(int(t * fps))
            prev_t = t
    plan("text", keep(mids), 3, 3, 640)
    cut_sheets_from = len(sheets)
    plan("cuts", [j for c in cuts for j in (c - 1, c)], 6, 6, 320)  # slots held: filled by the chosen pair
    plan("progressive", keep([i + k for i in progressive for k in range(-8, 9, 2)]), 9, 4, 240)

    # Around each cut: 4 frames; the most different pair is the cut (batch reads may shift by one frame).
    around = {j: c for c in cuts for j in range(c - 2, c + 2) if j >= 0}
    near: dict[int, dict[int, np.ndarray]] = {}
    kinds: dict[int, dict] = {}
    slots = {c: k for k, c in enumerate(cuts)}
    big = size(info, 640)

    def finish_cut(c: int):
        imgs = near.pop(c)
        js = sorted(imgs)
        if len(js) < 2:
            return
        gs = {j: gray(resize(imgs[j], *size(info, SMALL))) for j in js}
        a, b = max(zip(js, js[1:]), key=lambda ab: float(np.mean(np.abs(gs[ab[1]] - gs[ab[0]]))))
        kinds[c] = k = classify(gs[a], gs[b])
        note = {"zoom-in": f"Z+x{k['scale']:.2f}", "zoom-out": f"Z-x{k['scale']:.2f}", "same": "J", "blur": "B"}.get(k["kind"], "")
        per = 18
        sh = sheets[cut_sheets_from + slots[c] // per]
        sh.put(2 * (slots[c] % per), imgs[a], a / fps)
        sh.put(2 * (slots[c] % per) + 1, imgs[b], b / fps, note)

    overview: list[np.ndarray] = []  # these frames also give the picture's look
    for i, img in pick(p, fps, *big, sorted(set(want) | set(around))):
        for sh, slot in want.get(i, []):
            if sh.kind != "cuts":
                sh.put(slot, img, i / fps)
            if sh.kind == "overview":
                overview.append(img)
        if i in around:
            c = around[i]
            near.setdefault(c, {})[i] = img
            if i == c + 1:
                finish_cut(c)
    for c in list(near):
        finish_cut(c)
    for sh in sheets:
        write_jpg(sh.canvas, sh.path)

    log("measuring sound")
    sound, quiet = {}, None
    if info["audio"]:
        aparts = [audio_frames(p, w, HOP) for w in wins]
        hw = [(int(round(a / HOP)), int(round(b / HOP))) for a, b in wins]
        lv, fl = overlay([x[0] for x in aparts], hw, -120.0), overlay([x[1] for x in aparts], hw, 1.0)
        sound = measure_sound(p, words, lv, fl, excluded, wins)
        vdb = voice_level(lv, words, excluded)
        # A pause: at least 18 dB under the voice. With music louder than that under the voice, the sound no longer shows
        # pauses: they are read from the transcript.
        if vdb is not None and (sound.get("bed_under_voice_db") or -99) < -18:
            quiet = lv < vdb - 18

    # Shots: cut to cut (another shot or a zoom), without those touching an excluded range.
    # A blur or overlay on the same framing does not end a shot.
    real = [c for c in cuts if kinds.get(c, {"kind": "cut"})["kind"] in ("cut", "zoom-in", "zoom-out")]
    bounds = sorted(set(real) | {x for w in fwins for x in w})
    inside = lambda a, b: any(f <= a and b <= l for f, l in fwins)
    spans = [(a, b) for a, b in zip(bounds, bounds[1:]) if inside(a, b) and kept(a / fps, excluded) and kept((b - 1) / fps, excluded)]
    shots = [(b - a) / fps for a, b in spans]
    motion = [shot_motion(m["diff"], a, b) for a, b in spans]
    minutes = max(1e-6, (dur - sum(b - a for a, b in excluded)) / 60)
    cut_list = [{"t": r2(c / fps), **kinds.get(c, {"kind": "cut"})} for c in cuts]
    count = lambda k: sum(c["kind"] == k for c in cut_list)
    zooms = [c["scale"] for c in cut_list if c["kind"] in ("zoom-in", "zoom-out")]
    q = lambda xs, p_: r1(float(np.percentile(xs, p_))) if xs else None
    real_times = [r2(c / fps) for c in real if kept(c / fps, excluded)]
    report = {
        "video": p.name, "duration_s": r1(dur), "size": f"{info['width']}x{info['height']}", "fps": r2(info["fps"]),
        "only": [[r1(a), r1(b)] for a, b in wins] if gaps else None, "excluded": parse_ranges(exclude, dur), "minutes_analysed": r1(minutes),
        "speech": {**measure_speech(words, dur, excluded, quiet), "pauses_from": "sound" if quiet is not None else "transcript"},
        "shots": {
            "cuts_per_min": r1(len(real) / minutes), "shot_s": {"median": q(shots, 50), "p25": q(shots, 25), "p75": q(shots, 75), "max": r1(max(shots)) if shots else None},
            "first_cut_s": r2(real_times[0] - wins[0][0]) if real_times else None,
            "camera_changes_per_min": r1(count("cut") / minutes), "zoom_in_per_min": r1(count("zoom-in") / minutes),
            "zoom_out_per_min": r1(count("zoom-out") / minutes), "same_framing_per_min": r1(count("same") / minutes),
            "blur_per_min": r1(count("blur") / minutes),
            "zoom_scale_median": r2(float(np.median(zooms))) if zooms else None,
            "progressive_changes_per_min": r1(len(progressive) / minutes),
            "flashes_per_min": r1(len(flashes) / minutes),
            "still_shots_per_min": r1(motion.count("still") / minutes),
        },
        "captions_on_image": caption_timing(m, cuts, [x for x in words if kept(x["start"], excluded)], fps),
        "look": look(overview),
        "sound": {k: v for k, v in sound.items() if k != "sound_events"},
    }
    (out / "cuts.json").write_text(json.dumps({"fps": fps, "cuts": cut_list, "progressive": [r2(i / fps) for i in progressive],
                                              "flashes": [r2(i / fps) for i in flashes],
                                              "shots": [{"from": r2(a / fps), "to": r2(b / fps), "motion": mo} for (a, b), mo in zip(spans, motion)]}, indent=1))
    (out / "sound_events.json").write_text(json.dumps(sound.get("sound_events", [])))
    (out / "sheets.json").write_text(json.dumps([{"file": f"sheets/{s.path.name}", "kind": s.kind, "tiles": sorted(s.tiles, key=lambda x: x["slot"])}
                                                 for s in sheets], indent=1))
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    return report, real_times


def handle(req: dict) -> dict:
    global FFMPEG, FFPROBE
    FFMPEG, FFPROBE = req.get("ffmpeg") or FFMPEG, req.get("ffprobe") or FFPROBE
    report, cut_times = analyse_one(Path(req["video"]), Path(req["out"]), req.get("words") or [], req.get("exclude"), req.get("only"),
                                    log=lambda s: print(s, file=sys.stderr, flush=True))
    return {"report": report, "cut_times": cut_times}


def main() -> int:
    req = json.loads(sys.stdin.read() or "{}")
    try:
        res = handle(req)
    except Exception as exc:  # structured error, not a traceback on stdout
        sys.stdout.write(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    sys.stdout.write(json.dumps(res))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
