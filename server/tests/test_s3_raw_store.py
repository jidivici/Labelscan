"""Private, tenant-keyed and checksum-verified S3 raw-store proofs."""

from __future__ import annotations

import hashlib
import io

import pytest

from labelscan.contexts.ingestion.adapters.s3_raw_store import S3RawStore


class _ClientError(Exception):
    def __init__(self, code: str) -> None:
        self.response = {"Error": {"Code": code}}


class _Exceptions:
    ClientError = _ClientError


class _FakeS3:
    exceptions = _Exceptions()

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], dict] = {}
        self.last_put: dict | None = None

    def head_object(self, *, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise _ClientError("404")
        return {}

    def put_object(self, **request):
        self.last_put = request
        self.objects[(request["Bucket"], request["Key"])] = {
            **request,
            "Body": bytes(request["Body"]),
        }

    def get_object(self, *, Bucket, Key):
        stored = self.objects.get((Bucket, Key))
        if stored is None:
            raise _ClientError("NoSuchKey")
        return {"Body": io.BytesIO(stored["Body"])}


def test_s3_store_uses_private_tenant_sha_key_and_encryption():
    client = _FakeS3()
    store = S3RawStore(bucket="private-labels", client=client)
    content = b"tenant-scoped-photo"
    checksum = hashlib.sha256(content).hexdigest()

    key = store.put(
        content,
        checksum=checksum,
        organization_id="org-a",
    )

    assert key == f"organizations/org-a/sha256/{checksum[:2]}/{checksum}"
    assert client.last_put["ServerSideEncryption"] == "AES256"
    assert client.last_put["Metadata"] == {
        "sha256": checksum,
        "organization-id": "org-a",
    }
    assert store.read(checksum=checksum, organization_id="org-a") == content
    assert not store.exists(checksum=checksum, organization_id="org-b")


def test_s3_store_rejects_bad_input_and_corrupted_download():
    client = _FakeS3()
    store = S3RawStore(bucket="private-labels", client=client)
    content = b"photo"
    checksum = hashlib.sha256(content).hexdigest()
    with pytest.raises(ValueError):
        store.put(b"different", checksum=checksum, organization_id="org-a")

    key = store.put(content, checksum=checksum, organization_id="org-a")
    client.objects[("private-labels", key)]["Body"] = b"corrupted"
    with pytest.raises(OSError):
        store.read(checksum=checksum, organization_id="org-a")
