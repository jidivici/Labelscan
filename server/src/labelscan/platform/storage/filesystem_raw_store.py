"""Crash-durable content-addressed filesystem storage for development."""

from __future__ import annotations

import os
from pathlib import Path


class FilesystemRawStore:
    def __init__(self, base_dir: str) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _path_for(self, checksum: str) -> Path:
        return self._base / checksum[:2] / checksum

    def put(
        self,
        content: bytes,
        *,
        checksum: str,
        organization_id: str | None = None,
    ) -> str:
        path = self._path_for(checksum)
        ref = f"{checksum[:2]}/{checksum}"
        if path.exists():
            return ref
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp." + os.urandom(6).hex())
        with open(temporary, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return ref

    def exists(
        self, *, checksum: str, organization_id: str | None = None
    ) -> bool:
        return self._path_for(checksum).exists()

    def read(
        self, *, checksum: str, organization_id: str | None = None
    ) -> bytes:
        return self._path_for(checksum).read_bytes()

    def healthcheck(self) -> bool:
        return self._base.is_dir() and os.access(self._base, os.W_OK)
