"""Admin provisioning CLI — create or update the single admin user.

Usage (no registration endpoint exists by design):

    LABELSCAN_ADMIN_USERNAME=admin \\
    LABELSCAN_ADMIN_PASSWORD='a-long-secret' \\
    DATABASE_URL=postgresql+psycopg://... \\
    python -m labelscan.contexts.identity.adapters.cli

Idempotent upsert. The password is read from the environment and only its PBKDF2
hash is stored — the plaintext is never persisted or printed.
"""

from __future__ import annotations

import os
import sys
import uuid

from sqlalchemy import text

from labelscan.contexts.identity.domain.password import hash_password
from labelscan.contexts.identity.domain.user import SUPER_ADMIN_ROLE
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.engine import make_engine


def upsert_admin(username: str, password: str) -> str:
    """Bootstrap the organization super-admin (legacy function name retained)."""
    encoded = hash_password(password)
    engine = make_engine()
    with engine.begin() as conn:
        organization_id = conn.execute(
            text("SELECT id::text FROM identity.organization WHERE slug = 'labelscan'")
        ).scalar_one()
        existing_id = conn.execute(
            text(
                "SELECT id::text FROM identity.app_user "
                "WHERE organization_id = :organization_id AND username = :u"
            ),
            {"organization_id": organization_id, "u": username},
        ).scalar_one_or_none()
        user_id = existing_id or str(uuid.uuid4())
        # Bootstrap is deliberately self-attributed. Subsequent provisioning
        # records the same account as actor and subject.
        set_audit_context(
            conn,
            actor_id=user_id,
            action="identity.admin_provisioned",
            correlation_id="cli-provisioning",
            trace_id="cli-provisioning",
        )
        row = conn.execute(
            text(
                "INSERT INTO identity.app_user "
                "(id, organization_id, organization_code, username, display_name, "
                "password_hash, role, active, created_by) "
                "VALUES (:id, :organization_id, 'labelscan', :u, :u, :h, :r, true, :id) "
                "ON CONFLICT (organization_id, username) DO UPDATE "
                "SET password_hash = excluded.password_hash, "
                "    role = excluded.role, "
                "    active = true, "
                "    updated_at = now() "
                "RETURNING id::text"
            ),
            {
                "id": user_id,
                "organization_id": organization_id,
                "u": username,
                "h": encoded,
                "r": SUPER_ADMIN_ROLE,
            },
        ).first()
        conn.execute(
            text(
                "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                "WHERE user_id = :id"
            ),
            {"id": user_id},
        )
    return row[0]


def main(argv: list[str] | None = None) -> int:
    username = os.environ.get("LABELSCAN_ADMIN_USERNAME")
    password = os.environ.get("LABELSCAN_ADMIN_PASSWORD")
    if not username or not password:
        print(
            "LABELSCAN_ADMIN_USERNAME and LABELSCAN_ADMIN_PASSWORD must both be set",
            file=sys.stderr,
        )
        return 2
    user_id = upsert_admin(username, password)
    print(f"admin user provisioned: {username} ({user_id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
