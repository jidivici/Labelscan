"""Read-only access to content-addressed label images."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class RawImageNotFound(Exception):
    """The persisted raw image cannot be read."""


@dataclass(frozen=True)
class RawImage:
    content: bytes
    media_type: str


def _media_type(content: bytes) -> str:
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    if content[4:12] in {b"ftypheic", b"ftypheix", b"ftyphevc", b"ftyphevx"}:
        return "image/heic"
    return "application/octet-stream"


class FilesystemRawImageReader:
    """Read the immutable image written by the filesystem raw store."""

    def __init__(self, base_dir: str) -> None:
        self._base = Path(base_dir)

    def read(
        self, checksum: str, organization_id: str | None = None
    ) -> RawImage:
        normalized = checksum.strip().lower()
        invalid_character = any(
            character not in "0123456789abcdef" for character in normalized
        )
        if len(normalized) != 64 or invalid_character:
            raise RawImageNotFound()
        path = self._base / normalized[:2] / normalized
        try:
            content = path.read_bytes()
        except OSError as exc:
            raise RawImageNotFound() from exc
        return RawImage(content=content, media_type=_media_type(content))


class ObjectStoreRawImageReader:
    """Adapts the shared raw-store interface to authorized HTTP image reads."""

    def __init__(self, raw_store) -> None:
        self._raw_store = raw_store

    def read(self, checksum: str, organization_id: str | None = None) -> RawImage:
        try:
            content = self._raw_store.read(
                checksum=checksum,
                organization_id=organization_id,
            )
        except Exception as exc:
            raise RawImageNotFound() from exc
        return RawImage(content=content, media_type=_media_type(content))
