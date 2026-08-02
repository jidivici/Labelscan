"""Runtime storage selection shared by API and workers."""

from __future__ import annotations

import os

from labelscan.platform.storage.filesystem_raw_store import (
    FilesystemRawStore,
)


def build_raw_store():
    adapter = (os.environ.get("LABELSCAN_OBJECT_STORE") or "filesystem").lower()
    if adapter == "filesystem":
        raw_dir = os.environ.get("LABELSCAN_RAW_STORE_DIR")
        if not raw_dir:
            raise RuntimeError("LABELSCAN_RAW_STORE_DIR is required")
        return FilesystemRawStore(raw_dir)
    if adapter == "s3":
        from labelscan.platform.storage.s3_raw_store import S3RawStore

        return S3RawStore(
            bucket=os.environ.get("LABELSCAN_S3_BUCKET", ""),
            endpoint_url=os.environ.get("LABELSCAN_S3_ENDPOINT_URL"),
            region_name=os.environ.get("LABELSCAN_S3_REGION"),
            encryption=os.environ.get("LABELSCAN_S3_ENCRYPTION", "AES256"),
        )
    raise RuntimeError("LABELSCAN_OBJECT_STORE must be 'filesystem' or 's3'")


def build_raw_image_reader():
    from labelscan.platform.raw_images import ObjectStoreRawImageReader

    return ObjectStoreRawImageReader(build_raw_store())
