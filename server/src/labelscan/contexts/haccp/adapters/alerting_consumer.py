"""HACCP alerting consumer (adapter) for `batch.registered` / `batch.flagged`.

Owns alert creation (HACCP context). On batch.registered it evaluates the expiry
CCP against the active control plan; on batch.flagged it records an inconsistency
alert. Imports only its own context's domain — no cross-context coupling.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import date

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from labelscan.contexts.haccp.domain.control import ControlPlan, check_expiry

SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001"


class AlertingConsumer:
    consumer_name = "haccp"
    event_types = ("batch.registered", "batch.flagged")

    def __init__(
        self, *, engine: Engine, today: Callable[[], date] = date.today
    ) -> None:
        self._engine = engine  # reserved for future reads
        self._today = today

    def __call__(self, msg, conn: Connection) -> None:
        from labelscan.platform.db.audit_context import set_audit_context

        batch_id = msg.payload["batch_id"]
        corr, trace = msg.correlation_id, msg.trace_id
        dimensions = (
            conn.execute(
                text(
                    "SELECT organization_id::text AS organization_id, "
                    "store_id::text AS store_id, "
                    "business_portal_id::text AS business_portal_id "
                    "FROM traceability.batch WHERE id = :batch_id"
                ),
                {"batch_id": batch_id},
            )
            .mappings()
            .one()
        )

        if msg.event_type == "batch.flagged":
            set_audit_context(
                conn,
                actor_id=SYSTEM_ACTOR,
                action="haccp.alert_raised",
                correlation_id=corr,
                trace_id=trace,
            )
            self._raise(
                conn,
                batch_id,
                "inconsistency",
                "high",
                None,
                {"issues": msg.payload.get("issues", [])},
                corr,
                trace,
                dimensions,
            )
            return

        # batch.registered -> expiry CCP
        use_by = msg.payload.get("use_by")
        if not use_by:
            return
        plan = (
            conn.execute(
                text(
                    "SELECT version, expiry_warning_days FROM haccp.control_plan WHERE active "
                    "ORDER BY created_at DESC LIMIT 1"
                )
            )
            .mappings()
            .first()
        )
        if not plan or plan["expiry_warning_days"] is None:
            return
        v = check_expiry(
            date.fromisoformat(use_by),
            ControlPlan(
                version=plan["version"], expiry_warning_days=plan["expiry_warning_days"]
            ),
            today=self._today(),
        )
        if v is not None:
            set_audit_context(
                conn,
                actor_id=SYSTEM_ACTOR,
                action="haccp.alert_raised",
                correlation_id=corr,
                trace_id=trace,
            )
            self._raise(
                conn,
                batch_id,
                v.alert_type.value,
                v.severity.value,
                plan["version"],
                v.detail,
                corr,
                trace,
                dimensions,
            )

    def _raise(
        self,
        conn,
        batch_id,
        alert_type,
        severity,
        plan_version,
        detail,
        corr,
        trace,
        dimensions,
    ) -> None:
        conn.execute(
            text(
                "INSERT INTO haccp.alert (batch_id, organization_id, store_id, "
                "business_portal_id, alert_type, severity, control_plan_version, detail, "
                "correlation_id, trace_id) "
                "VALUES (:b, :organization_id, :store_id, :business_portal_id, "
                ":t, :sev, :pv, CAST(:d AS jsonb), :corr, :trace)"
            ),
            {
                "b": batch_id,
                "t": alert_type,
                "sev": severity,
                "pv": plan_version,
                "d": json.dumps(detail),
                "corr": corr,
                "trace": trace,
                "organization_id": dimensions["organization_id"],
                "store_id": dimensions["store_id"],
                "business_portal_id": dimensions["business_portal_id"],
            },
        )
