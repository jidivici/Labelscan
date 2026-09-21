"""Replace legacy demo passwords without reseeding or deleting production data."""

from __future__ import annotations

from seed_demo import DEMO_USERS, load_demo_passwords
from sqlalchemy import text

from labelscan.contexts.identity.domain.password import hash_password
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.engine import make_engine
from labelscan.platform.db.tenant_context import set_tenant_context


def secure_demo_credentials() -> None:
    passwords = load_demo_passwords()
    engine = make_engine()
    with engine.begin() as conn:
        organization = conn.execute(
            text("SELECT id::text FROM identity.organization WHERE slug = 'labelscan'")
        ).scalar_one()
        set_tenant_context(conn, organization)
        actor_id = conn.execute(
            text(
                "SELECT id::text FROM identity.app_user "
                "WHERE organization_id = :organization AND username = 'super_admin' "
                "AND deleted_at IS NULL"
            ),
            {"organization": organization},
        ).scalar_one()
        set_audit_context(
            conn,
            actor_id=actor_id,
            action="identity.demo_credentials_secured",
            correlation_id="production-security-bootstrap",
            trace_id="production-security-bootstrap",
        )
        rows = conn.execute(
            text(
                "SELECT id::text, username FROM identity.app_user "
                "WHERE organization_id = :organization "
                "AND username = ANY(CAST(:usernames AS text[])) "
                "AND deleted_at IS NULL FOR UPDATE"
            ),
            {"organization": organization, "usernames": list(DEMO_USERS)},
        ).all()
        by_username = {username: user_id for user_id, username in rows}
        missing = sorted(set(DEMO_USERS) - set(by_username))
        if missing:
            raise RuntimeError("demo accounts are missing; refusing partial rotation")
        for username in DEMO_USERS:
            conn.execute(
                text(
                    "UPDATE identity.app_user "
                    "SET password_hash = :password_hash, updated_at = clock_timestamp() "
                    "WHERE id = CAST(:user_id AS uuid)"
                ),
                {
                    "user_id": by_username[username],
                    "password_hash": hash_password(passwords[username]),
                },
            )
        conn.execute(
            text(
                "UPDATE identity.auth_session "
                "SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                "WHERE organization_id = :organization "
                "AND user_id = ANY(CAST(:user_ids AS uuid[]))"
            ),
            {
                "organization": organization,
                "user_ids": list(by_username.values()),
            },
        )
    print("demo credentials secured; all matching sessions revoked")


if __name__ == "__main__":
    secure_demo_credentials()
