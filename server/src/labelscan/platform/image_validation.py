"""Strict, dependency-free validation of uploaded JPEG, PNG, and WebP files.

The declared media type is never trusted on its own. Each reader checks the
format's opening signature, walks the complete container, and proves that the
format's real end marker (or declared RIFF length) is the end of the upload.
This rejects truncated images and polyglot payloads appended after an image.
"""

from __future__ import annotations

import io
import threading
import warnings
import zlib
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

_MAX_PIXELS = 25_000_000
_MAX_SIDE = 10_000
_PIL_DECODE_LOCK = threading.Lock()
_JPEG_SOF_MARKERS = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_IEND = b"IEND"
_PNG_KNOWN_CRITICAL_CHUNKS = frozenset({b"IHDR", b"PLTE", b"IDAT", _PNG_IEND})


class InvalidImage(ValueError):
    pass


@dataclass(frozen=True)
class SanitizedImage:
    content: bytes
    media_type: str
    width: int
    height: int


def _jpeg_frame_dimensions(data: bytes, start: int) -> tuple[tuple[int, int], int]:
    if len(data) - start < 4 or data[start : start + 2] != b"\xff\xd8":
        raise InvalidImage("invalid JPEG start signature")

    pos = start + 2
    dimensions: tuple[int, int] | None = None
    in_scan = False
    saw_scan = False

    while pos < len(data):
        if in_scan:
            marker_start = data.find(b"\xff", pos)
            if marker_start < 0:
                raise InvalidImage("JPEG end marker not found")
            pos = marker_start + 1
            while pos < len(data) and data[pos] == 0xFF:
                pos += 1
            if pos >= len(data):
                raise InvalidImage("truncated JPEG marker")
            marker = data[pos]
            pos += 1
            if marker == 0x00 or 0xD0 <= marker <= 0xD7:
                # Escaped 0xff entropy byte or a restart marker.
                continue
            in_scan = False
        else:
            if data[pos] != 0xFF:
                raise InvalidImage("invalid JPEG marker sequence")
            while pos < len(data) and data[pos] == 0xFF:
                pos += 1
            if pos >= len(data):
                raise InvalidImage("truncated JPEG marker")
            marker = data[pos]
            pos += 1

        if marker == 0xD9:
            if dimensions is None:
                raise InvalidImage("JPEG dimensions not found")
            if not saw_scan:
                raise InvalidImage("JPEG image data not found")
            return dimensions, pos
        if marker == 0xD8:
            raise InvalidImage("unexpected JPEG start marker")
        if marker == 0x01:
            continue
        if 0xD0 <= marker <= 0xD7:
            raise InvalidImage("JPEG restart marker outside image data")
        if pos + 2 > len(data):
            raise InvalidImage("truncated JPEG segment")

        length = int.from_bytes(data[pos : pos + 2], "big")
        if length < 2 or pos + length > len(data):
            raise InvalidImage("truncated JPEG segment")
        segment_end = pos + length

        if marker in _JPEG_SOF_MARKERS:
            if length < 8:
                raise InvalidImage("invalid JPEG dimensions")
            height = int.from_bytes(data[pos + 3 : pos + 5], "big")
            width = int.from_bytes(data[pos + 5 : pos + 7], "big")
            dimensions = (width, height)
        if marker == 0xDA:
            if length < 6:
                raise InvalidImage("invalid JPEG scan header")
            saw_scan = True
            in_scan = True
        pos = segment_end

    raise InvalidImage("JPEG end marker not found")


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    dimensions, end = _jpeg_frame_dimensions(data, 0)
    if end != len(data):
        # A second SOI is not a benign multi-picture upload: downstream image
        # decoders consume only the first frame, so accepting it would validate
        # different bytes from those actually used by OCR/display. Treat every
        # byte after the first EOI as a polyglot boundary violation.
        raise InvalidImage("data found after JPEG end marker")
    return dimensions


def _png_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 8 or data[:8] != _PNG_SIGNATURE:
        raise InvalidImage("invalid PNG start signature")

    pos = 8
    dimensions: tuple[int, int] | None = None
    saw_idat = False
    chunk_index = 0

    while pos < len(data):
        if pos + 12 > len(data):
            raise InvalidImage("truncated PNG chunk")
        length = int.from_bytes(data[pos : pos + 4], "big")
        chunk_type = data[pos + 4 : pos + 8]
        chunk_end = pos + 12 + length
        if chunk_end > len(data):
            raise InvalidImage("truncated PNG chunk")
        if len(chunk_type) != 4 or not all(
            65 <= byte <= 90 or 97 <= byte <= 122 for byte in chunk_type
        ):
            raise InvalidImage("invalid PNG chunk type")

        payload = data[pos + 8 : pos + 8 + length]
        expected_crc = int.from_bytes(data[pos + 8 + length : chunk_end], "big")
        actual_crc = zlib.crc32(chunk_type + payload) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise InvalidImage("invalid PNG chunk checksum")

        if chunk_index == 0:
            if chunk_type != b"IHDR" or length != 13:
                raise InvalidImage("invalid PNG header")
            dimensions = (
                int.from_bytes(payload[0:4], "big"),
                int.from_bytes(payload[4:8], "big"),
            )
        elif chunk_type == b"IHDR":
            raise InvalidImage("duplicate PNG header")

        if chunk_type == b"IDAT":
            saw_idat = True
        if chunk_type[0] & 0x20 == 0 and chunk_type not in _PNG_KNOWN_CRITICAL_CHUNKS:
            raise InvalidImage("unsupported critical PNG chunk")
        if chunk_type == _PNG_IEND:
            if length != 0 or not saw_idat:
                raise InvalidImage("invalid PNG end marker")
            if chunk_end != len(data):
                raise InvalidImage("data found after PNG end marker")
            if dimensions is None:
                raise InvalidImage("PNG dimensions not found")
            return dimensions

        pos = chunk_end
        chunk_index += 1

    raise InvalidImage("PNG end marker not found")


def _webp_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 20 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise InvalidImage("invalid WebP start signature")
    if int.from_bytes(data[4:8], "little") + 8 != len(data):
        raise InvalidImage("invalid WebP end boundary")

    pos = 12
    dimensions: tuple[int, int] | None = None
    chunk_index = 0
    needs_bitstream = False
    saw_bitstream = False
    while pos < len(data):
        if pos + 8 > len(data):
            raise InvalidImage("truncated WebP chunk")
        kind = data[pos : pos + 4]
        length = int.from_bytes(data[pos + 4 : pos + 8], "little")
        payload_start = pos + 8
        payload_end = payload_start + length
        padded_end = payload_end + (length & 1)
        if padded_end > len(data):
            raise InvalidImage("truncated WebP chunk")
        payload = data[payload_start:payload_end]
        if length & 1 and data[payload_end] != 0:
            raise InvalidImage("invalid WebP chunk padding")

        if chunk_index == 0:
            if kind == b"VP8X" and length >= 10:
                dimensions = (
                    1 + int.from_bytes(payload[4:7], "little"),
                    1 + int.from_bytes(payload[7:10], "little"),
                )
                needs_bitstream = True
            elif kind == b"VP8L" and length >= 5 and payload[0] == 0x2F:
                bits = int.from_bytes(payload[1:5], "little")
                dimensions = (1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF))
                saw_bitstream = True
            elif kind == b"VP8 " and length >= 10 and payload[3:6] == b"\x9d\x01\x2a":
                dimensions = (
                    int.from_bytes(payload[6:8], "little") & 0x3FFF,
                    int.from_bytes(payload[8:10], "little") & 0x3FFF,
                )
                saw_bitstream = True
            else:
                raise InvalidImage("unsupported or truncated WebP header")
        elif kind == b"VP8 ":
            if saw_bitstream or length < 10 or payload[3:6] != b"\x9d\x01\x2a":
                raise InvalidImage("invalid WebP image data")
            saw_bitstream = True
        elif kind == b"VP8L":
            if saw_bitstream or length < 5 or payload[0] != 0x2F:
                raise InvalidImage("invalid WebP image data")
            saw_bitstream = True
        pos = padded_end
        chunk_index += 1

    if (
        pos != len(data)
        or dimensions is None
        or (needs_bitstream and not saw_bitstream)
    ):
        raise InvalidImage("invalid WebP end boundary")
    return dimensions


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


def sanitize_image(data: bytes, declared_media_type: str) -> SanitizedImage:
    """Fully decode and deterministically re-encode one still image.

    Container validation runs first. Pillow then proves the compressed pixel data
    is decodable under the same pixel limit. Re-encoding to RGB JPEG strips EXIF,
    GPS, ICC profiles, comments and any non-pixel payload before OCR or display.
    """

    validate_image(data, declared_media_type)
    # Pillow's decompression threshold is process-global. Serialize the bounded
    # decode so concurrent requests cannot temporarily restore a looser value in
    # the middle of another image's verification.
    with _PIL_DECODE_LOCK:
        previous_limit = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = _MAX_PIXELS
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as probe:
                    if getattr(probe, "n_frames", 1) != 1:
                        raise InvalidImage("animated images are not accepted")
                    probe.verify()
                with Image.open(io.BytesIO(data)) as decoded:
                    if getattr(decoded, "n_frames", 1) != 1:
                        raise InvalidImage("animated images are not accepted")
                    decoded.load()
                    pixels = ImageOps.exif_transpose(decoded).convert("RGB")
                    # Pillow can carry source ``info`` (notably JPEG COM data)
                    # across conversion and silently write it back out. Keep
                    # only pixel data in the derivative.
                    pixels.info.clear()
                    width, height = pixels.size
                    if width <= 0 or height <= 0 or width * height > _MAX_PIXELS:
                        raise InvalidImage(
                            "decoded image dimensions exceed the configured limit"
                        )
                    output = io.BytesIO()
                    pixels.save(
                        output,
                        format="JPEG",
                        quality=90,
                        optimize=False,
                        progressive=False,
                        exif=b"",
                    )
        except (
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
            UnidentifiedImageError,
            OSError,
            SyntaxError,
        ) as exc:
            raise InvalidImage("image pixel data could not be decoded safely") from exc
        finally:
            Image.MAX_IMAGE_PIXELS = previous_limit
    return SanitizedImage(
        content=output.getvalue(),
        media_type="image/jpeg",
        width=width,
        height=height,
    )
