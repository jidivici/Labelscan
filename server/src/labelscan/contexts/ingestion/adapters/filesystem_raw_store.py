"""Filesystem RawStore adapter (dev / test).

Content-addressed and crash-durable: bytes are written to a temp file, fsync'd,
atomically renamed into place, and the directory is fsync'd — so once put()
returns, the bytes survive a crash. Identical content re-put is a no-op.

In production this port is implemented by an S3/object-store adapter; the
durability contract (fsync-before-return, content-addressed, idempotent) is the
same. The domain/application layers never see this class (ports only).
"""

from __future__ import annotations

import os
from pathlib import Path


class FilesystemRawStore:
    def __init__(self, base_dir: str) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)

    def _path_for(self, checksum: str) -> Path:
        # shard by first 2 hex chars to avoid huge flat directories
        return self._base / checksum[:2] / checksum

    def put(self, content: bytes, *, checksum: str) -> str:
        path = self._path_for(checksum)
        ref = f"{checksum[:2]}/{checksum}"
        if path.exists():
            return ref  # content-addressed: already durable, idempotent no-op
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp." + os.urandom(6).hex())
        with open(tmp, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())  # bytes hit disk
        os.replace(tmp, path)  # atomic publish
        dir_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)  # the rename itself is durable
        finally:
            os.close(dir_fd)
        return ref

    def exists(self, *, checksum: str) -> bool:
        return self._path_for(checksum).exists()

    def read(self, *, checksum: str) -> bytes:
        return self._path_for(checksum).read_bytes()
