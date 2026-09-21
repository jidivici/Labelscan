"""Alert lifecycle endpoint proofs.

- valid transitions applied (open -> acknowledged -> resolved; open -> resolved)
- invalid transitions rejected (409 ALERT_INVALID_TRANSITION), no state change
- audit co-committed on a successful transition; none written on a rejected one
- unknown id -> 404; missing scope -> 403
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.haccp.adapters.http.lifecycle_router import get_alert_service
from labelscan.contexts.haccp.adapters.sql_alert_repository import SqlAlertRepository
from labelscan.contexts.haccp.application.alert_service import AlertLifecycleService
from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import ACTOR_ID, bearer

AUTH = bearer("alert:ack alert:resolve", principal="supervisor-1")


@pytest.fixture
def client(engine):
    app = create_app()
    app.dependency_overrides[get_alert_service] = lambda: AlertLifecycleService(
        SqlAlertRepository(engine)
    )
    return TestClient(app)


@pytest.fixture
def validation_client():
    app = create_app()
    app.dependency_overrides[get_alert_service] = lambda: object()
    return TestClient(app)


def _make_alert(engine, state="open") -> str:
    with engine.begin() as c:
        set_audit_context(
            c,
            actor_id=ACTOR_ID,
            action="haccp.alert_raised",
            correlation_id="c",
            trace_id="t",
        )
        aid = c.execute(
            text(
                "INSERT INTO haccp.alert (alert_type, severity, state, detail, correlation_id, trace_id) "
                "VALUES ('temperature', 'high', :s, '{}'::jsonb, 'c', 't') RETURNING id"
            ),
            {"s": state},
        ).scalar_one()
    return str(aid)


def _state(engine, alert_id):
    with engine.connect() as c:
        return c.execute(
            text("SELECT state FROM haccp.alert WHERE id = :id"), {"id": alert_id}
        ).scalar_one()


def _audit_count(engine, alert_id, action):
    with engine.connect() as c:
        return c.execute(
            text(
                "SELECT count(*) FROM audit.audit_log WHERE subject_id = :id AND action = :a"
            ),
            {"id": alert_id, "a": action},
        ).scalar_one()


def test_acknowledge_open_alert(client, engine):
    aid = _make_alert(engine, "open")
    r = client.post(f"/v1/alerts/{aid}/acknowledge", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"alert_id": aid, "state": "acknowledged"}
    assert _state(engine, aid) == "acknowledged"
    # audit co-committed with the transition
    assert _audit_count(engine, aid, "haccp.alert_acknowledged") == 1


def test_resolve_open_alert(client, engine):
    aid = _make_alert(engine, "open")
    r = client.post(f"/v1/alerts/{aid}/resolve", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["state"] == "resolved"
    assert _state(engine, aid) == "resolved"
    assert _audit_count(engine, aid, "haccp.alert_resolved") == 1


def test_acknowledge_then_resolve(client, engine):
    aid = _make_alert(engine, "open")
    assert client.post(f"/v1/alerts/{aid}/acknowledge", headers=AUTH).status_code == 200
    r = client.post(f"/v1/alerts/{aid}/resolve", headers=AUTH)
    assert r.status_code == 200 and r.json()["state"] == "resolved"
    assert _state(engine, aid) == "resolved"


def test_acknowledge_already_acknowledged_is_409(client, engine):
    aid = _make_alert(engine, "acknowledged")
    r = client.post(f"/v1/alerts/{aid}/acknowledge", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error_code"] == "ALERT_INVALID_TRANSITION"
    # no state change, and NO audit written for the rejected transition (rolled back)
    assert _state(engine, aid) == "acknowledged"
    assert _audit_count(engine, aid, "haccp.alert_acknowledged") == 0


def test_resolve_resolved_is_409(client, engine):
    aid = _make_alert(engine, "resolved")
    r = client.post(f"/v1/alerts/{aid}/resolve", headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error_code"] == "ALERT_INVALID_TRANSITION"
    assert _state(engine, aid) == "resolved"


def test_unknown_alert_is_404(client):
    r = client.post(f"/v1/alerts/{uuid.uuid4()}/acknowledge", headers=AUTH)
    assert r.status_code == 404
    assert r.json()["error_code"] == "NOT_FOUND"


def test_requires_scope(client, engine):
    aid = _make_alert(engine, "open")
    r = client.post(f"/v1/alerts/{aid}/acknowledge", headers=bearer("haccp:read"))
    assert r.status_code == 403
    assert r.json()["error_code"] == "FORBIDDEN"


@pytest.mark.parametrize(
    "alert_id",
    [
        str(uuid.uuid4()).upper(),
        uuid.uuid4().hex,
        f"{{{uuid.uuid4()}}}",
        f"{uuid.uuid4()}\u202e",
    ],
)
def test_alert_lifecycle_rejects_noncanonical_ids(validation_client, alert_id):
    response = validation_client.post(
        f"/v1/alerts/{alert_id}/acknowledge", headers=AUTH
    )

    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_alert_lifecycle_rejects_unknown_query_without_transition(validation_client):
    alert_id = str(uuid.uuid4())
    response = validation_client.post(
        f"/v1/alerts/{alert_id}/acknowledge?unexpected=value", headers=AUTH
    )

    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"
