"""Proofs for safe content-addressed image reads."""

import pytest

from labelscan.platform.raw_images import (
    FilesystemRawImageReader,
    RawImageNotFound,
)


def test_filesystem_reader_detects_png_and_rejects_invalid_checksums(tmp_path) -> None:
    checksum = "a" * 64
    image_dir = tmp_path / checksum[:2]
    image_dir.mkdir()
    (image_dir / checksum).write_bytes(b"\x89PNG\r\n\x1a\nimage")

    image = FilesystemRawImageReader(str(tmp_path)).read(checksum)

    assert image.media_type == "image/png"
    assert image.content.startswith(b"\x89PNG")
    with pytest.raises(RawImageNotFound):
        FilesystemRawImageReader(str(tmp_path)).read("../outside")
