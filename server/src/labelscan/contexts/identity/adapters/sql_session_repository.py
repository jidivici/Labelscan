"""PostgreSQL adapter for rotating refresh-token families."""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.identity.application.sessions import InvalidRefreshToken
from labelscan.contexts.identity.domain.user import (
    AuthenticatedUser,
    scopes_for_role,
)
from labelscan.platform.db.tenant_context import set_tenant_context


def _user(row) -> AuthenticatedUser:
    return AuthenticatedUser(
        actor_id=row["user_id"],
        username=row["username"],
        display_name=row["display_name"],
        role=row["role"],
        scopes=scopes_for_role(row["role"]),
        store_code=row["store_code"],
        organization_id=row["organization_id"],
        organization_slug=row["organization_slug"],
        store_id=row["store_id"],
    )


class SqlSessionRepository:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def create(self, user, token_hash: str, ttl_seconds: int) -> str:
        family_id = str(uuid.uuid4())
        with self._engine.begin() as conn:
            set_tenant_context(conn, user.organization_id)
            conn.execute(
                text(
                    "INSERT INTO identity.auth_session "
                    "(family_id, organization_id, user_id, refresh_token_hash, refresh_expires_at) "
                    "VALUES (:family_id, :organization_id, :user_id, :token_hash, "
                    "clock_timestamp() + make_interval(secs => :ttl))"
                ),
                {
                    "family_id": family_id,
                    "organization_id": user.organization_id,
                    "user_id": user.actor_id,
                    "token_hash": token_hash,
                    "ttl": ttl_seconds,
                },
            )
        return family_id

    def rotate(
        self, token_hash: str, replacement_hash: str, ttl_seconds: int
    ) -> tuple[str, AuthenticatedUser]:
        rejected = False
        with self._engine.begin() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT s.id::text, s.family_id::text, "
                        "s.organization_id::text, s.user_id::text, s.consumed_at, "
                        "s.revoked_at, s.refresh_expires_at, u.username, "
                        "u.display_name, u.role, u.active, u.store_code, "
                        "u.store_id::text, o.slug AS organization_slug "
                        "FROM identity.auth_session s "
                        "JOIN identity.app_user u ON u.id = s.user_id "
                        "JOIN identity.organization o ON o.id = s.organization_id "
                        "WHERE s.refresh_token_hash = :token_hash FOR UPDATE OF s"
                    ),
                    {"token_hash": token_hash},
                )
                .mappings()
                .first()
            )
            if row is None:
                raise InvalidRefreshToken()
            set_tenant_context(conn, row["organization_id"])
            invalid = (
                row["consumed_at"] is not None
                or row["revoked_at"] is not None
                or not row["active"]
            )
            if invalid:
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE family_id = :family_id"
                    ),
                    {"family_id": row["family_id"]},
                )
                rejected = True
            elif not conn.execute(
                text("SELECT :expires_at > clock_timestamp()"),
                {"expires_at": row["refresh_expires_at"]},
            ).scalar_one():
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE family_id = :family_id"
                    ),
                    {"family_id": row["family_id"]},
                )
                rejected = True
            if not rejected:
                replacement_id = str(uuid.uuid4())
                conn.execute(
                    text(
                        "INSERT INTO identity.auth_session "
                        "(id, family_id, organization_id, user_id, refresh_token_hash, refresh_expires_at) "
                        "VALUES (:id, :family_id, :organization_id, :user_id, :replacement_hash, "
                        "clock_timestamp() + make_interval(secs => :ttl))"
                    ),
                    {
                        "id": replacement_id,
                        "family_id": row["family_id"],
                        "organization_id": row["organization_id"],
                        "user_id": row["user_id"],
                        "replacement_hash": replacement_hash,
                        "ttl": ttl_seconds,
                    },
                )
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET consumed_at = clock_timestamp(), "
                        "replaced_by_id = :replacement_id WHERE id = :id"
                    ),
                    {"replacement_id": replacement_id, "id": row["id"]},
                )
        if rejected:
            raise InvalidRefreshToken()
        return row["family_id"], _user(row)

    def revoke(self, token_hash: str) -> None:
        with self._engine.begin() as conn:
            family_id = conn.execute(
                text(
                    "SELECT family_id::text FROM identity.auth_session "
                    "WHERE refresh_token_hash = :token_hash"
                ),
                {"token_hash": token_hash},
            ).scalar_one_or_none()
            if family_id:
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE family_id = :family_id"
                    ),
                    {"family_id": family_id},
                )

    def family_is_active(self, family_id: str, actor_id: str) -> bool:
        with self._engine.begin() as conn:
            return bool(
                conn.execute(
                    text(
                        "SELECT EXISTS (SELECT 1 FROM identity.auth_session s "
                        "JOIN identity.app_user u ON u.id = s.user_id "
                        "WHERE s.family_id = :family_id AND s.user_id = :actor_id "
                        "AND s.revoked_at IS NULL AND s.refresh_expires_at > clock_timestamp() "
                        "AND u.active = true)"
                    ),
                    {"family_id": family_id, "actor_id": actor_id},
                ).scalar_one()
            )
