"""Private S3-compatible immutable object storage."""

from __future__ import annotations

import hashlib
import os


class S3RawStore:
    def __init__(
        self,
        *,
        bucket: str,
        endpoint_url: str | None = None,
        region_name: str | None = None,
        encryption: str = "AES256",
        client=None,
    ) -> None:
        if not bucket.strip():
            raise RuntimeError("LABELSCAN_S3_BUCKET is required")
        if client is None:
            import boto3

            client = boto3.client(
                "s3",
                endpoint_url=endpoint_url or None,
                region_name=region_name or None,
            )
        self._client = client
        self._bucket = bucket
        self._encryption = encryption

    @staticmethod
    def _key(checksum: str, organization_id: str | None) -> str:
        tenant = organization_id or "legacy"
        return f"organizations/{tenant}/sha256/{checksum[:2]}/{checksum}"

    def put(
        self,
        content: bytes,
        *,
        checksum: str,
        organization_id: str | None = None,
    ) -> str:
        if hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError("content checksum does not match the supplied SHA-256")
        key = self._key(checksum, organization_id)
        if self.exists(checksum=checksum, organization_id=organization_id):
            return key
        request = {
            "Bucket": self._bucket,
            "Key": key,
            "Body": content,
            "Metadata": {
                "sha256": checksum,
                "organization-id": organization_id or "legacy",
            },
            "ServerSideEncryption": self._encryption,
        }
        kms_key = os.environ.get("LABELSCAN_S3_KMS_KEY_ID")
        if self._encryption == "aws:kms" and kms_key:
            request["SSEKMSKeyId"] = kms_key
        self._client.put_object(**request)
        return key

    def exists(
        self, *, checksum: str, organization_id: str | None = None
    ) -> bool:
        try:
            self._client.head_object(
                Bucket=self._bucket,
                Key=self._key(checksum, organization_id),
            )
            return True
        except self._client.exceptions.ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise

    def read(
        self, *, checksum: str, organization_id: str | None = None
    ) -> bytes:
        response = self._client.get_object(
            Bucket=self._bucket,
            Key=self._key(checksum, organization_id),
        )
        content = response["Body"].read()
        if hashlib.sha256(content).hexdigest() != checksum:
            raise OSError("object SHA-256 verification failed")
        return content

    def healthcheck(self) -> bool:
        self._client.head_bucket(Bucket=self._bucket)
        return True
