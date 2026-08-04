"""SQL adapter for login and audited administrative account management."""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from labelscan.contexts.identity.application.ports import (
    AdminAuditContext,
    LastActiveAdmin,
    NewUser,
    SelfAccessChangeNotAllowed,
    UserChanges,
    UsernameAlreadyExists,
    UserNotFound,
    UserRepository,
)
from labelscan.contexts.identity.application.store_ports import (
    StoreInactive,
    StoreNotFound,
    StoreRequired,
)
from labelscan.contexts.identity.domain.user import (
    ADMIN_ROLE,
    OPERATOR_ROLE,
    ManagedUser,
    StoredUser,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context

_USER_COLUMNS = (
    "id::text AS id, username, display_name, role, active, store_code, "
    "organization_id::text AS organization_id, store_id::text AS store_id, "
    "created_by::text AS created_by, created_at::text AS created_at, "
    "updated_at::text AS updated_at"
)


def _managed(row) -> ManagedUser:
    return ManagedUser(
        id=row["id"],
        username=row["username"],
        display_name=row["display_name"],
        role=row["role"],
        active=row["active"],
        store_code=row["store_code"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        organization_id=row["organization_id"],
        store_id=row["store_id"],
        business_portal_ids=tuple(
            str(value) for value in row.get("business_portal_ids", ())
        ),
    )


def _is_unique_violation(exc: IntegrityError) -> bool:
    return getattr(exc.orig, "sqlstate", None) == "23505"


def _default_organization_id(conn) -> str:
    return str(
        conn.execute(
            text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
        ).scalar_one()
    )


def _require_active_store(conn, organization_id: str, store_code: str) -> str:
    row = (
        conn.execute(
            text(
                "SELECT id::text AS id, active FROM identity.store "
                "WHERE organization_id = :organization_id AND code = :code"
            ),
            {"organization_id": organization_id, "code": store_code},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise StoreNotFound()
    if not row["active"]:
        raise StoreInactive()
    return row["id"]


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
                        "AND username = :u AND active = true"
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
                portal_ids, primary_portal_id, trade_code, store_ids = _portal_context(
                    conn, organization["id"], row["id"]
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

    def create_user(self, user: NewUser, audit: AdminAuditContext) -> ManagedUser:
        user_id = str(uuid.uuid4())
        try:
            with self._engine.begin() as conn:
                organization_id = audit.organization_id or _default_organization_id(
                    conn
                )
                set_tenant_context(conn, organization_id)
                store_id = None
                if user.store_code is not None:
                    store_id = _require_active_store(
                        conn, organization_id, user.store_code
                    )
                set_audit_context(
                    conn,
                    actor_id=audit.actor_id,
                    action="identity.user_created",
                    correlation_id=audit.correlation_id,
                    trace_id=audit.trace_id,
                )
                row = (
                    conn.execute(
                        text(
                            "INSERT INTO identity.app_user "
                            "(id, username, display_name, password_hash, role, "
                            "active, organization_id, organization_code, "
                            "store_id, store_code, created_by) "
                            "VALUES (:id, :username, :display_name, :password_hash, "
                            ":role, true, :organization_id, "
                            "(SELECT slug FROM identity.organization WHERE id = :organization_id), "
                            ":store_id, :store_code, :created_by) "
                            f"RETURNING {_USER_COLUMNS}"
                        ),
                        {
                            "id": user_id,
                            "username": user.username,
                            "display_name": user.display_name,
                            "password_hash": user.password_hash,
                            "role": user.role,
                            "store_code": user.store_code,
                            "store_id": store_id,
                            "organization_id": organization_id,
                            "created_by": user.created_by,
                        },
                    )
                    .mappings()
                    .one()
                )
        except IntegrityError as exc:
            if _is_unique_violation(exc):
                raise UsernameAlreadyExists() from exc
            raise
        return _managed(row)

    def list_users(
        self,
        *,
        organization_id: str | None = None,
        role: str | None,
        active: bool | None,
        store_code: str | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[ManagedUser], int]:
        conditions: list[str] = []
        params: dict[str, object] = {"limit": limit, "offset": offset}
        if role is not None:
            conditions.append("role = :role")
            params["role"] = role
        if active is not None:
            conditions.append("active = :active")
            params["active"] = active
        if store_code is not None:
            conditions.append("store_code = :store_code")
            params["store_code"] = store_code
        if query is not None:
            conditions.append(
                "(username ILIKE :query OR display_name ILIKE :query "
                "OR store_code ILIKE :query)"
            )
            params["query"] = f"%{query}%"
        with self._engine.begin() as conn:
            if organization_id is None:
                organization_id = _default_organization_id(conn)
            set_tenant_context(conn, organization_id)
            conditions.insert(0, "organization_id = :organization_id")
            params["organization_id"] = organization_id
            where = f"WHERE {' AND '.join(conditions)}"
            rows = (
                conn.execute(
                    text(
                        f"SELECT {_USER_COLUMNS}, count(*) OVER() AS total "
                        "FROM identity.app_user "
                        f"{where} "
                        "ORDER BY display_name, username "
                        "LIMIT :limit OFFSET :offset"
                    ),
                    params,
                )
                .mappings()
                .all()
            )
            if rows:
                total = rows[0]["total"]
            else:
                count_sql = text(f"SELECT count(*) FROM identity.app_user {where}")
                total = conn.execute(count_sql, params).scalar_one()
        return [_managed(row) for row in rows], int(total)

    def update_user(
        self,
        user_id: str,
        changes: UserChanges,
        audit: AdminAuditContext,
    ) -> ManagedUser:
        with self._engine.begin() as conn:
            organization_id = audit.organization_id or _default_organization_id(conn)
            set_tenant_context(conn, organization_id)
            current = (
                conn.execute(
                    text(
                        "SELECT id::text AS id, role, active, "
                        "store_code, store_id::text AS store_id FROM identity.app_user "
                        "WHERE id = :id AND organization_id = :organization_id FOR UPDATE"
                    ),
                    {"id": user_id, "organization_id": organization_id},
                )
                .mappings()
                .first()
            )
            if current is None:
                raise UserNotFound()

            target_role = changes.role or current["role"]
            target_store = (
                changes.store_code
                if changes.store_code is not None
                else current["store_code"]
            )
            if target_role == OPERATOR_ROLE and target_store is None:
                raise StoreRequired()
            assignment_must_be_active = (
                changes.store_code is not None
                or changes.active is True
                or changes.role == OPERATOR_ROLE
            )
            if (
                target_role == OPERATOR_ROLE
                and assignment_must_be_active
                and target_store is not None
            ):
                target_store_id = _require_active_store(
                    conn, organization_id, target_store
                )
            else:
                target_store_id = current.get("store_id")

            removes_admin_access = (
                current["role"] == ADMIN_ROLE
                and current["active"]
                and (
                    changes.active is False
                    or (changes.role is not None and changes.role != ADMIN_ROLE)
                )
            )
            if current["id"] == audit.actor_id and removes_admin_access:
                raise SelfAccessChangeNotAllowed()
            if removes_admin_access:
                active_admin_ids = (
                    conn.execute(
                        text(
                            "SELECT id FROM identity.app_user "
                            "WHERE organization_id = :organization_id "
                            "AND role = 'admin' AND active = true FOR UPDATE"
                        ),
                        {"organization_id": organization_id},
                    )
                    .scalars()
                    .all()
                )
                if len(active_admin_ids) <= 1:
                    raise LastActiveAdmin()

            assignments: list[str] = []
            params: dict[str, object] = {
                "id": user_id,
                "organization_id": organization_id,
            }
            for column, value in (
                ("display_name", changes.display_name),
                ("password_hash", changes.password_hash),
                ("role", changes.role),
                ("active", changes.active),
                ("store_code", changes.store_code),
            ):
                if value is not None:
                    assignments.append(f"{column} = :{column}")
                    params[column] = value
            assignments.append("updated_at = clock_timestamp()")
            if changes.store_code is not None:
                assignments.append("store_id = :store_id")
                params["store_id"] = target_store_id

            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action="identity.user_updated",
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            try:
                row = (
                    conn.execute(
                        text(
                            "UPDATE identity.app_user "
                            f"SET {', '.join(assignments)} "
                            "WHERE id = :id AND organization_id = :organization_id "
                            f"RETURNING {_USER_COLUMNS}"
                        ),
                        params,
                    )
                    .mappings()
                    .one()
                )
            except IntegrityError as exc:
                if _is_unique_violation(exc):
                    raise UsernameAlreadyExists() from exc
                raise
            if any(
                value is not None
                for value in (
                    changes.password_hash,
                    changes.role,
                    changes.active,
                    changes.store_code,
                )
            ):
                conn.execute(
                    text(
                        "UPDATE identity.auth_session "
                        "SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE organization_id = :organization_id AND user_id = :id"
                    ),
                    {"organization_id": organization_id, "id": user_id},
                )
        return _managed(row)
