"""Unit proofs for the untrusted image byte boundary."""

from __future__ import annotations

import io
import zlib

import pytest
from PIL import Image

from labelscan.platform.image_validation import (
    InvalidImage,
    sanitize_image,
    validate_image,
)
from tests.conftest import jpeg_bytes, jpeg_bytes_of_size


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return (
        len(payload).to_bytes(4, "big")
        + kind
        + payload
        + crc.to_bytes(4, "big")
    )


def png_bytes() -> bytes:
    ihdr = (
        (1).to_bytes(4, "big")
        + (1).to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00"
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00"))
        + _png_chunk(b"IEND", b"")
    )


def _webp_chunk(kind: bytes, payload: bytes) -> bytes:
    padding = b"\x00" if len(payload) & 1 else b""
    return kind + len(payload).to_bytes(4, "little") + payload + padding


def webp_bytes() -> bytes:
    vp8x = b"\x00\x00\x00\x00" + b"\x00\x00\x00" + b"\x00\x00\x00"
    vp8 = b"\x00\x00\x00\x9d\x01\x2a\x01\x00\x01\x00"
    chunks = _webp_chunk(b"VP8X", vp8x) + _webp_chunk(b"VP8 ", vp8)
    return b"RIFF" + (len(chunks) + 4).to_bytes(4, "little") + b"WEBP" + chunks


@pytest.mark.parametrize(
    ("content", "media_type"),
    [
        (jpeg_bytes(b"scan-data"), "image/jpeg"),
        (png_bytes(), "image/png"),
        (webp_bytes(), "image/webp"),
    ],
)
def test_valid_images_have_matching_start_and_end_boundaries(content, media_type):
    assert validate_image(content, media_type) == (1, 1)


@pytest.mark.parametrize(
    ("content", "media_type"),
    [
        (jpeg_bytes() + b"payload\xff\xd9", "image/jpeg"),
        (png_bytes() + _png_chunk(b"IEND", b""), "image/png"),
        (webp_bytes() + b"payload", "image/webp"),
        (jpeg_bytes()[:-1], "image/jpeg"),
        (png_bytes()[:-1], "image/png"),
        (webp_bytes()[:-1], "image/webp"),
    ],
)
def test_truncated_or_appended_payloads_are_rejected(content, media_type):
    with pytest.raises(InvalidImage):
        validate_image(content, media_type)


def test_declared_media_type_must_match_file_signature():
    with pytest.raises(InvalidImage, match="PNG start signature"):
        validate_image(jpeg_bytes(), "image/png")


def test_concatenated_jpeg_is_rejected_as_a_polyglot():
    content = jpeg_bytes(b"primary") + jpeg_bytes(b"auxiliary")
    with pytest.raises(InvalidImage, match="after JPEG end marker"):
        validate_image(content, "image/jpeg")


def test_png_chunk_checksum_is_verified():
    content = bytearray(png_bytes())
    content[-1] ^= 0x01
    with pytest.raises(InvalidImage, match="checksum"):
        validate_image(bytes(content), "image/png")


def test_jpeg_fixture_with_payload_is_fully_decodable():
    content = jpeg_bytes(b"opaque-fixture-payload\xff\x00")

    with Image.open(io.BytesIO(content)) as decoded:
        decoded.load()
        assert decoded.format == "JPEG"
        assert decoded.size == (1, 1)


@pytest.mark.parametrize("size", [10 * 1024 * 1024, 10 * 1024 * 1024 + 1])
def test_jpeg_fixture_can_land_on_exact_payload_boundaries(size):
    content = jpeg_bytes_of_size(size)

    assert len(content) == size
    assert validate_image(content, "image/jpeg") == (1, 1)


def test_sanitizer_strips_metadata_and_returns_decodable_pixels():
    source = io.BytesIO()
    exif = Image.Exif()
    exif[0x010E] = "private description"
    exif[0x0112] = 1
    Image.new("RGB", (2, 1), (10, 80, 160)).save(
        source,
        format="JPEG",
        quality=90,
        exif=exif,
        icc_profile=b"private-icc-profile",
        comment=b"private-comment",
    )
    original = source.getvalue()

    with Image.open(io.BytesIO(original)) as decoded_original:
        assert decoded_original.getexif()[0x010E] == "private description"
        assert decoded_original.info["icc_profile"] == b"private-icc-profile"

    sanitized = sanitize_image(original, "image/jpeg")

    assert sanitized.media_type == "image/jpeg"
    assert (sanitized.width, sanitized.height) == (2, 1)
    assert b"private description" not in sanitized.content
    assert b"private-icc-profile" not in sanitized.content
    with Image.open(io.BytesIO(sanitized.content)) as decoded:
        decoded.load()
        assert decoded.format == "JPEG"
        assert decoded.size == (2, 1)
        assert not decoded.getexif()
        assert "exif" not in decoded.info
        assert "icc_profile" not in decoded.info
        assert "comment" not in decoded.info
