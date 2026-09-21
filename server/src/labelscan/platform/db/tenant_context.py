"""Transaction-local organization context used by PostgreSQL RLS policies."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Connection

_SET_TENANT = text(
    "SELECT set_config('labelscan.organization_id', :organization_id, true)"
)


def set_tenant_context(conn: Connection, organization_id: str) -> None:
    """Restrict the current transaction to one organization."""
    conn.execute(_SET_TENANT, {"organization_id": organization_id})
