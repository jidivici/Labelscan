"""Hygiene does not depend on a scan, label or published batch."""

from contextlib import contextmanager
from datetime import date, datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.contexts.haccp.adapters.http.hygiene_router import router
from labelscan.contexts.haccp.domain.hygiene import TASKS, tasks_for_trade
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.http import jwt
from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import install_error_handlers


def test_calendar_periods_and_trade_scope():
    tasks = {t.code: t for t in TASKS}
    assert tasks["reception"].period(date(2026, 9, 21)) == date(2026, 9, 21)
    assert tasks["tank"].period(date(2026, 9, 27)) == date(2026, 9, 21)
    assert tasks["thermometer"].period(date(2026, 9, 30)) == date(2026, 9, 1)
    assert tasks["tank"].period(date(2027, 1, 1)) == date(2026, 12, 28)
    assert tasks_for_trade("boucherie") == ()


@pytest.fixture
def hygiene(engine):
    # A single rolled-back transaction keeps proof data out of the test board.
    with engine.connect() as conn:
        transaction = conn.begin()
        org, actor, store, portal, other = [str(uuid4()) for _ in range(5)]
        set_audit_context(
            conn,
            actor_id=actor,
            action="hygiene.test",
            correlation_id="test",
            trace_id="test",
        )
        conn.execute(
            text(
                "INSERT INTO identity.organization(id,slug,name) VALUES (:id,:slug,'Test hygiène')"
            ),
            {"id": org, "slug": org},
        )
        conn.execute(
            text("""INSERT INTO identity.app_user
            (id,username,password_hash,role,display_name,created_by,organization_id)
            VALUES (:id,:username,'unused','super_admin','Test',:id,:org)"""),
            {"id": actor, "org": org, "username": actor},
        )
        conn.execute(
            text("""INSERT INTO identity.store(id,code,name,created_by,organization_id)
            VALUES (:id,:code,'Test',:actor,:org)"""),
            {
                "id": store,
                "code": "HYGIENE-" + store[:8].upper(),
                "actor": actor,
                "org": org,
            },
        )
        for identifier, trade in [(portal, "poissonnerie"), (other, "boucherie")]:
            conn.execute(
                text("""INSERT INTO identity.business_portal
                (id,organization_id,store_id,profession_code,name,created_by)
                VALUES (:id,:org,:store,:trade,'Test',:actor)"""),
                {
                    "id": identifier,
                    "org": org,
                    "store": store,
                    "trade": trade,
                    "actor": actor,
                },
            )

        class TransactionEngine:
            @contextmanager
            def begin(self):
                with conn.begin_nested():
                    yield conn

        app = FastAPI()
        install_error_handlers(app)
        app.include_router(router)
        app.dependency_overrides[get_engine] = lambda: TransactionEngine()

        def headers(*, organization=org, portals=None, scopes=None):
            token = jwt.encode(
                {
                    "sub": actor,
                    "actor_id": actor,
                    "principal": actor,
                    "organization_id": organization,
                    "organization_slug": "test",
                    "role": "manager",
                    "store_id": store,
                    "business_portal_ids": [portal] if portals is None else portals,
                    "scopes": ["haccp:read", "extraction:review"]
                    if scopes is None
                    else scopes,
                }
            )
            return {"Authorization": "Bearer " + token}

        with TestClient(app) as client:
            yield client, headers, portal, other, conn
        transaction.rollback()


def body(**changes):
    return {
        "day": datetime.now(ZoneInfo("Europe/Paris")).date().isoformat(),
        "outcome": "done",
        "notes": "Cabillaud, 2 °C, emballage intact, réception acceptée",
        "request_id": str(uuid4()),
        **changes,
    }


def test_reception_persists_without_label_and_retry_is_idempotent(hygiene):
    client, headers, portal, _, conn = hygiene
    url = f"/v1/hygiene/{portal}"
    assert client.get(url, headers=headers()).json()["tasks"][0]["outcome"] == "pending"
    payload = body()
    response = client.post(url + "/reception", headers=headers(), json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["tasks"][0]["outcome"] == "done"
    assert client.get(url, headers=headers()).json()["tasks"][0]["outcome"] == "done"
    assert (
        client.post(url + "/reception", headers=headers(), json=payload).status_code
        == 200
    )
    assert (
        conn.execute(
            text(
                "SELECT count(*) FROM haccp.hygiene_check WHERE business_portal_id=:id"
            ),
            {"id": portal},
        ).scalar_one()
        == 1
    )
    conflict = client.post(
        url + "/reception", headers=headers(), json={**payload, "outcome": "issue"}
    )
    assert conflict.status_code == 409
    tomorrow = date.fromisoformat(payload["day"]) + timedelta(days=1)
    assert (
        client.get(url + f"?day={tomorrow}", headers=headers()).json()["tasks"][0][
            "outcome"
        ]
        == "pending"
    )
    assert (
        client.post(
            url + "/reception", headers=headers(), json=body(day=str(tomorrow))
        ).status_code
        == 400
    )


def test_scope_auth_and_validation(hygiene):
    client, headers, portal, other, _ = hygiene
    url = f"/v1/hygiene/{portal}"
    assert client.get(url).status_code == 401
    assert client.get(url, headers=headers(scopes=[])).status_code == 403
    assert (
        client.get(url, headers=headers(organization=str(uuid4()))).status_code == 404
    )
    assert client.get(url, headers=headers(portals=[other])).status_code == 404
    assert (
        client.post(
            url + "/reception", headers=headers(portals=[other]), json=body()
        ).status_code
        == 404
    )
    assert (
        client.get(f"/v1/hygiene/{other}", headers=headers(portals=[other])).json()[
            "tasks"
        ]
        == []
    )
    assert (
        client.post(
            url + "/reception", headers=headers(), json=body(notes="  ")
        ).status_code
        == 400
    )
    assert (
        client.post(
            url + "/reception", headers=headers(), json=body(outcome="not_applicable")
        ).status_code
        == 400
    )
    assert (
        client.post(
            url + "/tank",
            headers=headers(),
            json=body(outcome="not_applicable", notes="Pas de vivier"),
        ).status_code
        == 200
    )


def test_issue_remains_visible_and_correction_preserves_history(hygiene):
    client, headers, portal, _, conn = hygiene
    url = f"/v1/hygiene/{portal}"
    response = client.post(
        url + "/reception",
        headers=headers(),
        json=body(outcome="issue", notes="Emballage abîmé : réserve"),
    )
    assert response.json()["tasks"][0]["outcome"] == "issue"
    response = client.post(
        url + "/reception",
        headers=headers(),
        json=body(notes="Contrôle repris et action corrective terminée"),
    )
    assert response.json()["tasks"][0]["outcome"] == "done"
    assert (
        conn.execute(
            text(
                "SELECT count(*) FROM haccp.hygiene_check WHERE business_portal_id=:id"
            ),
            {"id": portal},
        ).scalar_one()
        == 2
    )
    with pytest.raises(Exception), conn.begin_nested():
        conn.execute(
            text("DELETE FROM haccp.hygiene_check WHERE business_portal_id=:id"),
            {"id": portal},
        )


def test_monthly_and_weekly_completion_carries_through_period(hygiene):
    client, headers, portal, _, _ = hygiene
    url = f"/v1/hygiene/{portal}"
    for task_code in ("tank", "thermometer"):
        payload = body(notes="Mesures relevées selon PMS")
        assert (
            client.post(
                url + "/" + task_code, headers=headers(), json=payload
            ).status_code
            == 200
        )
        current = date.fromisoformat(payload["day"])
        task = next(t for t in TASKS if t.code == task_code)
        next_period = current + timedelta(days=1)
        while task.period(next_period) == task.period(current):
            tasks = client.get(url + f"?day={next_period}", headers=headers()).json()[
                "tasks"
            ]
            assert next(t for t in tasks if t["code"] == task_code)["outcome"] == "done"
            next_period += timedelta(days=1)
        tasks = client.get(url + f"?day={next_period}", headers=headers()).json()[
            "tasks"
        ]
        assert next(t for t in tasks if t["code"] == task_code)["outcome"] == "pending"


def test_database_runtime_role_cannot_read_other_tenant(hygiene):
    client, headers, portal, _, conn = hygiene
    assert (
        client.post(
            f"/v1/hygiene/{portal}/reception", headers=headers(), json=body()
        ).status_code
        == 200
    )
    with conn.begin_nested():
        conn.execute(text("SET LOCAL ROLE labelscan_app"))
        # The API left its tenant context in the surrounding transaction.
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM haccp.hygiene_check WHERE business_portal_id=:portal"
                ),
                {"portal": portal},
            ).scalar_one()
            == 1
        )
        conn.execute(
            text("SELECT set_config('labelscan.organization_id', :org, true)"),
            {"org": str(uuid4())},
        )
        assert (
            conn.execute(text("SELECT count(*) FROM haccp.hygiene_check")).scalar_one()
            == 0
        )
        conn.execute(text("RESET ROLE"))
