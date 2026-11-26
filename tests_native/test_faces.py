import cv2
import numpy

from voxtale_native.faces import largest_face

def _jpeg(image) -> bytes:
    ok, buf = cv2.imencode(".jpg", image)
    assert ok
    return buf.tobytes()


def test_blank_frame_has_no_face():
    assert largest_face(_jpeg(numpy.full((360, 640, 3), 128, numpy.uint8))) is None


def test_garbage_bytes_have_no_face():
    assert largest_face(b"not a jpeg") is None

