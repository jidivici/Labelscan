"""Tier 4 proofs — long-poll on GET /v1/ingestions/{id}.

Validation requirements:
  - wait is ALWAYS bounded (clamp to 25 s; negatives degrade to 0, never error);
  - the hold returns IMMEDIATELY when the status already differs from last_status;
  - the hold returns on the FIRST status change (well before the cap);
  - an expired hold returns the current (unchanged) state — never an error;
  - a missing ingestion 404s promptly even with a wait armed;
  - the plain GET (no params) is untouched.
"""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.http.read_router import clamp_wait
from labelscan.contexts.ingestion.adapters.http.router import get_submit_ingestion
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestion,
    SubmitIngestionCommand,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.rate_limit import rate_limits
from tests.conftest import ACTOR_ID, bearer

AUTH = bearer("ingestion:read", principal="device-01")


@pytest.fixture
def client(engine, raw_store):
    app = create_app()
    app.dependency_overrides[get_submit_ingestion] = lambda: SubmitIngestion(
        raw_store, SqlIngestionRepository(engine)
    )
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


@pytest.fixture
def validation_client():
    app = create_app()
    app.dependency_overrides[get_engine] = lambda: object()
    return TestClient(app)


def _cmd(content: bytes) -> SubmitIngestionCommand:
    return SubmitIngestionCommand(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-lp",
        trace_id="trace-lp",
        principal="device-01",
    )


def _set_status_after(engine, ingestion_id: str, status: str, delay_s: float):
    """Background transition: sleep, then commit a status update (with the audit
    context the AFTER UPDATE trigger requires) on the thread's own connection."""

    def run():
        time.sleep(delay_s)
        with engine.begin() as c:
            set_audit_context(
                c,
                actor_id=ACTOR_ID,
                action="test.long_poll_transition",
                correlation_id="corr-lp",
                trace_id="trace-lp",
            )
            c.execute(
                text("UPDATE ingestion.ingestion SET status = :st WHERE id = :id"),
                {"st": status, "id": ingestion_id},
            )

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


# ----- pure bound ---------------------------------------------------------------


def test_clamp_wait_bounds():
    assert clamp_wait(-3) == 0.0
    assert clamp_wait(0) == 0.0
    assert clamp_wait(10) == 10.0
    assert clamp_wait(9999) == 25.0  # a client can never pin a thread unbounded


# ----- endpoint behaviour ---------------------------------------------------------


def test_returns_immediately_when_status_already_differs(submit, client):
    res = submit(_cmd(b"lp-immediate-1"))  # status = raw_stored
    t0 = time.monotonic()
    r = client.get(
        f"/v1/ingestions/{res.ingestion_id}",
        params={"wait": 10, "last_status": "ocr_done"},
        headers=AUTH,
    )
    elapsed = time.monotonic() - t0
    assert r.status_code == 200
    assert r.json()["status"] == "raw_stored"
    assert elapsed < 1.0  # no hold: the baseline already differs


def test_hold_returns_on_first_status_change(submit, engine, client):
    res = submit(_cmd(b"lp-change-1"))  # status = raw_stored
    t = _set_status_after(engine, res.ingestion_id, "ocr_done", delay_s=0.6)
    t0 = time.monotonic()
    r = client.get(
        f"/v1/ingestions/{res.ingestion_id}",
        params={"wait": 10, "last_status": "raw_stored"},
        headers=AUTH,
    )
    elapsed = time.monotonic() - t0
    t.join(timeout=5)
    assert r.status_code == 200
    assert r.json()["status"] == "ocr_done"
    # held past the transition (~0.6 s) but returned WELL before the 10 s cap
    assert 0.4 <= elapsed < 5.0


def test_expired_hold_returns_current_state_unchanged(submit, client):
    res = submit(_cmd(b"lp-timeout-1"))  # status = raw_stored, never changes
    t0 = time.monotonic()
    r = client.get(
        f"/v1/ingestions/{res.ingestion_id}",
        params={"wait": 1, "last_status": "raw_stored"},
        headers=AUTH,
    )
    elapsed = time.monotonic() - t0
    assert r.status_code == 200
    assert r.json()["status"] == "raw_stored"  # timeout = normal response, no error
    assert elapsed >= 0.9


def test_missing_ingestion_404s_promptly_even_with_wait(client):
    t0 = time.monotonic()
    r = client.get(
        "/v1/ingestions/00000000-0000-0000-0000-00000000dead",
        params={"wait": 10, "last_status": "raw_stored"},
        headers=AUTH,
    )
    elapsed = time.monotonic() - t0
    assert r.status_code == 404
    assert elapsed < 1.0  # a missing row never holds the request


def test_concurrency_limit_returns_rate_limited_with_retry_after(client, monkeypatch):
    monkeypatch.setenv("LABELSCAN_LONG_POLL_PER_ACTOR", "1")
    rate_limits.acquire_hold(ACTOR_ID)
    try:
        response = client.get(
            "/v1/ingestions/00000000-0000-0000-0000-00000000dead",
            params={"wait": 10, "last_status": "raw_stored"},
            headers=AUTH,
        )
    finally:
        rate_limits.release_hold(ACTOR_ID)

    assert response.status_code == 429
    assert response.json()["error_code"] == "RATE_LIMITED"
    assert response.headers["Retry-After"] == "1"


def test_plain_get_without_params_is_untouched(submit, client):
    res = submit(_cmd(b"lp-plain-1"))
    t0 = time.monotonic()
    r = client.get(f"/v1/ingestions/{res.ingestion_id}", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["status"] == "raw_stored"
    assert time.monotonic() - t0 < 1.0


@pytest.mark.parametrize(
    "params",
    [
        {"wait": "-1", "last_status": "raw_stored"},
        {"wait": "26", "last_status": "raw_stored"},
        {"wait": "NaN", "last_status": "raw_stored"},
        {"wait": "1e1", "last_status": "raw_stored"},
        {"wait": "1", "last_status": "unknown"},
        {"wait": "1", "last_status": "raw_stored\u202e"},
        {"wait": "1", "last_status": "raw_stored\x01"},
    ],
)
def test_long_poll_rejects_noncanonical_or_unsafe_query_values(
    validation_client, params
):
    response = validation_client.get(
        "/v1/ingestions/00000000-0000-0000-0000-00000000dead",
        params=params,
        headers=AUTH,
    )

    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_long_poll_rejects_duplicate_scalar_parameters(validation_client):
    response = validation_client.get(
        "/v1/ingestions/00000000-0000-0000-0000-00000000dead",
        params=[("wait", "1"), ("wait", "2"), ("last_status", "raw_stored")],
        headers=AUTH,
    )

    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"
