"""HTTP/DB proofs for the back-office user administration API."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.identity.adapters.cli import upsert_admin
from labelscan.contexts.identity.adapters.http.admin_router import (
    get_user_admin_service,
)
from labelscan.contexts.identity.adapters.http.router import get_login
from labelscan.contexts.identity.adapters.http.store_admin_router import (
    get_store_admin_service,
)
from labelscan.contexts.identity.adapters.sql_store_repository import (
    SqlStoreRepository,
)
from labelscan.contexts.identity.adapters.sql_user_repository import SqlUserRepository
from labelscan.contexts.identity.application.login import Login
from labelscan.contexts.identity.application.manage_stores import StoreAdminService
from labelscan.contexts.identity.application.manage_users import UserAdminService
from labelscan.contexts.identity.domain.password import hash_password
from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import bearer

ADMIN_ID = "33333333-3333-3333-3333-333333333333"
ADMIN_USERNAME = "backoffice-admin-test"
PASSWORD = "admin-password-123"
PREFIX = "rbac-http-test-"
STORE_CODE = "TEST-MAG-01"


def _clear_seeded_identity(conn) -> None:
    # A previously interrupted test may have turned the seeded administrator
    # into an operator assigned to its own store, creating a temporary FK cycle.
    # Normalize that row first so cleanup is repeatable after any interruption.
    set_audit_context(
        conn,
        actor_id=ADMIN_ID,
        action="identity.test_fixture_cleaned",
        correlation_id="user-admin-test",
        trace_id="user-admin-test",
    )
    conn.execute(
        text(
            "UPDATE identity.app_user "
            "SET role = 'admin', active = true, store_code = NULL "
            "WHERE username = :admin"
        ),
        {"admin": ADMIN_USERNAME},
    )
    conn.execute(
        text(
            "DELETE FROM identity.app_user "
            "WHERE username <> :admin "
            "AND (username LIKE :prefix OR store_code LIKE 'TEST-MAG-%')"
        ),
        {"prefix": f"{PREFIX}%", "admin": ADMIN_USERNAME},
    )
    conn.execute(
        text(
            "DELETE FROM identity.store "
            "WHERE code LIKE 'TEST-MAG-%' "
            "OR created_by = ("
            "SELECT id FROM identity.app_user WHERE username = :admin"
            ")"
        ),
        {"admin": ADMIN_USERNAME},
    )
    conn.execute(
        text("DELETE FROM identity.app_user WHERE username = :admin"),
        {"admin": ADMIN_USERNAME},
    )


@pytest.fixture
def seeded_admin(engine):
    with engine.begin() as conn:
        _clear_seeded_identity(conn)
        set_audit_context(
            conn,
            actor_id=ADMIN_ID,
            action="identity.test_admin_created",
            correlation_id="user-admin-test",
            trace_id="user-admin-test",
        )
        conn.execute(
            text(
                "INSERT INTO identity.app_user "
                "(id, username, display_name, password_hash, role, active, created_by) "
                "VALUES (:id, :username, 'Backoffice Admin', :password_hash, "
                "'admin', true, :id)"
            ),
            {
                "id": ADMIN_ID,
                "username": ADMIN_USERNAME,
                "password_hash": hash_password(PASSWORD),
            },
        )
        set_audit_context(
            conn,
            actor_id=ADMIN_ID,
            action="identity.test_store_created",
            correlation_id="user-admin-test",
            trace_id="user-admin-test",
        )
        conn.execute(
            text(
                "INSERT INTO identity.store "
                "(id, code, name, created_by) "
                "VALUES (:id, :code, 'Test Store', :admin_id)"
            ),
            {
                "id": str(uuid.uuid4()),
                "code": STORE_CODE,
                "admin_id": ADMIN_ID,
            },
        )
    yield
    with engine.begin() as conn:
        _clear_seeded_identity(conn)


@pytest.fixture
def client(engine, seeded_admin):
    repo = SqlUserRepository(engine)
    store_repo = SqlStoreRepository(engine)
    app = create_app()
    app.dependency_overrides[get_user_admin_service] = lambda: UserAdminService(repo)
    app.dependency_overrides[get_store_admin_service] = lambda: StoreAdminService(
        store_repo
    )
    app.dependency_overrides[get_login] = lambda: Login(repo)
    return TestClient(app)


def _admin_headers(actor_id: str = ADMIN_ID):
    return bearer(
        "identity:admin",
        actor_id=actor_id,
        principal=ADMIN_USERNAME,
    )


def _create(client, suffix: str = "operator", role: str = "operator"):
    return client.post(
        "/v1/users",
        headers=_admin_headers(),
        json={
            "username": f"{PREFIX}{suffix}",
            "display_name": f"Test {suffix}",
            "password": "operator-password-123",
            "role": role,
            "store_code": STORE_CODE,
        },
    )


def test_admin_can_create_list_and_filter_users(client):
    created = _create(client)
    assert created.status_code == 201
    body = created.json()
    assert body["username"] == f"{PREFIX}operator"
    assert body["role"] == "operator"
    assert body["store_code"] == STORE_CODE
    assert body["active"] is True
    assert "password" not in body and "password_hash" not in body

    listed = client.get(
        "/v1/users",
        headers=_admin_headers(),
        params={
            "role": "operator",
            "active": "true",
            "store_code": STORE_CODE,
            "q": PREFIX,
        },
    )
    assert listed.status_code == 200
    page = listed.json()
    assert page["total"] == 1
    assert [item["id"] for item in page["items"]] == [body["id"]]


def test_non_admin_cannot_manage_users(client):
    response = client.get(
        "/v1/users",
        headers=bearer(
            "ingestion:write ingestion:read extraction:review",
            principal="operator",
        ),
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "FORBIDDEN"


def test_duplicate_username_returns_stable_conflict(client):
    assert _create(client, "duplicate").status_code == 201
    response = _create(client, "duplicate")
    assert response.status_code == 409
    assert response.json()["error_code"] == "USER_ALREADY_EXISTS"


def test_username_and_password_have_no_artificial_length_limit(client):
    username = f"{PREFIX}{'x' * 600}"
    response = client.post(
        "/v1/users",
        headers=_admin_headers(),
        json={
            "username": username,
            "display_name": "Long credentials",
            "password": "x",
            "role": "operator",
            "store_code": STORE_CODE,
        },
    )
    assert response.status_code == 201
    assert response.json()["username"] == username


def test_admin_can_create_list_and_rename_stores(client):
    created = client.post(
        "/v1/stores",
        headers=_admin_headers(),
        json={"code": "test-mag-02", "name": "Deuxième magasin"},
    )
    assert created.status_code == 201
    assert created.json()["code"] == "TEST-MAG-02"

    listed = client.get("/v1/stores", headers=_admin_headers())
    assert listed.status_code == 200
    assert {store["code"] for store in listed.json()} >= {
        STORE_CODE,
        "TEST-MAG-02",
    }

    renamed = client.patch(
        "/v1/stores/TEST-MAG-02",
        headers=_admin_headers(),
        json={"name": "Magasin renommé"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Magasin renommé"


def test_portal_store_creation_and_operator_store_label_hide_internal_code(client):
    created = client.post(
        "/v1/stores",
        headers=_admin_headers(),
        json={"name": "Magasin du port"},
    )
    assert created.status_code == 201
    assert created.json()["name"] == "Magasin du port"
    assert created.json()["code"].startswith("STORE-")

    current = client.get(
        "/v1/stores/current",
        headers=bearer(
            "catalog:read",
            principal="operator",
            role="operator",
            store_code=STORE_CODE,
        ),
    )
    assert current.status_code == 200
    assert current.json() == {"name": "Test Store"}


def test_store_with_active_users_cannot_be_disabled(client):
    assert _create(client, "store-user").status_code == 201
    response = client.patch(
        f"/v1/stores/{STORE_CODE}",
        headers=_admin_headers(),
        json={"active": False},
    )
    assert response.status_code == 409
    assert response.json()["error_code"] == "STORE_IN_USE"


def test_delete_user_is_a_recoverable_soft_delete(client):
    user_id = _create(client, "deleted").json()["id"]
    deleted = client.delete(
        f"/v1/users/{user_id}",
        headers=_admin_headers(),
    )
    assert deleted.status_code == 204

    listed = client.get(
        "/v1/users",
        headers=_admin_headers(),
        params={"active": "false", "q": f"{PREFIX}deleted"},
    )
    assert listed.status_code == 200
    assert listed.json()["items"][0]["id"] == user_id


def test_admin_can_change_role_deactivate_and_reset_password(client):
    user_id = _create(client, "mutable").json()["id"]
    response = client.patch(
        f"/v1/users/{user_id}",
        headers=_admin_headers(),
        json={
            "display_name": "Operator Mutable",
            "role": "operator",
            "active": False,
            "password": "replacement-password-123",
        },
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "Operator Mutable"
    assert response.json()["role"] == "operator"
    assert response.json()["active"] is False

    # A deactivated account cannot use even its newly reset credentials.
    login = client.post(
        "/v1/auth/login",
        json={
            "username": f"{PREFIX}mutable",
            "password": "replacement-password-123",
        },
    )
    assert login.status_code == 401


def test_create_and_update_are_audited_with_admin_actor(client, engine):
    created = _create(client, "audited").json()
    client.patch(
        f"/v1/users/{created['id']}",
        headers=_admin_headers(),
        json={"display_name": "Audited User"},
    )
    with engine.connect() as conn:
        rows = (
            conn.execute(
                text(
                    "SELECT actor_id::text AS actor_id, action "
                    "FROM audit.audit_log "
                    "WHERE subject_schema = 'identity' "
                    "AND subject_table = 'app_user' AND subject_id = :id "
                    "ORDER BY occurred_at"
                ),
                {"id": created["id"]},
            )
            .mappings()
            .all()
        )
    assert [row["action"] for row in rows] == [
        "identity.user_created",
        "identity.user_updated",
    ]
    assert {row["actor_id"] for row in rows} == {ADMIN_ID}


def test_admin_cannot_revoke_own_access(client):
    response = client.patch(
        f"/v1/users/{ADMIN_ID}",
        headers=_admin_headers(),
        json={"active": False},
    )
    assert response.status_code == 409
    assert response.json()["error_code"] == "SELF_ACCESS_CHANGE_NOT_ALLOWED"


def test_last_active_admin_cannot_be_removed_by_another_principal(client, engine):
    with engine.begin() as conn:
        set_audit_context(
            conn,
            actor_id=ADMIN_ID,
            action="identity.test_admin_isolated",
            correlation_id="user-admin-test",
            trace_id="user-admin-test",
        )
        other_admin_ids = (
            conn.execute(
                text(
                    "UPDATE identity.app_user SET active = false "
                    "WHERE role = 'admin' AND active = true AND id <> :id "
                    "RETURNING id::text"
                ),
                {"id": ADMIN_ID},
            )
            .scalars()
            .all()
        )
    try:
        response = client.patch(
            f"/v1/users/{ADMIN_ID}",
            headers=_admin_headers(actor_id=str(uuid.uuid4())),
            json={"role": "operator", "store_code": STORE_CODE},
        )
    finally:
        if other_admin_ids:
            with engine.begin() as conn:
                set_audit_context(
                    conn,
                    actor_id=ADMIN_ID,
                    action="identity.test_admin_restored",
                    correlation_id="user-admin-test",
                    trace_id="user-admin-test",
                )
                conn.execute(
                    text(
                        "UPDATE identity.app_user SET active = true "
                        "WHERE id::text = ANY(:ids)"
                    ),
                    {"ids": other_admin_ids},
                )
    assert response.status_code == 409
    assert response.json()["error_code"] == "LAST_ACTIVE_ADMIN"


def test_unknown_and_malformed_user_ids_are_safe_errors(client):
    missing = client.patch(
        f"/v1/users/{uuid.uuid4()}",
        headers=_admin_headers(),
        json={"display_name": "Nobody"},
    )
    assert missing.status_code == 404
    assert missing.json()["error_code"] == "NOT_FOUND"

    malformed = client.patch(
        "/v1/users/not-a-uuid",
        headers=_admin_headers(),
        json={"display_name": "Nobody"},
    )
    assert malformed.status_code == 400
    assert malformed.json()["error_code"] == "VALIDATION_ERROR"


def test_cli_bootstrap_remains_idempotent_and_audited(client, engine):
    username = f"{PREFIX}cli-admin"
    first_id = upsert_admin(username, "bootstrap-password-123")
    second_id = upsert_admin(username, "rotated-bootstrap-password-123")
    assert second_id == first_id

    login = client.post(
        "/v1/auth/login",
        json={
            "username": username,
            "password": "rotated-bootstrap-password-123",
        },
    )
    assert login.status_code == 200
    assert login.json()["user"]["role"] == "admin"

    with engine.connect() as conn:
        actions = (
            conn.execute(
                text(
                    "SELECT action FROM audit.audit_log "
                    "WHERE subject_schema = 'identity' "
                    "AND subject_table = 'app_user' AND subject_id = :id "
                    "ORDER BY occurred_at"
                ),
                {"id": first_id},
            )
            .scalars()
            .all()
        )
    assert actions == [
        "identity.admin_provisioned",
        "identity.admin_provisioned",
    ]
