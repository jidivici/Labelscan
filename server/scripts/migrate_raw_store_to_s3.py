"""Copy existing immutable artifacts to S3 and verify every SHA-256.

Dry-run is the default. Pass ``--apply`` only after the target bucket has private
access, encryption and versioning configured.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path

from sqlalchemy import text

from labelscan.contexts.ingestion.adapters.s3_raw_store import S3RawStore
from labelscan.platform.db.engine import make_engine


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    source = Path(os.environ["LABELSCAN_RAW_STORE_DIR"])
    target = S3RawStore(
        bucket=os.environ["LABELSCAN_S3_BUCKET"],
        endpoint_url=os.environ.get("LABELSCAN_S3_ENDPOINT_URL"),
        region_name=os.environ.get("LABELSCAN_S3_REGION"),
        encryption=os.environ.get("LABELSCAN_S3_ENCRYPTION", "AES256"),
    )
    copied = 0
    with make_engine().connect() as conn:
        rows = conn.execute(
            text(
                "SELECT DISTINCT organization_id::text AS organization_id, "
                "checksum_sha256 FROM ingestion.raw_artifact ORDER BY organization_id"
            )
        ).mappings()
        for row in rows:
            checksum = row["checksum_sha256"]
            content = (source / checksum[:2] / checksum).read_bytes()
            actual = hashlib.sha256(content).hexdigest()
            if actual != checksum:
                raise RuntimeError(f"source checksum mismatch: {checksum}")
            if not args.apply:
                copied += 1
                continue
            target.put(
                content,
                checksum=checksum,
                organization_id=row["organization_id"],
            )
            verified = target.read(
                checksum=checksum,
                organization_id=row["organization_id"],
            )
            if hashlib.sha256(verified).hexdigest() != checksum:
                raise RuntimeError(f"target checksum mismatch: {checksum}")
            copied += 1
    mode = "verified locally" if not args.apply else "copied and verified"
    print(f"{copied} artifacts {mode}")


if __name__ == "__main__":
    main()
