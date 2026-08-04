"""PostgreSQL adapter for role-specific identity administration."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from labelscan.contexts.identity.application.access_management import (
    AccessDenied,
    AccessOverview,
    AccessRepository,
    AllowedPortal,
    AllowedStore,
    IdentityAlreadyExists,
    IdentityAudit,
    IdentityNotFound,
    InvalidActivation,
)
from labelscan.contexts.identity.domain.user import (
    ADMIN_ROLE,
    MANAGER_ROLE,
    OPERATOR_ROLE,
    SUPER_ADMIN_ROLE,
    ManagedUser,
    scopes_for_role,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context


def _managed(conn, organization_id: str, user_id: str) -> ManagedUser:
    row = (
        conn.execute(
            text(
                "SELECT id::text AS id, username, display_name, role, active, "
                "store_code, store_id::text AS store_id, "
                "organization_id::text AS organization_id, created_by::text AS created_by, "
                "created_at::text AS created_at, updated_at::text AS updated_at "
                "FROM identity.app_user WHERE organization_id = :organization_id "
                "AND id = :user_id"
            ),
            {"organization_id": organization_id, "user_id": user_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise IdentityNotFound()
    portal_ids = tuple(
        str(value)
        for value in conn.execute(
            text(
                "SELECT portal_id FROM identity.user_portal_assignment "
                "WHERE organization_id = :organization_id AND user_id = :user_id "
                "AND active = true "
                "ORDER BY created_at, portal_id"
            ),
            {"organization_id": organization_id, "user_id": user_id},
        ).scalars()
    )
    return ManagedUser(**row, business_portal_ids=portal_ids)


def _actor_role(conn, audit: IdentityAudit) -> str:
    role = conn.execute(
        text(
            "SELECT role FROM identity.app_user WHERE id = :actor_id "
            "AND organization_id = :organization_id AND active = true"
        ),
        {"actor_id": audit.actor_id, "organization_id": audit.organization_id},
    ).scalar_one_or_none()
    if role is None:
        raise AccessDenied()
    return str(role)


def _require_role(actual: str, allowed: frozenset[str]) -> None:
    if actual not in allowed:
        raise AccessDenied()


def _portal_rows(conn, organization_id: str, portal_ids: tuple[str, ...]):
    if not portal_ids:
        return []
    rows = (
        conn.execute(
            text(
                "SELECT portal.id::text AS id, portal.store_id::text AS store_id, "
                "store.code AS store_code FROM identity.business_portal AS portal "
                "JOIN identity.store AS store ON store.id = portal.store_id "
                "AND store.organization_id = portal.organization_id "
                "WHERE portal.organization_id = :organization_id "
                "AND portal.id = ANY(CAST(:portal_ids AS uuid[])) "
                "AND portal.active = true AND store.active = true"
            ),
            {"organization_id": organization_id, "portal_ids": list(portal_ids)},
        )
        .mappings()
        .all()
    )
    if {row["id"] for row in rows} != set(portal_ids):
        raise IdentityNotFound()
    return rows


def _assigned_portals(conn, organization_id: str, user_id: str) -> frozenset[str]:
    return frozenset(
        str(value)
        for value in conn.execute(
            text(
                "SELECT portal_id FROM identity.user_portal_assignment "
                "WHERE organization_id = :organization_id AND user_id = :user_id "
                "AND active = true"
            ),
            {"organization_id": organization_id, "user_id": user_id},
        ).scalars()
    )


def _revoke_sessions(conn, organization_id: str, user_id: str) -> None:
    conn.execute(
        text(
            "UPDATE identity.auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
            "WHERE organization_id = :organization_id AND user_id = :user_id"
        ),
        {"organization_id": organization_id, "user_id": user_id},
    )


def _invalidate_activation_grants(conn, organization_id: str, user_id: str) -> None:
    conn.execute(
        text(
            "UPDATE identity.account_activation SET used_at = clock_timestamp() "
            "WHERE organization_id = :organization_id AND user_id = :user_id "
            "AND used_at IS NULL"
        ),
        {"organization_id": organization_id, "user_id": user_id},
    )


_PORTAL_SELECT = (
    "SELECT portal.id::text AS id, portal.store_id::text AS store_id, "
    "store.code AS store_code, store.name AS store_name, "
    "portal.profession_code, profession.name AS profession_name, "
    "portal.name, portal.active "
    "FROM identity.business_portal AS portal "
    "JOIN identity.store AS store ON store.id = portal.store_id "
    "AND store.organization_id = portal.organization_id "
    "JOIN identity.profession AS profession ON profession.code = portal.profession_code "
)


def _allowed_portal(row) -> AllowedPortal:
    return AllowedPortal(**row)


def _organization_portals(conn, organization_id: str) -> tuple[AllowedPortal, ...]:
    rows = (
        conn.execute(
            text(
                _PORTAL_SELECT + "WHERE portal.organization_id = :organization_id "
                "ORDER BY store.code, profession.code, portal.id"
            ),
            {"organization_id": organization_id},
        )
        .mappings()
        .all()
    )
    return tuple(_allowed_portal(row) for row in rows)


def _actor_portals(
    conn, organization_id: str, actor_id: str, store_id: str | None = None
) -> tuple[AllowedPortal, ...]:
    store_filter = "AND portal.store_id = :store_id " if store_id else ""
    params = {"organization_id": organization_id, "actor_id": actor_id}
    if store_id:
        params["store_id"] = store_id
    rows = (
        conn.execute(
            text(
                _PORTAL_SELECT + "JOIN identity.user_portal_assignment AS assignment "
                "ON assignment.portal_id = portal.id "
                "AND assignment.organization_id = portal.organization_id "
                "AND assignment.user_id = :actor_id AND assignment.active = true "
                "WHERE portal.organization_id = :organization_id "
                "AND portal.active = true AND store.active = true "
                + store_filter
                + "ORDER BY store.code, profession.code, portal.id"
            ),
            params,
        )
        .mappings()
        .all()
    )
    return tuple(_allowed_portal(row) for row in rows)


def _organization_stores(conn, organization_id: str) -> tuple[AllowedStore, ...]:
    rows = (
        conn.execute(
            text(
                "SELECT id::text AS id, code, name, active FROM identity.store "
                "WHERE organization_id = :organization_id ORDER BY code, id"
            ),
            {"organization_id": organization_id},
        )
        .mappings()
        .all()
    )
    return tuple(AllowedStore(**row) for row in rows)


def _stores_from_portals(
    portals: tuple[AllowedPortal, ...],
) -> tuple[AllowedStore, ...]:
    stores: dict[str, AllowedStore] = {}
    for portal in portals:
        stores.setdefault(
            portal.store_id,
            AllowedStore(
                id=portal.store_id,
                code=portal.store_code,
                name=portal.store_name,
                active=True,
            ),
        )
    return tuple(stores.values())


class SqlAccessRepository(AccessRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def get_access_overview(self, audit: IdentityAudit) -> AccessOverview:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            actor_role = _actor_role(conn, audit)
            user = _managed(conn, audit.organization_id, audit.actor_id)
            if actor_role in {SUPER_ADMIN_ROLE, ADMIN_ROLE}:
                stores = _organization_stores(conn, audit.organization_id)
                portals = _organization_portals(conn, audit.organization_id)
            elif actor_role in {MANAGER_ROLE, OPERATOR_ROLE}:
                portals = _actor_portals(conn, audit.organization_id, audit.actor_id)
                stores = _stores_from_portals(portals)
            else:
                raise AccessDenied()
            return AccessOverview(
                user=user,
                scopes=tuple(sorted(scopes_for_role(actor_role))),
                stores=stores,
                business_portals=portals,
            )

    def list_store_portals(
        self, audit: IdentityAudit, store_id: str
    ) -> tuple[AllowedPortal, ...]:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            actor_role = _actor_role(conn, audit)
            store_exists = conn.execute(
                text(
                    "SELECT true FROM identity.store WHERE organization_id = :organization_id "
                    "AND id = :store_id"
                ),
                {"organization_id": audit.organization_id, "store_id": store_id},
            ).scalar_one_or_none()
            if store_exists is None:
                raise IdentityNotFound()
            if actor_role in {SUPER_ADMIN_ROLE, ADMIN_ROLE}:
                portals = tuple(
                    portal
                    for portal in _organization_portals(conn, audit.organization_id)
                    if portal.store_id == store_id
                )
            elif actor_role in {MANAGER_ROLE, OPERATOR_ROLE}:
                portals = _actor_portals(
                    conn, audit.organization_id, audit.actor_id, store_id
                )
                if not portals:
                    raise IdentityNotFound()
            else:
                raise AccessDenied()
            return portals

    def set_store_portal_active(
        self,
        audit: IdentityAudit,
        *,
        store_id: str,
        portal_id: str,
        active: bool,
    ) -> AllowedPortal:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            _require_role(
                _actor_role(conn, audit), frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE})
            )
            row = (
                conn.execute(
                    text(
                        _PORTAL_SELECT
                        + "WHERE portal.organization_id = :organization_id "
                        "AND portal.store_id = :store_id AND portal.id = :portal_id "
                        "FOR UPDATE OF portal"
                    ),
                    {
                        "organization_id": audit.organization_id,
                        "store_id": store_id,
                        "portal_id": portal_id,
                    },
                )
                .mappings()
                .first()
            )
            if row is None:
                raise IdentityNotFound()
            if bool(row["active"]) == active:
                return _allowed_portal(row)
            action = f"identity.store_portal_{'activated' if active else 'deactivated'}"
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE identity.business_portal SET active = :active, "
                    "updated_at = clock_timestamp() WHERE organization_id = :organization_id "
                    "AND store_id = :store_id AND id = :portal_id"
                ),
                {
                    "organization_id": audit.organization_id,
                    "store_id": store_id,
                    "portal_id": portal_id,
                    "active": active,
                },
            )
            # The 0025 portal table has no trigger of its own. Touching the
            # audited store records this configuration transition atomically.
            conn.execute(
                text(
                    "UPDATE identity.store SET updated_at = clock_timestamp() "
                    "WHERE organization_id = :organization_id AND id = :store_id"
                ),
                {"organization_id": audit.organization_id, "store_id": store_id},
            )
            if not active:
                conn.execute(
                    text(
                        "UPDATE identity.auth_session "
                        "SET revoked_at = COALESCE(revoked_at, clock_timestamp()) "
                        "WHERE organization_id = :organization_id AND user_id IN ("
                        "SELECT assignment.user_id "
                        "FROM identity.user_portal_assignment AS assignment "
                        "WHERE assignment.organization_id = :organization_id "
                        "AND assignment.portal_id = :portal_id AND assignment.active = true)"
                    ),
                    {
                        "organization_id": audit.organization_id,
                        "portal_id": portal_id,
                    },
                )
                conn.execute(
                    text(
                        "UPDATE identity.account_activation "
                        "SET used_at = clock_timestamp() "
                        "WHERE organization_id = :organization_id AND used_at IS NULL "
                        "AND user_id IN ("
                        "SELECT assignment.user_id "
                        "FROM identity.user_portal_assignment AS assignment "
                        "WHERE assignment.organization_id = :organization_id "
                        "AND assignment.portal_id = :portal_id AND assignment.active = true)"
                    ),
                    {
                        "organization_id": audit.organization_id,
                        "portal_id": portal_id,
                    },
                )
            return AllowedPortal(**{**row, "active": active})

    def list_role(
        self, audit: IdentityAudit, role: str, portal_id: str | None = None
    ) -> list[ManagedUser]:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            actor_role = _actor_role(conn, audit)
            params: dict[str, object] = {
                "organization_id": audit.organization_id,
                "role": role,
            }
            if role == ADMIN_ROLE:
                _require_role(actor_role, frozenset({SUPER_ADMIN_ROLE}))
            elif role == MANAGER_ROLE:
                _require_role(actor_role, frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}))
            elif role == OPERATOR_ROLE:
                _require_role(actor_role, frozenset({MANAGER_ROLE}))
                if not portal_id or portal_id not in _assigned_portals(
                    conn, audit.organization_id, audit.actor_id
                ):
                    raise AccessDenied()
                params["portal_id"] = portal_id
            else:
                raise AccessDenied()
            if role == OPERATOR_ROLE:
                sql = text(
                    "SELECT DISTINCT account.id::text FROM identity.app_user AS account "
                    "JOIN identity.user_portal_assignment AS assignment "
                    "ON assignment.user_id = account.id "
                    "AND assignment.organization_id = account.organization_id "
                    "AND assignment.active = true "
                    "WHERE account.organization_id = :organization_id "
                    "AND account.role = :role AND assignment.portal_id = :portal_id "
                    "ORDER BY account.id::text"
                )
            else:
                sql = text(
                    "SELECT account.id::text FROM identity.app_user AS account "
                    "WHERE account.organization_id = :organization_id "
                    "AND account.role = :role ORDER BY account.id::text"
                )
            ids = conn.execute(sql, params).scalars()
            return [_managed(conn, audit.organization_id, value) for value in ids]

    def create_pending(
        self,
        audit: IdentityAudit,
        *,
        actor_roles: frozenset[str],
        username: str,
        display_name: str,
        role: str,
        portal_ids: tuple[str, ...],
        placeholder_password_hash: str,
        activation_token_hash: str,
        expires_at: datetime,
    ) -> ManagedUser:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            actor_role = _actor_role(conn, audit)
            _require_role(actor_role, actor_roles)
            if role == ADMIN_ROLE:
                _require_role(actor_role, frozenset({SUPER_ADMIN_ROLE}))
                if portal_ids:
                    raise ValueError("administrators cannot have portal assignments")
            elif role == MANAGER_ROLE:
                _require_role(actor_role, frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}))
                if not portal_ids:
                    raise ValueError("a manager requires at least one portal")
            elif role == OPERATOR_ROLE:
                _require_role(actor_role, frozenset({MANAGER_ROLE}))
                if len(portal_ids) != 1:
                    raise ValueError("an operator requires exactly one portal")
                if not set(portal_ids) <= _assigned_portals(
                    conn, audit.organization_id, audit.actor_id
                ):
                    raise AccessDenied()
            else:
                raise AccessDenied()
            portals = _portal_rows(conn, audit.organization_id, portal_ids)
            user_id = str(uuid.uuid4())
            store_id = portals[0]["store_id"] if role == OPERATOR_ROLE else None
            store_code = portals[0]["store_code"] if role == OPERATOR_ROLE else None
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=f"identity.{role}_invited",
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            try:
                conn.execute(
                    text(
                        "INSERT INTO identity.app_user "
                        "(id, organization_id, organization_code, username, display_name, "
                        "password_hash, role, active, store_id, store_code, created_by) "
                        "VALUES (:id, :organization_id, "
                        "(SELECT slug FROM identity.organization WHERE id = :organization_id), "
                        ":username, :display_name, :password_hash, :role, false, "
                        ":store_id, :store_code, :created_by)"
                    ),
                    {
                        "id": user_id,
                        "organization_id": audit.organization_id,
                        "username": username,
                        "display_name": display_name,
                        "password_hash": placeholder_password_hash,
                        "role": role,
                        "store_id": store_id,
                        "store_code": store_code,
                        "created_by": audit.actor_id,
                    },
                )
            except IntegrityError as exc:
                if getattr(exc.orig, "sqlstate", None) == "23505":
                    raise IdentityAlreadyExists() from exc
                raise
            for portal_id in portal_ids:
                conn.execute(
                    text(
                        "INSERT INTO identity.user_portal_assignment "
                        "(organization_id, user_id, portal_id, created_by) "
                        "VALUES (:organization_id, :user_id, :portal_id, :created_by)"
                    ),
                    {
                        "organization_id": audit.organization_id,
                        "user_id": user_id,
                        "portal_id": portal_id,
                        "created_by": audit.actor_id,
                    },
                )
            conn.execute(
                text(
                    "INSERT INTO identity.account_activation "
                    "(organization_id, user_id, token_hash, purpose, expires_at, created_by) "
                    "VALUES (:organization_id, :user_id, :token_hash, 'initial', "
                    ":expires_at, :created_by)"
                ),
                {
                    "organization_id": audit.organization_id,
                    "user_id": user_id,
                    "token_hash": activation_token_hash,
                    "expires_at": expires_at,
                    "created_by": audit.actor_id,
                },
            )
            return _managed(conn, audit.organization_id, user_id)

    def replace_assignments(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        target_role: str,
        portal_ids: tuple[str, ...],
        actor_roles: frozenset[str],
    ) -> ManagedUser:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            actor_role = _actor_role(conn, audit)
            _require_role(actor_role, actor_roles)
            target = _managed(conn, audit.organization_id, target_user_id)
            if target.role != target_role:
                raise IdentityNotFound()
            if target_role == MANAGER_ROLE:
                _require_role(actor_role, frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}))
                if not portal_ids:
                    raise ValueError("a manager requires at least one portal")
            elif target_role == OPERATOR_ROLE:
                _require_role(actor_role, frozenset({MANAGER_ROLE}))
                if len(portal_ids) != 1 or not set(portal_ids) <= _assigned_portals(
                    conn, audit.organization_id, audit.actor_id
                ):
                    raise AccessDenied()
                if not set(target.business_portal_ids) <= _assigned_portals(
                    conn, audit.organization_id, audit.actor_id
                ):
                    raise IdentityNotFound()
            else:
                raise AccessDenied()
            portals = _portal_rows(conn, audit.organization_id, portal_ids)
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=f"identity.{target_role}_portals_changed",
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE identity.user_portal_assignment SET active = false, "
                    "updated_at = clock_timestamp() "
                    "WHERE organization_id = :organization_id AND user_id = :user_id "
                    "AND active = true"
                ),
                {"organization_id": audit.organization_id, "user_id": target_user_id},
            )
            for portal_id in portal_ids:
                conn.execute(
                    text(
                        "INSERT INTO identity.user_portal_assignment "
                        "(organization_id, user_id, portal_id, created_by) "
                        "VALUES (:organization_id, :user_id, :portal_id, :created_by) "
                        "ON CONFLICT (user_id, portal_id) DO UPDATE "
                        "SET active = true, updated_at = clock_timestamp()"
                    ),
                    {
                        "organization_id": audit.organization_id,
                        "user_id": target_user_id,
                        "portal_id": portal_id,
                        "created_by": audit.actor_id,
                    },
                )
            if target_role == OPERATOR_ROLE:
                conn.execute(
                    text(
                        "UPDATE identity.app_user SET store_id = :store_id, "
                        "store_code = :store_code, updated_at = clock_timestamp() "
                        "WHERE organization_id = :organization_id AND id = :user_id"
                    ),
                    {
                        "organization_id": audit.organization_id,
                        "user_id": target_user_id,
                        "store_id": portals[0]["store_id"],
                        "store_code": portals[0]["store_code"],
                    },
                )
            _invalidate_activation_grants(conn, audit.organization_id, target_user_id)
            _revoke_sessions(conn, audit.organization_id, target_user_id)
            return _managed(conn, audit.organization_id, target_user_id)

    def set_active(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        target_role: str,
        active: bool,
        actor_roles: frozenset[str],
    ) -> ManagedUser:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            actor_role = _actor_role(conn, audit)
            _require_role(actor_role, actor_roles)
            target = _managed(conn, audit.organization_id, target_user_id)
            if target.role != target_role:
                raise IdentityNotFound()
            if target_role == ADMIN_ROLE:
                _require_role(actor_role, frozenset({SUPER_ADMIN_ROLE}))
            elif target_role == MANAGER_ROLE:
                _require_role(actor_role, frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}))
            elif target_role == OPERATOR_ROLE:
                _require_role(actor_role, frozenset({MANAGER_ROLE}))
                if len(target.business_portal_ids) != 1 or not set(
                    target.business_portal_ids
                ) <= _assigned_portals(conn, audit.organization_id, audit.actor_id):
                    raise IdentityNotFound()
                if active:
                    _portal_rows(
                        conn,
                        audit.organization_id,
                        tuple(target.business_portal_ids),
                    )
            else:
                raise AccessDenied()
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=f"identity.{target_role}_{'activated' if active else 'deleted'}",
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE identity.app_user SET active = :active, "
                    "updated_at = clock_timestamp() WHERE organization_id = :organization_id "
                    "AND id = :user_id"
                ),
                {
                    "organization_id": audit.organization_id,
                    "user_id": target_user_id,
                    "active": active,
                },
            )
            if not active:
                _invalidate_activation_grants(
                    conn, audit.organization_id, target_user_id
                )
            _revoke_sessions(conn, audit.organization_id, target_user_id)
            return _managed(conn, audit.organization_id, target_user_id)

    def issue_reset(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        placeholder_password_hash: str,
        activation_token_hash: str,
        expires_at: datetime,
    ) -> ManagedUser:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            _require_role(_actor_role(conn, audit), frozenset({MANAGER_ROLE}))
            target = _managed(conn, audit.organization_id, target_user_id)
            if (
                target.role != OPERATOR_ROLE
                or not target.active
                or len(target.business_portal_ids) != 1
                or not set(target.business_portal_ids)
                <= _assigned_portals(conn, audit.organization_id, audit.actor_id)
            ):
                raise IdentityNotFound()
            _portal_rows(conn, audit.organization_id, tuple(target.business_portal_ids))
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action="identity.operator_credential_reset",
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE identity.app_user SET password_hash = :password_hash, "
                    "updated_at = clock_timestamp() WHERE organization_id = :organization_id "
                    "AND id = :user_id"
                ),
                {
                    "organization_id": audit.organization_id,
                    "user_id": target_user_id,
                    "password_hash": placeholder_password_hash,
                },
            )
            _invalidate_activation_grants(conn, audit.organization_id, target_user_id)
            conn.execute(
                text(
                    "INSERT INTO identity.account_activation "
                    "(organization_id, user_id, token_hash, purpose, expires_at, created_by) "
                    "VALUES (:organization_id, :user_id, :token_hash, 'credential_reset', "
                    ":expires_at, :created_by)"
                ),
                {
                    "organization_id": audit.organization_id,
                    "user_id": target_user_id,
                    "token_hash": activation_token_hash,
                    "expires_at": expires_at,
                    "created_by": audit.actor_id,
                },
            )
            _revoke_sessions(conn, audit.organization_id, target_user_id)
            return _managed(conn, audit.organization_id, target_user_id)

    def activate(
        self,
        token_hash: str,
        password_hash: str,
        expected_role: str | None = None,
    ) -> ManagedUser:
        with self._engine.begin() as conn:
            organization_id = conn.execute(
                text(
                    "SELECT identity.account_activation_organization_for_token("
                    ":token_hash)::text"
                ),
                {"token_hash": token_hash},
            ).scalar_one_or_none()
            if organization_id is None:
                raise InvalidActivation()
            set_tenant_context(conn, organization_id)
            activation = (
                conn.execute(
                    text(
                        "SELECT id::text AS id, organization_id::text AS organization_id, "
                        "user_id::text AS user_id, purpose, expires_at, used_at "
                        "FROM identity.account_activation WHERE token_hash = :token_hash "
                        "AND organization_id = :organization_id "
                        "FOR UPDATE"
                    ),
                    {
                        "token_hash": token_hash,
                        "organization_id": organization_id,
                    },
                )
                .mappings()
                .first()
            )
            if activation is None or activation["used_at"] is not None:
                raise InvalidActivation()
            user = (
                conn.execute(
                    text(
                        "SELECT account.role, account.active, "
                        "account.store_id::text AS store_id, account.store_code "
                        "FROM identity.app_user AS account "
                        "JOIN identity.organization AS organization "
                        "ON organization.id = account.organization_id "
                        "WHERE account.organization_id = :organization_id "
                        "AND account.id = :user_id AND organization.active = true "
                        "FOR UPDATE OF account"
                    ),
                    {
                        "organization_id": activation["organization_id"],
                        "user_id": activation["user_id"],
                    },
                )
                .mappings()
                .first()
            )
            if user is None or user["role"] not in {
                ADMIN_ROLE,
                MANAGER_ROLE,
                OPERATOR_ROLE,
            }:
                raise InvalidActivation()
            if expected_role is not None and user["role"] != expected_role:
                raise InvalidActivation()
            if activation["purpose"] == "initial":
                if user["active"]:
                    raise InvalidActivation()
            elif activation["purpose"] == "credential_reset":
                if not user["active"]:
                    raise InvalidActivation()
            else:
                raise InvalidActivation()
            if user["role"] in {MANAGER_ROLE, OPERATOR_ROLE}:
                assignments = (
                    conn.execute(
                        text(
                            "SELECT portal.id::text AS portal_id, "
                            "portal.store_id::text AS store_id, store.code AS store_code "
                            "FROM identity.user_portal_assignment AS assignment "
                            "JOIN identity.business_portal AS portal "
                            "ON portal.id = assignment.portal_id "
                            "AND portal.organization_id = assignment.organization_id "
                            "JOIN identity.store AS store ON store.id = portal.store_id "
                            "AND store.organization_id = portal.organization_id "
                            "WHERE assignment.organization_id = :organization_id "
                            "AND assignment.user_id = :user_id "
                            "AND assignment.active = true AND portal.active = true "
                            "AND store.active = true ORDER BY assignment.created_at, portal.id"
                        ),
                        {
                            "organization_id": activation["organization_id"],
                            "user_id": activation["user_id"],
                        },
                    )
                    .mappings()
                    .all()
                )
                if not assignments:
                    raise InvalidActivation()
                if user["role"] == OPERATOR_ROLE and (
                    len(assignments) != 1
                    or user["store_id"] != assignments[0]["store_id"]
                    or user["store_code"] != assignments[0]["store_code"]
                ):
                    raise InvalidActivation()
            if not conn.execute(
                text("SELECT :expires_at > clock_timestamp()"),
                {"expires_at": activation["expires_at"]},
            ).scalar_one():
                raise InvalidActivation()
            set_audit_context(
                conn,
                actor_id=activation["user_id"],
                action="identity.account_activated",
                correlation_id=f"activation-{activation['id']}",
                trace_id=f"activation-{activation['id']}",
            )
            updated = conn.execute(
                text(
                    "UPDATE identity.app_user SET password_hash = :password_hash, "
                    "active = CASE WHEN :purpose = 'initial' THEN true ELSE active END, "
                    "updated_at = clock_timestamp() "
                    "WHERE organization_id = :organization_id AND id = :user_id "
                    "AND ((:purpose = 'initial' AND active = false) "
                    "OR (:purpose = 'credential_reset' AND active = true)) "
                    "RETURNING id::text"
                ),
                {
                    "organization_id": activation["organization_id"],
                    "user_id": activation["user_id"],
                    "password_hash": password_hash,
                    "purpose": activation["purpose"],
                },
            ).scalar_one_or_none()
            if updated is None:
                raise InvalidActivation()
            _invalidate_activation_grants(
                conn, activation["organization_id"], activation["user_id"]
            )
            _revoke_sessions(conn, activation["organization_id"], activation["user_id"])
            return _managed(conn, activation["organization_id"], activation["user_id"])

    def change_own_password(
        self, audit: IdentityAudit, password_hash: str
    ) -> ManagedUser:
        with self._engine.begin() as conn:
            set_tenant_context(conn, audit.organization_id)
            _actor_role(conn, audit)
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action="identity.password_changed",
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE identity.app_user SET password_hash = :password_hash, "
                    "updated_at = clock_timestamp() WHERE organization_id = :organization_id "
                    "AND id = :user_id"
                ),
                {
                    "organization_id": audit.organization_id,
                    "user_id": audit.actor_id,
                    "password_hash": password_hash,
                },
            )
            _invalidate_activation_grants(conn, audit.organization_id, audit.actor_id)
            _revoke_sessions(conn, audit.organization_id, audit.actor_id)
            return _managed(conn, audit.organization_id, audit.actor_id)
