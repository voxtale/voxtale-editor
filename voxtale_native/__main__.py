"""JSON stdin/stdout dispatcher the TS editor calls.

``python -m voxtale_native faces`` reads {images_b64: [...]} on stdin and
writes {faces: [...]} (largest face per still, or null) on stdout.
``python -m voxtale_native analyse`` measures a reference video's editing style
(see analyse.py).
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


OPS = {"faces": _faces, "analyse": _analyse}


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
