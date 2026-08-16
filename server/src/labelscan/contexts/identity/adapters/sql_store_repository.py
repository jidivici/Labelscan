"""PostgreSQL adapter for the audited store directory."""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from labelscan.contexts.identity.application.store_ports import (
    NewStore,
    StoreAlreadyExists,
    StoreAuditContext,
    StoreChanges,
    StoreInUse,
    StoreNotFound,
    StoreRepository,
)
from labelscan.contexts.identity.domain.store import Store
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context

_STORE_COLUMNS = (
    "id::text AS id, code, name, active, "
    "organization_id::text AS organization_id, "
    "created_by::text AS created_by, created_at::text AS created_at, "
    "updated_at::text AS updated_at"
)


def _store(row) -> Store:
    return Store(
        id=row["id"],
        code=row["code"],
        name=row["name"],
        active=row["active"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        organization_id=row["organization_id"],
    )


def _is_unique_violation(exc: IntegrityError) -> bool:
    return getattr(exc.orig, "sqlstate", None) == "23505"


def _default_organization_id(conn) -> str:
    return str(
        conn.execute(
            text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
        ).scalar_one()
    )


class SqlStoreRepository(StoreRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def create_store(self, store: NewStore, audit: StoreAuditContext) -> Store:
        try:
            with self._engine.begin() as conn:
                organization_id = audit.organization_id or _default_organization_id(
                    conn
                )
                set_tenant_context(conn, organization_id)
                set_audit_context(
                    conn,
                    actor_id=audit.actor_id,
                    action="identity.store_created",
                    correlation_id=audit.correlation_id,
                    trace_id=audit.trace_id,
                )
                row = (
                    conn.execute(
                        text(
                            "INSERT INTO identity.store "
                            "(id, organization_id, organization_code, code, "
                            "name, created_by) "
                            "VALUES (:id, :organization_id, "
                            "(SELECT slug FROM identity.organization "
                            "WHERE id = :organization_id), "
                            ":code, :name, :created_by) "
                            f"RETURNING {_STORE_COLUMNS}"
                        ),
                        {
                            "id": str(uuid.uuid4()),
                            "code": store.code,
                            "name": store.name,
                            "created_by": store.created_by,
                            "organization_id": organization_id,
                        },
                    )
                    .mappings()
                    .one()
                )
                available_professions = set(
                    conn.execute(
                        text(
                            "SELECT code FROM identity.profession "
                            "WHERE active = true"
                        )
                    ).scalars()
                )
                unknown_professions = set(store.profession_codes) - available_professions
                if unknown_professions:
                    raise ValueError("un ou plusieurs métiers sont invalides")
                # Every newly-created store receives the same three versioned
                # business portals as stores backfilled by migration 0025. Portal
                # availability can then be managed idempotently through the IAM API;
                # no later request has to manufacture ownership rows implicitly.
                conn.execute(
                    text(
                        "INSERT INTO identity.business_portal "
                        "(organization_id, store_id, profession_code, name, active, "
                        "created_by) "
                        "SELECT :organization_id, :store_id, profession.code, "
                        "profession.name, "
                        "profession.code = ANY(CAST(:profession_codes AS text[])), "
                        ":created_by "
                        "FROM identity.profession AS profession "
                        "WHERE profession.active = true"
                    ),
                    {
                        "organization_id": organization_id,
                        "store_id": row["id"],
                        "created_by": store.created_by,
                        "profession_codes": list(store.profession_codes),
                    },
                )
        except IntegrityError as exc:
            if _is_unique_violation(exc):
                raise StoreAlreadyExists() from exc
            raise
        return _store(row)

    def list_stores(
        self,
        *,
        organization_id: str | None = None,
        active: bool | None,
        query: str | None,
        actor_id: str | None = None,
        include_all: bool = False,
    ) -> list[Store]:
        conditions: list[str] = []
        params: dict[str, object] = {}
        if active is not None:
            conditions.append("active = :active")
            params["active"] = active
        if query is not None:
            conditions.append("(code ILIKE :query OR name ILIKE :query)")
            params["query"] = f"%{query}%"
        if not include_all:
            if not actor_id:
                return []
            conditions.append("created_by = :actor_id")
            params["actor_id"] = actor_id
        with self._engine.begin() as conn:
            organization_id = organization_id or _default_organization_id(conn)
            set_tenant_context(conn, organization_id)
            conditions.insert(0, "organization_id = :organization_id")
            params["organization_id"] = organization_id
            where = f"WHERE {' AND '.join(conditions)}"
            rows = (
                conn.execute(
                    text(
                        f"SELECT {_STORE_COLUMNS} FROM identity.store "
                        f"{where} ORDER BY active DESC, code"
                    ),
                    params,
                )
                .mappings()
                .all()
            )
        return [_store(row) for row in rows]

    def update_store(
        self,
        code: str,
        changes: StoreChanges,
        audit: StoreAuditContext,
    ) -> Store:
        with self._engine.begin() as conn:
            organization_id = audit.organization_id or _default_organization_id(conn)
            set_tenant_context(conn, organization_id)
            current = (
                conn.execute(
                    text(
                        "SELECT id::text AS id, active "
                        "FROM identity.store WHERE organization_id = :organization_id "
                        "AND code = :code AND (:manage_all OR created_by = :actor_id) "
                        "FOR UPDATE"
                    ),
                    {
                        "organization_id": organization_id,
                        "code": code,
                        "manage_all": audit.manage_all_stores,
                        "actor_id": audit.actor_id,
                    },
                )
                .mappings()
                .first()
            )
            if current is None:
                raise StoreNotFound()
            if current["active"] and changes.active is False:
                active_users = conn.execute(
                    text(
                        "SELECT 1 FROM identity.app_user AS app_user "
                        "WHERE app_user.organization_id = :organization_id "
                        "AND app_user.active = true AND ("
                        "app_user.store_id = CAST(:store_id AS uuid) "
                        "OR app_user.store_code = :code "
                        "OR EXISTS ("
                        "SELECT 1 FROM identity.user_portal_assignment AS assignment "
                        "JOIN identity.business_portal AS portal "
                        "ON portal.organization_id = assignment.organization_id "
                        "AND portal.id = assignment.portal_id "
                        "WHERE assignment.organization_id = :organization_id "
                        "AND assignment.user_id = app_user.id "
                        "AND assignment.active = true "
                        "AND portal.active = true "
                        "AND portal.store_id = CAST(:store_id AS uuid)"
                        ")"
                        ") LIMIT 1"
                    ),
                    {
                        "organization_id": organization_id,
                        "store_id": current["id"],
                        "code": code,
                    },
                ).first()
                if active_users is not None:
                    raise StoreInUse()

            assignments: list[str] = []
            params: dict[str, object] = {
                "organization_id": organization_id,
                "code": code,
            }
            for column, value in (
                ("name", changes.name),
                ("active", changes.active),
            ):
                if value is not None:
                    assignments.append(f"{column} = :{column}")
                    params[column] = value
            assignments.append("updated_at = clock_timestamp()")

            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action="identity.store_updated",
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            row = (
                conn.execute(
                    text(
                        "UPDATE identity.store "
                        f"SET {', '.join(assignments)} "
                        "WHERE organization_id = :organization_id AND code = :code "
                        f"RETURNING {_STORE_COLUMNS}"
                    ),
                    params,
                )
                .mappings()
                .one()
            )
        return _store(row)
