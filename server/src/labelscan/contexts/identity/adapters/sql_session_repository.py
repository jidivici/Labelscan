"""PostgreSQL adapter for rotating refresh-token families."""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.identity.adapters.sql_user_repository import _portal_context
from labelscan.contexts.identity.application.sessions import InvalidRefreshToken
from labelscan.contexts.identity.domain.user import (
    AuthenticatedUser,
    scopes_for_role,
)
from labelscan.platform.db.tenant_context import set_tenant_context


def _user(row, portal_context) -> AuthenticatedUser:
    portal_ids, primary_portal_id, trade_code, store_ids = portal_context
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
        business_portal_ids=portal_ids,
        business_portal_id=primary_portal_id,
        trade_code=trade_code,
        store_ids=store_ids,
    )


class SqlSessionRepository:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def create(
        self,
        user,
        token_hash: str,
        ttl_seconds: int,
        client_type: str = "browser",
    ) -> str:
        family_id = str(uuid.uuid4())
        with self._engine.begin() as conn:
            set_tenant_context(conn, user.organization_id)
            conn.execute(
                text(
                    "INSERT INTO identity.auth_session "
                    "(family_id, organization_id, user_id, client_type, "
                    "refresh_token_hash, refresh_expires_at) "
                    "VALUES (:family_id, :organization_id, :user_id, :client_type, :token_hash, "
                    "clock_timestamp() + make_interval(secs => :ttl))"
                ),
                {
                    "family_id": family_id,
                    "organization_id": user.organization_id,
                    "user_id": user.actor_id,
                    "token_hash": token_hash,
                    "client_type": client_type,
                    "ttl": ttl_seconds,
                },
            )
        return family_id

    def rotate(
        self,
        token_hash: str,
        replacement_hash: str,
        ttl_seconds: int,
        expected_client_type: str = "browser",
    ) -> tuple[str, AuthenticatedUser, str]:
        rejected = False
        with self._engine.begin() as conn:
            organization_id = conn.execute(
                text(
                    "SELECT identity.auth_session_organization_for_token(:token_hash)::text"
                ),
                {"token_hash": token_hash},
            ).scalar_one_or_none()
            if organization_id is None:
                raise InvalidRefreshToken()
            set_tenant_context(conn, organization_id)
            session = (
                conn.execute(
                    text(
                        "SELECT id::text, family_id::text, organization_id::text, "
                        "user_id::text, client_type, consumed_at, revoked_at, "
                        "refresh_expires_at FROM identity.auth_session "
                        "WHERE refresh_token_hash = :token_hash "
                        "AND organization_id = :organization_id FOR UPDATE"
                    ),
                    {
                        "token_hash": token_hash,
                        "organization_id": organization_id,
                    },
                )
                .mappings()
                .first()
            )
            if session is None:
                raise InvalidRefreshToken()
            user_row = (
                conn.execute(
                    text(
                        "SELECT u.id::text AS user_id, u.username, u.display_name, "
                        "u.role, u.active, u.store_code, u.store_id::text, "
                        "u.organization_id::text AS organization_id, "
                        "o.slug AS organization_slug "
                        "FROM identity.app_user AS u "
                        "JOIN identity.organization AS o ON o.id = u.organization_id "
                        "WHERE u.id = :user_id "
                        "AND u.organization_id = :organization_id"
                    ),
                    {
                        "user_id": session["user_id"],
                        "organization_id": session["organization_id"],
                    },
                )
                .mappings()
                .first()
            )
            invalid = (
                session["consumed_at"] is not None
                or session["revoked_at"] is not None
                or user_row is None
                or not user_row["active"]
                or session["client_type"] != expected_client_type
            )
            if invalid:
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE family_id = :family_id"
                    ),
                    {"family_id": session["family_id"]},
                )
                rejected = True
            elif not conn.execute(
                text("SELECT :expires_at > clock_timestamp()"),
                {"expires_at": session["refresh_expires_at"]},
            ).scalar_one():
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE family_id = :family_id"
                    ),
                    {"family_id": session["family_id"]},
                )
                rejected = True
            if not rejected:
                portal_context = _portal_context(
                    conn, session["organization_id"], session["user_id"]
                )
                replacement_id = str(uuid.uuid4())
                conn.execute(
                    text(
                        "INSERT INTO identity.auth_session "
                        "(id, family_id, organization_id, user_id, client_type, "
                        "refresh_token_hash, refresh_expires_at) "
                        "VALUES (:id, :family_id, :organization_id, :user_id, :client_type, :replacement_hash, "
                        "clock_timestamp() + make_interval(secs => :ttl))"
                    ),
                    {
                        "id": replacement_id,
                        "family_id": session["family_id"],
                        "organization_id": session["organization_id"],
                        "user_id": session["user_id"],
                        "client_type": session["client_type"],
                        "replacement_hash": replacement_hash,
                        "ttl": ttl_seconds,
                    },
                )
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET consumed_at = clock_timestamp(), "
                        "replaced_by_id = :replacement_id WHERE id = :id"
                    ),
                    {"replacement_id": replacement_id, "id": session["id"]},
                )
        if rejected:
            raise InvalidRefreshToken()
        return (
            session["family_id"],
            _user(user_row, portal_context),
            session["client_type"],
        )

    def revoke(self, token_hash: str) -> None:
        with self._engine.begin() as conn:
            organization_id = conn.execute(
                text(
                    "SELECT identity.auth_session_organization_for_token(:token_hash)::text"
                ),
                {"token_hash": token_hash},
            ).scalar_one_or_none()
            if organization_id is None:
                return
            set_tenant_context(conn, organization_id)
            session = (
                conn.execute(
                    text(
                        "SELECT family_id::text AS family_id, "
                        "organization_id::text AS organization_id "
                        "FROM identity.auth_session "
                        "WHERE refresh_token_hash = :token_hash "
                        "AND organization_id = :organization_id"
                    ),
                    {
                        "token_hash": token_hash,
                        "organization_id": organization_id,
                    },
                )
                .mappings()
                .first()
            )
            if session:
                conn.execute(
                    text(
                        "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE family_id = :family_id"
                    ),
                    {"family_id": session["family_id"]},
                )

    def family_is_active(self, family_id: str, actor_id: str) -> bool:
        with self._engine.begin() as conn:
            organization_id = conn.execute(
                text(
                    "SELECT identity.auth_session_organization_for_family("
                    "CAST(:family_id AS uuid), CAST(:actor_id AS uuid))::text"
                ),
                {"family_id": family_id, "actor_id": actor_id},
            ).scalar_one_or_none()
            if organization_id is None:
                return False
            set_tenant_context(conn, organization_id)
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
