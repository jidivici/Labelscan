"""Integration proofs — read endpoint limits and pagination edge cases.

Verifies bounded results on alerts list with proper key names.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.haccp.adapters.http.lifecycle_router import get_alert_service
from labelscan.contexts.haccp.adapters.sql_alert_repository import SqlAlertRepository
from labelscan.contexts.haccp.application.alert_service import AlertLifecycleService
from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import ACTOR_ID, bearer

AUTH_READ = bearer("haccp:read")


def _seed_alerts(engine, n: int) -> list[str]:
    ids = []
    with engine.begin() as c:
        for _ in range(n):
            set_audit_context(
                c,
                actor_id=ACTOR_ID,
                action="haccp.alert_raised",
                correlation_id="c",
                trace_id="t",
            )
            aid = c.execute(
                text(
                    "INSERT INTO haccp.alert "
                    "(alert_type, severity, state, detail, "
                    "correlation_id, trace_id) "
                    "VALUES ('temperature', 'high', 'open', "
                    "'{}'::jsonb, 'c', 't') RETURNING id"
                ),
            ).scalar_one()
            ids.append(str(aid))
    return ids


@pytest.fixture
def client(engine):
    app = create_app()
    app.dependency_overrides[get_alert_service] = lambda: AlertLifecycleService(
        SqlAlertRepository(engine)
    )
    return TestClient(app)


def test_alerts_list_returns_items(client, engine):
    with engine.begin() as c:
        c.execute(text("DELETE FROM haccp.alert"))
    _seed_alerts(engine, 5)
    r = client.get("/v1/alerts", params={"state": "open"}, headers=AUTH_READ)
    assert r.status_code == 200
    body = r.json()
    assert len(body["items"]) == 5


def test_alerts_list_empty_when_no_matching_state(client, engine):
    with engine.begin() as c:
        c.execute(text("DELETE FROM haccp.alert"))
    _seed_alerts(engine, 3)
    r = client.get("/v1/alerts", params={"state": "resolved"}, headers=AUTH_READ)
    assert r.status_code == 200
    assert len(r.json()["items"]) == 0


def test_alerts_list_pagination_offset(client, engine):
    with engine.begin() as c:
        c.execute(text("DELETE FROM haccp.alert"))
    _seed_alerts(engine, 10)
    r1 = client.get(
        "/v1/alerts",
        params={"state": "open", "limit": 3, "offset": 0},
        headers=AUTH_READ,
    )
    r2 = client.get(
        "/v1/alerts",
        params={"state": "open", "limit": 3, "offset": 3},
        headers=AUTH_READ,
    )
    assert r1.status_code == 200 and r2.status_code == 200
    assert len(r1.json()["items"]) == 3
    assert len(r2.json()["items"]) == 3
    assert r1.json()["items"][0]["id"] != r2.json()["items"][0]["id"]
