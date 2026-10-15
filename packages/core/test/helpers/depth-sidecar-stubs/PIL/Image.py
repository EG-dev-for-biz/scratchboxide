# Test stand-in for PIL.Image (see ../README.md): decodes the PNGs the tests write (8-bit RGB/RGBA, filter 0).
import builtins
import struct
import zlib
import numpy as np


class _Image:
    def __init__(self, array):
        self._a = np.asarray(array)

    @property
    def size(self):
        return (self._a.shape[1], self._a.shape[0])

    def convert(self, mode):
        if mode != "RGB":
            raise ValueError(f"stub PIL only converts to RGB, not {mode}")
        return _Image(self._a[..., :3].copy())

    def __array__(self, dtype=None, copy=None):
        return self._a if dtype is None else self._a.astype(dtype)

    def save(self, path):
        with builtins.open(path, "wb") as f:
            np.save(f, self._a)


def open(path):
    with builtins.open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"stub PIL reads PNG only: {path}")
    pos, idat, width = 8, b"", None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", body[:10])
            if depth != 8 or color not in (2, 6):
                raise ValueError("stub PIL reads 8-bit RGB/RGBA PNG only")
            channels = 4 if color == 6 else 3
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * channels
    rows = []
    for y in range(height):
        start = y * (stride + 1)
        if raw[start] != 0:
            raise ValueError("stub PIL reads unfiltered PNG rows only")
        rows.append(np.frombuffer(raw[start + 1:start + 1 + stride], dtype=np.uint8).reshape(width, channels))
    return _Image(np.stack(rows))


def fromarray(array):
    return _Image(array)
