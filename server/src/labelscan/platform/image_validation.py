"""Dependency-free validation of uploaded JPEG, PNG, and WebP headers."""

from __future__ import annotations

_MAX_PIXELS = 25_000_000
_MAX_SIDE = 10_000


class InvalidImage(ValueError):
    pass


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    if (
        len(data) < 4
        or not data.startswith(b"\xff\xd8\xff")
        or not data.endswith(b"\xff\xd9")
    ):
        raise InvalidImage("invalid JPEG signature")
    pos = 2
    sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while pos + 4 <= len(data):
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        if pos >= len(data):
            break
        marker = data[pos]
        pos += 1
        if marker in {0xD8, 0xD9}:
            continue
        if marker == 0xDA:
            break
        if pos + 2 > len(data):
            break
        length = int.from_bytes(data[pos : pos + 2], "big")
        if length < 2 or pos + length > len(data):
            raise InvalidImage("truncated JPEG segment")
        if marker in sof:
            if length < 7:
                raise InvalidImage("invalid JPEG dimensions")
            height = int.from_bytes(data[pos + 3 : pos + 5], "big")
            width = int.from_bytes(data[pos + 5 : pos + 7], "big")
            return width, height
        pos += length
    raise InvalidImage("JPEG dimensions not found")


def _png_dimensions(data: bytes) -> tuple[int, int]:
    if (
        len(data) < 36
        or data[:8] != b"\x89PNG\r\n\x1a\n"
        or data[12:16] != b"IHDR"
        or not data.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")
    ):
        raise InvalidImage("invalid PNG header")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _webp_dimensions(data: bytes) -> tuple[int, int]:
    if (
        len(data) < 30
        or data[:4] != b"RIFF"
        or data[8:12] != b"WEBP"
        or int.from_bytes(data[4:8], "little") + 8 != len(data)
    ):
        raise InvalidImage("invalid WebP header")
    kind = data[12:16]
    if kind == b"VP8X":
        return (
            1 + int.from_bytes(data[24:27], "little"),
            1 + int.from_bytes(data[27:30], "little"),
        )
    if kind == b"VP8L" and data[20] == 0x2F:
        bits = int.from_bytes(data[21:25], "little")
        return 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
    if kind == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
        return (
            int.from_bytes(data[26:28], "little") & 0x3FFF,
            int.from_bytes(data[28:30], "little") & 0x3FFF,
        )
    raise InvalidImage("unsupported or truncated WebP header")


def validate_image(data: bytes, declared_media_type: str) -> tuple[int, int]:
    readers = {
        "image/jpeg": _jpeg_dimensions,
        "image/png": _png_dimensions,
        "image/webp": _webp_dimensions,
    }
    reader = readers.get(declared_media_type)
    if reader is None:
        raise InvalidImage("unsupported image media type")
    width, height = reader(data)
    if width <= 0 or height <= 0:
        raise InvalidImage("image dimensions must be positive")
    if width > _MAX_SIDE or height > _MAX_SIDE or width * height > _MAX_PIXELS:
        raise InvalidImage("image dimensions exceed the configured limit")
    return width, height
