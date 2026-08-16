"""Test fixtures. Assumes DATABASE_URL points at a PG-16 database already
migrated to head (the run script / CI does `alembic upgrade head` first).
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, text

ACTOR_ID = "11111111-1111-1111-1111-111111111111"


def jpeg_bytes(payload: bytes = b"") -> bytes:
    """Minimal 2×1 landscape JPEG structure accepted by the upload validator."""
    return (
        b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x01\x00\x02"
        b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
        + payload
        + b"\xff\xd9"
    )


@contextmanager
def capture_logger(caplog, name: str):
    """Capture a `labelscan.*` logger's records via caplog even after
    configure_logging() has set propagate=False on the `labelscan` root.

    configure_logging() (called by HTTP/worker entrypoint tests) routes labelscan
    logs to its own stdout handler and sets propagate=False, so records never reach
    the python-root handler caplog installs — `caplog.set_level(logger=...)` then
    captures nothing. Attaching caplog's handler directly to the emitting logger
    captures regardless of propagation, so log-assertions are order-independent.
    """
    lg = logging.getLogger(name)
    prev_level = lg.level
    lg.addHandler(caplog.handler)
    lg.setLevel(logging.INFO)
    try:
        yield
    finally:
        lg.removeHandler(caplog.handler)
        lg.setLevel(prev_level)

# Tests authenticate with real Bearer tokens (the header seam is OFF by default),
# so a signing secret must exist before any token is minted/verified.
os.environ.setdefault(
    "LABELSCAN_JWT_SECRET", "test-jwt-secret-not-for-prod-0123456789abcdef"
)


def bearer(
    scopes: str | list[str],
    *,
    actor_id: str = ACTOR_ID,
    principal: str = "device-01",
    role: str = "admin",
    store_code: str | None = None,
    organization_id: str | None = None,
    organization_slug: str = "labelscan",
    store_id: str | None = None,
) -> dict[str, str]:
    """Mint a valid JWT carrying the scopes and return an auth header.

    Mirrors what POST /v1/auth/login issues, so endpoints are exercised through the
    real JWT gate instead of the (now default-off) identity-header seam.
    """
    from labelscan.platform.http import jwt as jwt_codec

    scope_list = scopes.split() if isinstance(scopes, str) else list(scopes)
    token = jwt_codec.encode(
        {
            "sub": principal,
            "actor_id": actor_id,
            "principal": principal,
            "scopes": scope_list,
            "role": role,
            "store_code": store_code,
            "organization_id": organization_id,
            "organization_slug": organization_slug,
            "store_id": store_id,
        }
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def engine():
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set (needs a running PostgreSQL 16)")
    eng = create_engine(url, future=True)
    yield eng
    eng.dispose()


@pytest.fixture
def conn(engine):
    with engine.connect() as c:
        yield c


@pytest.fixture
def raw_store(tmp_path):
    from labelscan.contexts.ingestion.adapters.filesystem_raw_store import (
        FilesystemRawStore,
    )

    return FilesystemRawStore(str(tmp_path / "rawstore"))


@pytest.fixture
def repo(engine):
    from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
        SqlIngestionRepository,
    )

    return SqlIngestionRepository(engine)


@pytest.fixture
def submit(raw_store, repo):
    from labelscan.contexts.ingestion.application.submit_ingestion import (
        SubmitIngestion,
    )

    return SubmitIngestion(raw_store, repo)


def insert_raw_artifact(
    conn,
    *,
    ingestion_id: str | None = None,
    correlation_id: str = "corr-x",
    trace_id: str = "trace-x",
) -> str:
    """Insert one raw_artifact row and return its id.

    The row's own correlation_id/trace_id columns are passed as literals, so the
    ONLY thing that requires the transaction-local audit context is the
    audit_on_insert trigger. That keeps the "no context => rejected" proof
    attributable to the trigger, not to a column default.
    """
    params = {
        "ing": ingestion_id,
        "ref": "s3://raw/obj-key",
        "ck": "0" * 64,
        "corr": correlation_id,
        "trace": trace_id,
    }
    sql = text(
        "INSERT INTO ingestion.raw_artifact "
        "(ingestion_id, artifact_kind, storage_ref, checksum_sha256, "
        "correlation_id, trace_id) "
        "VALUES (COALESCE(:ing, gen_random_uuid()), 'image', :ref, :ck, :corr, :trace) "
        "RETURNING id"
    )
    return str(conn.execute(sql, params).scalar_one())
