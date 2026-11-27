"""JSON stdin/stdout dispatcher the TS editor calls.

``python -m voxtale_native faces`` reads {images_b64: [...]} on stdin and
writes {faces: [...]} (largest face per still, or null) on stdout.
``python -m voxtale_native analyse`` measures a reference video's editing style
(see analyse.py).
``subject`` reads {video, out, start, end, fps} and writes a subject mask
video to ``out`` (voxtale_native/subject.py); ``subject_still`` reads
{image, out} and writes one still's mask as a PNG.
``subject_path`` reads {video, start, end, rate?, people?} and writes the
speaker's place per sampled frame (auto reframe); ``track_point`` reads
{video, start, end, at, point, zone?} and writes a set point's path (title
motion tracking). See track.py.
``objects`` reads {video, out, start, end, fps, objects, subject} and writes the subject mask with picked objects
added or cut out (voxtale_native/objects.py); ``objects_still`` reads {image, out, objects, subject, overlay} and
writes one still's mask, plus an overlay the agent looks at to check its pick.
"""

from __future__ import annotations

import base64
import json
import sys


def _faces(req: dict) -> dict:
    from voxtale_native.faces import largest_face

    return {"faces": [largest_face(base64.b64decode(b)) for b in req["images_b64"]]}


def _analyse(req: dict) -> dict:
    from voxtale_native.analyse import handle

    return handle(req)


def _subject(req: dict) -> dict:
    from voxtale_native.subject import subject_mask_video

    return subject_mask_video(req["video"], req["out"], float(req["start"]), float(req["end"]), float(req["fps"]))


def _subject_still(req: dict) -> dict:
    from voxtale_native.subject import subject_mask_still

    return subject_mask_still(req["image"], req["out"])


def _subject_path(req: dict) -> dict:
    from voxtale_native.track import subject_path

    return subject_path(req["video"], float(req["start"]), float(req["end"]), float(req.get("rate", 5)), bool(req.get("people", True)))


def _track_point(req: dict) -> dict:
    from voxtale_native.track import track_point

    return track_point(req["video"], float(req["start"]), float(req["end"]), float(req["at"]), req["point"], req.get("zone"))


def _objects(req: dict) -> dict:
    from voxtale_native.objects import objects_mask_video

    return objects_mask_video(req["video"], req["out"], float(req["start"]), float(req["end"]), float(req["fps"]),
                              list(req.get("objects") or []), bool(req.get("subject", True)))


def _objects_still(req: dict) -> dict:
    from voxtale_native.objects import objects_still

    return objects_still(req["image"], req["out"], list(req.get("objects") or []), bool(req.get("subject", False)), req.get("overlay"))


OPS = {"faces": _faces, "analyse": _analyse, "subject": _subject, "subject_still": _subject_still,
       "subject_path": _subject_path, "track_point": _track_point, "objects": _objects, "objects_still": _objects_still}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in OPS:
        sys.stderr.write(f"usage: python -m voxtale_native <{'|'.join(OPS)}>\n")
        return 2
    request = json.loads(sys.stdin.read() or "{}")
    try:
        response = OPS[argv[0]](request)
    except Exception as exc:  # structured error, not a traceback on stdout
        sys.stdout.write(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    sys.stdout.write(json.dumps(response))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
