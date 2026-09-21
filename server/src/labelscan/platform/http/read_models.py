"""Shared read-model fragments (platform / infra).

Read side only: these DTOs reflect exactly what is stored — nothing is
reconstructed or corrected. AuditEntry lives here so every context's read adapter
can include audit metadata without importing another context.
"""

from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Connection


class AuditEntry(BaseModel):
    actor_id: str
    action: str
    occurred_at: str


def audit_entries(conn: Connection, subject_id: str) -> list[AuditEntry]:
    rows = (
        conn.execute(
            text(
                "SELECT actor_id::text AS actor_id, action, occurred_at::text AS occurred_at "
                "FROM audit.audit_log WHERE subject_id = :s ORDER BY occurred_at"
            ),
            {"s": subject_id},
        )
        .mappings()
        .all()
    )
    return [AuditEntry(**r) for r in rows]
