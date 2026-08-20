"""SQL credential lookup adapter used by login and refresh-session rotation."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.identity.application.ports import UserRepository
from labelscan.contexts.identity.domain.user import StoredUser
from labelscan.platform.db.tenant_context import set_tenant_context


def _portal_context(
    conn, organization_id: str, user_id: str
) -> tuple[tuple[str, ...], str | None, str | None, tuple[str, ...]]:
    """Load canonical portal claims from authoritative assignments.

    The first assignment (oldest, then UUID) is the stable primary portal used by
    legacy single-portal consumers.  Managers keep the complete ordered tuple.
    """
    rows = (
        conn.execute(
            text(
                "SELECT assignment.portal_id::text AS portal_id, "
                "portal.profession_code, portal.store_id::text AS store_id "
                "FROM identity.user_portal_assignment AS assignment "
                "JOIN identity.business_portal AS portal "
                "ON portal.id = assignment.portal_id "
                "AND portal.organization_id = assignment.organization_id "
                "JOIN identity.store AS store ON store.id = portal.store_id "
                "AND store.organization_id = portal.organization_id "
                "WHERE assignment.organization_id = :organization_id "
                "AND assignment.user_id = :user_id AND assignment.active = true "
                "AND portal.active = true AND store.active = true "
                "ORDER BY assignment.created_at, assignment.portal_id"
            ),
            {"organization_id": organization_id, "user_id": user_id},
        )
        .mappings()
        .all()
    )
    portal_ids = tuple(row["portal_id"] for row in rows)
    primary = rows[0] if rows else None
    store_ids = tuple(dict.fromkeys(row["store_id"] for row in rows))
    return (
        portal_ids,
        primary["portal_id"] if primary else None,
        primary["profession_code"] if primary else None,
        store_ids,
    )


def _identity_context(
    conn, organization_id: str, user_id: str, role: str
) -> tuple[tuple[str, ...], str | None, str | None, tuple[str, ...]]:
    """Return claims matching the persisted role's authoritative perimeter."""

    if role != "admin":
        return _portal_context(conn, organization_id, user_id)
    rows = (
        conn.execute(
            text(
                "SELECT portal.id::text AS portal_id, portal.store_id::text AS store_id "
                "FROM identity.business_portal AS portal "
                "JOIN identity.store AS store ON store.id = portal.store_id "
                "AND store.organization_id = portal.organization_id "
                "WHERE portal.organization_id = :organization_id "
                "AND store.created_by = :user_id "
                "AND portal.active = true AND store.active = true "
                "ORDER BY store.created_at, portal.created_at, portal.id"
            ),
            {"organization_id": organization_id, "user_id": user_id},
        )
        .mappings()
        .all()
    )
    return (
        tuple(row["portal_id"] for row in rows),
        None,
        None,
        tuple(dict.fromkeys(row["store_id"] for row in rows)),
    )


class SqlUserRepository(UserRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def find_active_by_username(
        self, username: str, organization_slug: str = "labelscan"
    ) -> StoredUser | None:
        with self._engine.begin() as conn:
            organization = (
                conn.execute(
                    text(
                        "SELECT id::text AS id, slug FROM identity.organization "
                        "WHERE slug = :slug AND active = true"
                    ),
                    {"slug": organization_slug.strip().lower()},
                )
                .mappings()
                .first()
            )
            if organization is None:
                return None
            set_tenant_context(conn, organization["id"])
            row = (
                conn.execute(
                    text(
                        "SELECT id::text AS id, username, display_name, "
                        "password_hash, role, active, store_code, "
                        "organization_id::text AS organization_id, "
                        "store_id::text AS store_id "
                        "FROM identity.app_user "
                        "WHERE organization_id = :organization_id "
                        "AND username = :u AND active = true AND deleted_at IS NULL"
                    ),
                    {"organization_id": organization["id"], "u": username},
                )
                .mappings()
                .first()
            )
            portal_ids: tuple[str, ...] = ()
            primary_portal_id = None
            trade_code = None
            store_ids: tuple[str, ...] = ()
            if row is not None:
                portal_ids, primary_portal_id, trade_code, store_ids = (
                    _identity_context(conn, organization["id"], row["id"], row["role"])
                )
        if row is None:
            return None
        return StoredUser(
            id=row["id"],
            username=row["username"],
            display_name=row["display_name"],
            password_hash=row["password_hash"],
            role=row["role"],
            active=row["active"],
            store_code=row["store_code"],
            organization_id=row["organization_id"],
            organization_slug=organization["slug"],
            store_id=row["store_id"],
            business_portal_ids=portal_ids,
            business_portal_id=primary_portal_id,
            trade_code=trade_code,
            store_ids=store_ids,
        )
