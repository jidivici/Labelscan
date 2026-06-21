"""Temperature logging + CCP evaluation (adapter / internal use case).

Records an immutable temperature reading and, in the SAME transaction, evaluates
it against the active control plan; a violation raises an alert atomically. No
public HTTP surface yet (PG-6).
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.haccp.domain.control import ControlPlan, check_temperature
from labelscan.platform.db.audit_context import set_audit_context


@dataclass(frozen=True)
class TemperatureRecorded:
    alert_raised: bool


class TemperatureRecorder:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def record(
        self,
        *,
        batch_id,
        location: str,
        temp_c: float,
        measured_at: str,
        actor_id: str,
        correlation_id: str,
        trace_id: str,
        source: str = "manual",
    ) -> TemperatureRecorded:
        with self._engine.begin() as conn:
            set_audit_context(
                conn,
                actor_id=actor_id,
                action="haccp.temperature_logged",
                correlation_id=correlation_id,
                trace_id=trace_id,
            )
            conn.execute(
                text(
                    "INSERT INTO haccp.temperature_log "
                    "(measured_at, batch_id, location, temp_c, source, correlation_id, trace_id) "
                    "VALUES (:m, :b, :loc, :t, :src, :corr, :trace)"
                ),
                {
                    "m": measured_at,
                    "b": batch_id,
                    "loc": location,
                    "t": temp_c,
                    "src": source,
                    "corr": correlation_id,
                    "trace": trace_id,
                },
            )
            plan = (
                conn.execute(
                    text(
                        "SELECT version, max_temp_c, min_temp_c FROM haccp.control_plan "
                        "WHERE active ORDER BY created_at DESC LIMIT 1"
                    )
                )
                .mappings()
                .first()
            )
            if not plan:
                return TemperatureRecorded(alert_raised=False)

            violation = check_temperature(
                float(temp_c),
                ControlPlan(
                    version=plan["version"],
                    max_temp_c=float(plan["max_temp_c"])
                    if plan["max_temp_c"] is not None
                    else None,
                    min_temp_c=float(plan["min_temp_c"])
                    if plan["min_temp_c"] is not None
                    else None,
                ),
            )
            if violation is None:
                return TemperatureRecorded(alert_raised=False)

            set_audit_context(
                conn,
                actor_id=actor_id,
                action="haccp.alert_raised",
                correlation_id=correlation_id,
                trace_id=trace_id,
            )
            conn.execute(
                text(
                    "INSERT INTO haccp.alert (batch_id, alert_type, severity, control_plan_version, detail, "
                    " correlation_id, trace_id) "
                    "VALUES (:b, 'temperature', :sev, :pv, CAST(:d AS jsonb), :corr, :trace)"
                ),
                {
                    "b": batch_id,
                    "sev": violation.severity.value,
                    "pv": plan["version"],
                    "d": json.dumps(violation.detail),
                    "corr": correlation_id,
                    "trace": trace_id,
                },
            )
            return TemperatureRecorded(alert_raised=True)
