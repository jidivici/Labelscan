"""SQL adapter for the identity UserRepository (read side of login).

Read-only: a single SELECT against identity.app_user. No writes here — provisioning
is a separate admin operation (see cli.py).
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.identity.application.ports import UserRepository
from labelscan.contexts.identity.domain.user import StoredUser


class SqlUserRepository(UserRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def find_active_by_username(self, username: str) -> StoredUser | None:
        with self._engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT id::text AS id, username, password_hash, role, is_active "
                        "FROM identity.app_user "
                        "WHERE username = :u AND is_active = true"
                    ),
                    {"u": username},
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return StoredUser(
            id=row["id"],
            username=row["username"],
            password_hash=row["password_hash"],
            role=row["role"],
            is_active=row["is_active"],
        )
