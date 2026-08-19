"""Positive and negative proofs for the role-specific IAM surface."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.identity.adapters.http.access_router import (
    get_access_management_service,
)
from labelscan.contexts.identity.adapters.http.router import (
    get_login,
    get_session_service,
)
from labelscan.contexts.identity.adapters.sql_access_repository import (
    SqlAccessRepository,
)
from labelscan.contexts.identity.adapters.sql_session_repository import (
    SqlSessionRepository,
)
from labelscan.contexts.identity.adapters.sql_user_repository import SqlUserRepository
from labelscan.contexts.identity.application.access_management import (
    AccessManagementService,
)
from labelscan.contexts.identity.application.login import Login
from labelscan.contexts.identity.application.sessions import SessionService
from labelscan.contexts.identity.domain.password import hash_password
from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import bearer


@pytest.fixture
def iam_v2(engine):
    ids = {
        name: str(uuid.uuid4())
        for name in ("super", "admin", "store", "portal", "other")
    }
    prefix = f"iam-v2-{uuid.uuid4().hex[:8]}"
    with engine.begin() as conn:
        organization_id = str(
            conn.execute(
                text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
            ).scalar_one()
        )
        set_audit_context(
            conn,
            actor_id=ids["super"],
            action="identity.test_seeded",
            correlation_id=prefix,
            trace_id=prefix,
        )
        for user_id, role in ((ids["super"], "super_admin"), (ids["admin"], "admin")):
            conn.execute(
                text(
                    "INSERT INTO identity.app_user "
                    "(id, organization_id, organization_code, username, display_name, "
                    "password_hash, role, active, created_by) "
                    "VALUES (:id, :organization_id, 'labelscan', :username, :username, "
                    ":password_hash, :role, true, :created_by)"
                ),
                {
                    "id": user_id,
                    "organization_id": organization_id,
                    "username": f"{prefix}-{role}",
                    "password_hash": hash_password("test-password-123"),
                    "role": role,
                    "created_by": ids["super"],
                },
            )
        conn.execute(
            text(
                "INSERT INTO identity.store "
                "(id, organization_id, organization_code, code, name, created_by) "
                "VALUES (:id, :organization_id, 'labelscan', :code, 'IAM V2', :created_by)"
            ),
            {
                "id": ids["store"],
                "organization_id": organization_id,
                "code": f"IAM-{uuid.uuid4().hex[:8].upper()}",
                "created_by": ids["admin"],
            },
        )
        for portal_id, profession in (
            (ids["portal"], "poissonnerie"),
            (ids["other"], "boucherie"),
        ):
            conn.execute(
                text(
                    "INSERT INTO identity.business_portal "
                    "(id, organization_id, store_id, profession_code, name, created_by) "
                    "VALUES (:id, :organization_id, :store_id, :profession, "
                    ":profession, :created_by)"
                ),
                {
                    "id": portal_id,
                    "organization_id": organization_id,
                    "store_id": ids["store"],
                    "profession": profession,
                    "created_by": ids["super"],
                },
            )
    app = create_app()
    app.dependency_overrides[get_access_management_service] = lambda: (
        AccessManagementService(SqlAccessRepository(engine))
    )
    app.dependency_overrides[get_login] = lambda: Login(SqlUserRepository(engine))
    app.dependency_overrides[get_session_service] = lambda: SessionService(
        SqlSessionRepository(engine)
    )
    yield TestClient(app), ids, organization_id, prefix
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM identity.auth_session WHERE organization_id = :org"),
            {"org": organization_id},
        )
        conn.execute(
            text(
                "DELETE FROM identity.user_portal_assignment "
                "WHERE organization_id = :org"
            ),
            {"org": organization_id},
        )
        conn.execute(
            text(
                "DELETE FROM identity.app_user WHERE username LIKE :prefix "
                "AND role = 'manager'"
            ),
            {"prefix": f"{prefix}%"},
        )
        conn.execute(
            text("DELETE FROM identity.business_portal WHERE id IN (:portal, :other)"),
            ids,
        )
        conn.execute(text("DELETE FROM identity.store WHERE id = :store"), ids)
        conn.execute(
            text(
                "DELETE FROM identity.app_user WHERE username LIKE :prefix "
                "AND role = 'admin'"
            ),
            {"prefix": f"{prefix}%"},
        )
        conn.execute(
            text(
                "DELETE FROM identity.app_user WHERE username LIKE :prefix "
                "AND role = 'super_admin'"
            ),
            {"prefix": f"{prefix}%"},
        )


def _headers(scope: str, role: str, actor_id: str, organization_id: str):
    return bearer(
        scope,
        role=role,
        actor_id=actor_id,
        organization_id=organization_id,
        organization_slug="labelscan",
    )


def _create_manager(client, ids, organization_id, prefix, portal_ids):
    response = client.post(
        "/v1/managers",
        headers=_headers(
            "identity:managers:manage", "admin", ids["admin"], organization_id
        ),
        json={
            "username": f"{prefix}-manager-{uuid.uuid4().hex[:6]}",
            "display_name": "Scoped Manager",
            "password": "manager-password-123",
            "business_portal_ids": portal_ids,
        },
    )
    assert response.status_code == 201
    return response.json()


def test_admin_creates_active_manager_but_cannot_create_admin(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    admin_headers = _headers(
        "identity:managers:manage", "admin", ids["admin"], organization_id
    )
    forbidden = client.post(
        "/v1/admins",
        headers=admin_headers,
        json={
            "username": f"{prefix}-forbidden",
            "display_name": "Forbidden",
            "password": "forbidden-password-123",
        },
    )
    assert forbidden.status_code == 403

    manager = _create_manager(client, ids, organization_id, prefix, [ids["portal"]])
    assert manager["active"] is True
    assert manager["business_portal_ids"] == [ids["portal"]]


def test_deleted_manager_is_hidden_but_keeps_identity_and_username_is_reusable(
    iam_v2,
    engine,
):
    client, ids, organization_id, prefix = iam_v2
    headers = _headers(
        "identity:managers:manage", "admin", ids["admin"], organization_id
    )
    username = f"{prefix}-reusable-manager"
    payload = {
        "username": username,
        "display_name": "Manager historique",
        "password": "manager-password-123",
        "business_portal_ids": [ids["portal"]],
    }

    created = client.post("/v1/managers", headers=headers, json=payload)
    assert created.status_code == 201
    deleted_id = created.json()["id"]
    assert (
        client.delete(f"/v1/managers/{deleted_id}", headers=headers).status_code == 204
    )

    listed = client.get("/v1/managers", headers=headers)
    assert listed.status_code == 200
    assert deleted_id not in {manager["id"] for manager in listed.json()}
    assert (
        client.post(
            "/v1/auth/login",
            json={"username": username, "password": "manager-password-123"},
        ).status_code
        == 401
    )

    with engine.begin() as conn:
        retired = (
            conn.execute(
                text(
                    "SELECT username, display_name, active, deleted_at "
                    "FROM identity.app_user "
                    "WHERE organization_id = :organization_id AND id = :user_id"
                ),
                {"organization_id": organization_id, "user_id": deleted_id},
            )
            .mappings()
            .one()
        )
    assert retired["username"] == username
    assert retired["display_name"] == "Manager historique"
    assert retired["active"] is False
    assert retired["deleted_at"] is not None

    recreated = client.post("/v1/managers", headers=headers, json=payload)
    assert recreated.status_code == 201
    assert recreated.json()["id"] != deleted_id


def test_manager_can_use_a_simple_password_and_login_on_mobile(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    response = client.post(
        "/v1/managers",
        headers=_headers(
            "identity:managers:manage", "admin", ids["admin"], organization_id
        ),
        json={
            "username": f"{prefix}-simple-password",
            "display_name": "Scoped Manager",
            "password": "x",
            "business_portal_ids": [ids["portal"]],
        },
    )
    assert response.status_code == 201
    login = client.post(
        "/v1/mobile/auth/login",
        json={"username": response.json()["username"], "password": "x"},
    )
    assert login.status_code == 200
    assert login.json()["user"]["role"] == "manager"


def test_old_activation_routes_are_absent(iam_v2):
    client, *_ = iam_v2
    assert client.post("/v1/auth/activate", json={}).status_code == 404
    assert client.post("/v1/mobile/auth/activate", json={}).status_code == 404


def test_admin_and_manager_change_own_password_with_current_password(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    admin_headers = _headers("identity:admin", "admin", ids["admin"], organization_id)
    wrong = client.post(
        "/v1/me/password",
        headers=admin_headers,
        json={
            "current_password": "wrong-password",
            "new_password": "Admin-new-password-123!",
        },
    )
    assert wrong.status_code == 401
    changed = client.post(
        "/v1/me/password",
        headers=admin_headers,
        json={
            "current_password": "test-password-123",
            "new_password": "Admin-new-password-123!",
        },
    )
    assert changed.status_code == 200

    manager = _create_manager(client, ids, organization_id, prefix, [ids["portal"]])
    manager_headers = _headers(
        "catalog:read", "manager", manager["id"], organization_id
    )
    manager_changed = client.post(
        "/v1/me/password",
        headers=manager_headers,
        json={
            "current_password": "manager-password-123",
            "new_password": "manager2",
        },
    )
    assert manager_changed.status_code == 200
    assert (
        client.post(
            "/v1/mobile/auth/login",
            json={"username": manager["username"], "password": "manager2"},
        ).status_code
        == 200
    )


def test_super_admin_has_full_admin_and_manager_management(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    headers = _headers(
        "identity:admins:manage identity:managers:manage",
        "super_admin",
        ids["super"],
        organization_id,
    )
    admin = client.post(
        "/v1/admins",
        headers=headers,
        json={
            "username": f"{prefix}-new-admin",
            "display_name": "New Admin",
            "password": "New-admin-password-123!",
        },
    )
    assert admin.status_code == 201
    assert (
        client.delete(f"/v1/admins/{admin.json()['id']}", headers=headers).status_code
        == 204
    )

    manager = _create_manager(client, ids, organization_id, prefix, [ids["portal"]])
    assert manager["role"] == "manager"


def test_portal_deactivation_blocks_manager_login_and_refresh(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    manager = _create_manager(client, ids, organization_id, prefix, [ids["portal"]])
    logged_in = client.post(
        "/v1/mobile/auth/login",
        json={"username": manager["username"], "password": "manager-password-123"},
    )
    assert logged_in.status_code == 200
    disabled = client.put(
        f"/v1/stores/{ids['store']}/portals",
        headers=_headers(
            "identity:portals:manage", "admin", ids["admin"], organization_id
        ),
        json={"portal_id": ids["portal"], "active": False},
    )
    assert disabled.status_code == 200
    assert (
        client.post(
            "/v1/mobile/auth/login",
            json={"username": manager["username"], "password": "manager-password-123"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/v1/mobile/auth/refresh",
            json={"refresh_token": logged_in.json()["refresh_token"]},
        ).status_code
        == 401
    )


def test_me_returns_admin_owned_stores_and_scoped_access_for_manager(
    iam_v2,
):
    client, ids, organization_id, prefix = iam_v2
    admin = client.get(
        "/v1/me",
        headers=_headers("identity:read", "admin", ids["admin"], organization_id),
    )
    assert admin.status_code == 200
    assert ids["store"] in {store["id"] for store in admin.json()["stores"]}
    assert {ids["portal"], ids["other"]} <= {
        portal["id"] for portal in admin.json()["business_portals"]
    }

    super_admin = client.get(
        "/v1/me",
        headers=_headers("identity:read", "super_admin", ids["super"], organization_id),
    )
    assert "identity:admins:manage" in super_admin.json()["capabilities"]
    assert "identity:managers:manage" in super_admin.json()["capabilities"]

    manager = _create_manager(client, ids, organization_id, prefix, [ids["portal"]])
    scoped = client.get(
        "/v1/me",
        headers=_headers("identity:read", "manager", manager["id"], organization_id),
    )
    assert [portal["id"] for portal in scoped.json()["business_portals"]] == [
        ids["portal"]
    ]


def test_store_portal_updates_are_scoped_and_idempotent(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    manager = _create_manager(client, ids, organization_id, prefix, [ids["other"]])
    manager_headers = _headers(
        "identity:read", "manager", manager["id"], organization_id
    )
    scoped = client.get(f"/v1/stores/{ids['store']}/portals", headers=manager_headers)
    assert [portal["id"] for portal in scoped.json()] == [ids["other"]]
    assert (
        client.put(
            f"/v1/stores/{ids['store']}/portals",
            headers=_headers(
                "identity:portals:manage", "manager", manager["id"], organization_id
            ),
            json={"portal_id": ids["other"], "active": False},
        ).status_code
        == 403
    )

    admin_headers = _headers(
        "identity:portals:manage", "admin", ids["admin"], organization_id
    )
    for _ in range(2):
        response = client.put(
            f"/v1/stores/{ids['store']}/portals",
            headers=admin_headers,
            json={"portal_id": ids["other"], "active": False},
        )
        assert response.status_code == 200
        assert response.json()["active"] is False


def test_store_portal_contract_is_documented_in_openapi():
    operation = create_app().openapi()["paths"]["/v1/stores/{store_id}/portals"]
    assert (
        operation["get"]["summary"] == "List the business portals visible for a store"
    )
    assert operation["put"]["summary"] == "Soft-activate or deactivate a store portal"
    assert "idempotent" in operation["put"]["description"]
