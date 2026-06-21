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

from sqlalchemy import text

from labelscan.contexts.identity.domain.password import hash_password
from labelscan.contexts.identity.domain.user import ADMIN_ROLE
from labelscan.platform.db.engine import make_engine


def upsert_admin(username: str, password: str) -> str:
    """Create the admin user, or reset its password and re-activate it. Returns the id."""
    encoded = hash_password(password)
    engine = make_engine()
    with engine.begin() as conn:
        row = conn.execute(
            text(
                "INSERT INTO identity.app_user (username, password_hash, role, is_active) "
                "VALUES (:u, :h, :r, true) "
                "ON CONFLICT (username) DO UPDATE "
                "SET password_hash = excluded.password_hash, "
                "    role = excluded.role, "
                "    is_active = true, "
                "    updated_at = now() "
                "RETURNING id::text"
            ),
            {"u": username, "h": encoded, "r": ADMIN_ROLE},
        ).first()
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
