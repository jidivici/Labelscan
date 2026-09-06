"""HTTP/DB proofs for store administration and CLI identity bootstrap."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.identity.adapters.cli import upsert_admin
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
            "DELETE FROM identity.user_portal_assignment "
            "WHERE portal_id IN ("
            "SELECT portal.id FROM identity.business_portal AS portal "
            "JOIN identity.store AS store ON store.id = portal.store_id "
            "WHERE store.code LIKE 'TEST-MAG-%' OR store.created_by = ("
            "SELECT id FROM identity.app_user WHERE username = :admin))"
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
            "DELETE FROM identity.business_portal "
            "WHERE store_id IN ("
            "SELECT id FROM identity.store WHERE code LIKE 'TEST-MAG-%' "
            "OR created_by = ("
            "SELECT id FROM identity.app_user WHERE username = :admin))"
        ),
        {"admin": ADMIN_USERNAME},
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


def test_non_admin_cannot_manage_users(client):
    response = client.get(
        "/v1/users",
        headers=bearer(
            "ingestion:write ingestion:read extraction:review",
            principal="operator",
        ),
    )
    assert response.status_code == 404


def test_generic_user_listing_is_disabled_for_admin(client):
    response = client.get("/v1/users", headers=_admin_headers())
    assert response.status_code == 404


def test_admin_can_create_list_and_rename_stores(client):
    created = client.post(
        "/v1/stores",
        headers=_admin_headers(),
        json={
            "code": "test-mag-02",
            "name": "Deuxième magasin",
            "profession_codes": ["poissonnerie"],
        },
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


def test_portal_store_creation_and_operator_store_label_hide_internal_code(
    client, engine
):
    created = client.post(
        "/v1/stores",
        headers=_admin_headers(),
        json={
            "name": "Magasin du port",
            "profession_codes": ["poissonnerie", "boucherie"],
        },
    )
    assert created.status_code == 201
    assert created.json()["name"] == "Magasin du port"
    assert created.json()["code"].startswith("STORE-")
    with engine.connect() as conn:
        portals = set(
            conn.execute(
                text(
                    "SELECT profession_code FROM identity.business_portal "
                    "WHERE store_id = :store_id"
                ),
                {"store_id": created.json()["id"]},
            ).scalars()
        )
    assert portals == {"poissonnerie", "boucherie", "charcuterie_traiteur"}
    with engine.connect() as conn:
        active_portals = set(
            conn.execute(
                text(
                    "SELECT profession_code FROM identity.business_portal "
                    "WHERE store_id = :store_id AND active = true"
                ),
                {"store_id": created.json()["id"]},
            ).scalars()
        )
    assert active_portals == {"poissonnerie", "boucherie"}

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


def test_store_with_active_manager_portal_assignment_cannot_be_disabled(client, engine):
    created = client.post(
        "/v1/stores",
        headers=_admin_headers(),
        json={
            "code": "MANAGER-SCOPE-01",
            "name": "Magasin manager",
            "profession_codes": ["poissonnerie"],
        },
    )
    assert created.status_code == 201
    manager_id = str(uuid.uuid4())
    with engine.begin() as conn:
        portal_id = conn.execute(
            text(
                "SELECT id FROM identity.business_portal "
                "WHERE organization_id = :organization_id "
                "AND store_id = :store_id AND active = true "
                "ORDER BY profession_code LIMIT 1"
            ),
            {
                "organization_id": created.json()["organization_id"],
                "store_id": created.json()["id"],
            },
        ).scalar_one()
        set_audit_context(
            conn,
            actor_id=ADMIN_ID,
            action="identity.test_manager_assigned",
            correlation_id="user-admin-test",
            trace_id="user-admin-test",
        )
        conn.execute(
            text(
                "INSERT INTO identity.app_user "
                "(id, organization_id, organization_code, username, display_name, "
                "password_hash, role, active, store_id, store_code, created_by) "
                "VALUES (:id, :organization_id, 'labelscan', :username, "
                "'Manager affecté', :password_hash, 'manager', true, :store_id, "
                "'MANAGER-SCOPE-01', :admin_id)"
            ),
            {
                "id": manager_id,
                "organization_id": created.json()["organization_id"],
                "username": f"{PREFIX}manager-store",
                "password_hash": hash_password("manager-password-123"),
                "store_id": created.json()["id"],
                "admin_id": ADMIN_ID,
            },
        )
        conn.execute(
            text(
                "INSERT INTO identity.user_portal_assignment "
                "(organization_id, user_id, portal_id, created_by) "
                "VALUES (:organization_id, :user_id, :portal_id, :admin_id)"
            ),
            {
                "organization_id": created.json()["organization_id"],
                "user_id": manager_id,
                "portal_id": portal_id,
                "admin_id": ADMIN_ID,
            },
        )

    response = client.patch(
        "/v1/stores/MANAGER-SCOPE-01",
        headers=_admin_headers(),
        json={"active": False},
    )
    assert response.status_code == 409
    assert response.json()["error_code"] == "STORE_IN_USE"
    with engine.connect() as conn:
        assert (
            conn.execute(
                text(
                    "SELECT active FROM identity.store "
                    "WHERE organization_id = :organization_id AND code = 'MANAGER-SCOPE-01'"
                ),
                {"organization_id": created.json()["organization_id"]},
            ).scalar_one()
            is True
        )


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
    assert login.json()["user"]["role"] == "super_admin"

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
