"""PG-5 proofs (integration) — temperature logging + CCP alerting."""

from __future__ import annotations

import uuid

from sqlalchemy import text

from labelscan.contexts.haccp.adapters.temperature_recorder import TemperatureRecorder
from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import ACTOR_ID


def _seed_plan(engine, *, max_temp=4.0, min_temp=-2.0):
    version = f"temp-plan-{uuid.uuid4().hex[:8]}"
    with engine.begin() as c:
        set_audit_context(
            c,
            actor_id=ACTOR_ID,
            action="haccp.plan_created",
            correlation_id="c",
            trace_id="t",
        )
        # deactivate any prior active plan would require UPDATE; instead just insert
        # this one active and rely on ORDER BY created_at DESC LIMIT 1 to pick the latest.
        c.execute(
            text(
                "INSERT INTO haccp.control_plan (version, max_temp_c, min_temp_c, expiry_warning_days, active, "
                "correlation_id, trace_id) VALUES (:v, :mx, :mn, 7, true, 'c', 't')"
            ),
            {"v": version, "mx": max_temp, "mn": min_temp},
        )
    return version


def test_temperature_breach_raises_alert(engine):
    _seed_plan(engine, max_temp=4.0)
    rec = TemperatureRecorder(engine)
    out = rec.record(
        batch_id=None,
        location="fridge-1",
        temp_c=8.5,
        measured_at="2026-06-14T08:00:00Z",
        actor_id=ACTOR_ID,
        correlation_id="corr-temp",
        trace_id="trace-temp",
    )
    assert out.alert_raised is True
    with engine.connect() as c:
        n = c.execute(
            text(
                "SELECT count(*) FROM haccp.alert WHERE alert_type='temperature' AND state='open' "
                "AND correlation_id='corr-temp'"
            )
        ).scalar_one()
        logged = c.execute(
            text(
                "SELECT count(*) FROM haccp.temperature_log WHERE correlation_id='corr-temp'"
            )
        ).scalar_one()
    assert n == 1
    assert logged == 1


def test_temperature_in_range_no_alert(engine):
    _seed_plan(engine, max_temp=4.0)
    rec = TemperatureRecorder(engine)
    out = rec.record(
        batch_id=None,
        location="fridge-2",
        temp_c=2.0,
        measured_at="2026-06-14T08:05:00Z",
        actor_id=ACTOR_ID,
        correlation_id="corr-temp-ok",
        trace_id="trace-temp-ok",
    )
    assert out.alert_raised is False
    with engine.connect() as c:
        alerts = c.execute(
            text("SELECT count(*) FROM haccp.alert WHERE correlation_id='corr-temp-ok'")
        ).scalar_one()
        logged = c.execute(
            text(
                "SELECT count(*) FROM haccp.temperature_log WHERE correlation_id='corr-temp-ok'"
            )
        ).scalar_one()
    assert alerts == 0  # no silent acceptance issue — a safe reading raises nothing
    assert logged == 1  # but the reading is still durably recorded
