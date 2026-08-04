"""Positive/negative proofs for the role-specific IAM surface."""

from __future__ import annotations

import hashlib
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
                "created_by": ids["super"],
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
                    "VALUES (:id, :organization_id, :store_id, :profession, :profession, :created_by)"
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
            text(
                "DELETE FROM identity.account_activation WHERE organization_id = :org"
            ),
            {"org": organization_id},
        )
        conn.execute(
            text("DELETE FROM identity.auth_session WHERE organization_id = :org"),
            {"org": organization_id},
        )
        conn.execute(
            text(
                "DELETE FROM identity.user_portal_assignment WHERE organization_id = :org"
            ),
            {"org": organization_id},
        )
        for role in ("operator", "manager", "admin"):
            conn.execute(
                text(
                    "DELETE FROM identity.app_user WHERE username LIKE :prefix "
                    "AND role = :role"
                ),
                {"prefix": f"{prefix}%", "role": role},
            )
        conn.execute(
            text("DELETE FROM identity.business_portal WHERE id IN (:portal, :other)"),
            ids,
        )
        conn.execute(text("DELETE FROM identity.store WHERE id = :store"), ids)
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


def _invite_and_activate_manager(
    client: TestClient,
    ids: dict[str, str],
    organization_id: str,
    prefix: str,
    portal_ids: list[str],
) -> dict[str, object]:
    invited = client.post(
        "/v1/managers",
        headers=_headers(
            "identity:managers:manage", "admin", ids["admin"], organization_id
        ),
        json={
            "username": f"{prefix}-manager-{uuid.uuid4().hex[:6]}",
            "display_name": "Scoped Manager",
            "business_portal_ids": portal_ids,
        },
    )
    assert invited.status_code == 201
    payload = invited.json()
    activated = client.post(
        "/v1/auth/activate",
        json={
            "token": payload["activation_token"],
            "new_password": "manager-password-123",
        },
    )
    assert activated.status_code == 200
    return payload["user"]


def _invite_operator(
    client: TestClient,
    *,
    portal_id: str,
    manager_id: str,
    organization_id: str,
    prefix: str,
) -> tuple[dict[str, object], dict[str, str]]:
    manager_headers = _headers(
        "identity:operators:manage", "manager", manager_id, organization_id
    )
    invited = client.post(
        f"/v1/portals/{portal_id}/operators",
        headers=manager_headers,
        json={
            "username": f"{prefix}-operator-{uuid.uuid4().hex[:6]}",
            "display_name": "Scoped Operator",
        },
    )
    assert invited.status_code == 201
    return invited.json(), manager_headers


def test_admin_invites_manager_but_cannot_create_admin(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    admin_headers = _headers(
        "identity:managers:manage", "admin", ids["admin"], organization_id
    )
    forbidden = client.post(
        "/v1/admins",
        headers=admin_headers,
        json={"username": f"{prefix}-forbidden", "display_name": "Forbidden"},
    )
    assert forbidden.status_code == 403

    invited = client.post(
        "/v1/managers",
        headers=admin_headers,
        json={
            "username": f"{prefix}-manager",
            "display_name": "Manager",
            "business_portal_ids": [ids["portal"]],
        },
    )
    assert invited.status_code == 201
    assert invited.json()["user"]["active"] is False
    assert invited.json()["activation_token"]
    activated = client.post(
        "/v1/auth/activate",
        json={
            "token": invited.json()["activation_token"],
            "new_password": "manager-password-123",
        },
    )
    assert activated.status_code == 200
    assert activated.json()["active"] is True


def test_super_admin_is_the_only_role_that_can_create_and_delete_admin(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    headers = _headers(
        "identity:admins:manage", "super_admin", ids["super"], organization_id
    )
    created = client.post(
        "/v1/admins",
        headers=headers,
        json={"username": f"{prefix}-new-admin", "display_name": "New Admin"},
    )
    assert created.status_code == 201
    deleted = client.delete(
        f"/v1/admins/{created.json()['user']['id']}", headers=headers
    )
    assert deleted.status_code == 204


def test_manager_only_manages_operators_in_assigned_portal(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    invited = client.post(
        "/v1/managers",
        headers=_headers(
            "identity:managers:manage", "admin", ids["admin"], organization_id
        ),
        json={
            "username": f"{prefix}-scoped-manager",
            "display_name": "Scoped Manager",
            "business_portal_ids": [ids["portal"]],
        },
    ).json()
    assert (
        client.post(
            "/v1/auth/activate",
            json={
                "token": invited["activation_token"],
                "new_password": "manager-password-123",
            },
        ).status_code
        == 200
    )
    manager_headers = _headers(
        "identity:operators:manage",
        "manager",
        invited["user"]["id"],
        organization_id,
    )
    created = client.post(
        f"/v1/portals/{ids['portal']}/operators",
        headers=manager_headers,
        json={"username": f"{prefix}-operator", "display_name": "Operator"},
    )
    assert created.status_code == 201
    assert created.json()["user"]["business_portal_ids"] == [ids["portal"]]
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": created.json()["activation_token"],
                "new_password": "operator-password-123",
            },
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/v1/portals/{ids['other']}/operators",
            headers=manager_headers,
            json={"username": f"{prefix}-outside", "display_name": "Outside"},
        ).status_code
        == 403
    )
    reset = client.post(
        f"/v1/operators/{created.json()['user']['id']}/credential-reset",
        headers=manager_headers,
    )
    assert reset.status_code == 200
    assert reset.json()["activation_token"]


def test_operator_portal_deactivation_blocks_relogin_refresh_and_store_fallback(
    iam_v2,
):
    client, ids, organization_id, prefix = iam_v2
    manager = _invite_and_activate_manager(
        client, ids, organization_id, prefix, [ids["portal"]]
    )
    invited, _ = _invite_operator(
        client,
        portal_id=ids["portal"],
        manager_id=str(manager["id"]),
        organization_id=organization_id,
        prefix=prefix,
    )
    username = str(invited["user"]["username"])
    password = "operator-password-123"
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={"token": invited["activation_token"], "new_password": password},
        ).status_code
        == 200
    )
    logged_in = client.post(
        "/v1/mobile/auth/login",
        json={"username": username, "password": password},
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
            json={"username": username, "password": password},
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


def test_reset_grants_are_single_generation_and_invalidated_by_scope_changes(
    iam_v2, engine
):
    client, ids, organization_id, prefix = iam_v2
    manager = _invite_and_activate_manager(
        client, ids, organization_id, prefix, [ids["portal"], ids["other"]]
    )
    invited, manager_headers = _invite_operator(
        client,
        portal_id=ids["portal"],
        manager_id=str(manager["id"]),
        organization_id=organization_id,
        prefix=prefix,
    )
    operator_id = str(invited["user"]["id"])
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": invited["activation_token"],
                "new_password": "operator-password-123",
            },
        ).status_code
        == 200
    )

    first = client.post(
        f"/v1/operators/{operator_id}/credential-reset", headers=manager_headers
    )
    second = client.post(
        f"/v1/operators/{operator_id}/credential-reset", headers=manager_headers
    )
    assert first.status_code == second.status_code == 200
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": first.json()["activation_token"],
                "new_password": "old-reset-pass-123",
            },
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": second.json()["activation_token"],
                "new_password": "new-reset-pass-123",
            },
        ).status_code
        == 200
    )

    before_move = client.post(
        f"/v1/operators/{operator_id}/credential-reset", headers=manager_headers
    )
    assert before_move.status_code == 200
    moved = client.patch(
        f"/v1/portals/{ids['portal']}/operators/{operator_id}",
        headers=manager_headers,
        json={"business_portal_id": ids["other"]},
    )
    assert moved.status_code == 200
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": before_move.json()["activation_token"],
                "new_password": "moved-reset-pass-123",
            },
        ).status_code
        == 401
    )

    before_deactivate = client.post(
        f"/v1/operators/{operator_id}/credential-reset", headers=manager_headers
    )
    assert before_deactivate.status_code == 200
    deactivated = client.patch(
        f"/v1/portals/{ids['other']}/operators/{operator_id}",
        headers=manager_headers,
        json={"active": False},
    )
    assert deactivated.status_code == 200
    stale_token = before_deactivate.json()["activation_token"]
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={"token": stale_token, "new_password": "disabled-reset-pass-123"},
        ).status_code
        == 401
    )

    # Simulate a pre-fix grant that survived deactivation. Revalidation must still
    # refuse it and must never turn the account active again.
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE identity.account_activation SET used_at = NULL "
                "WHERE token_hash = :token_hash"
            ),
            {"token_hash": hashlib.sha256(stale_token.encode()).hexdigest()},
        )
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={"token": stale_token, "new_password": "stale-reset-pass-123"},
        ).status_code
        == 401
    )
    with engine.begin() as conn:
        assert (
            conn.execute(
                text("SELECT active FROM identity.app_user WHERE id = :user_id"),
                {"user_id": operator_id},
            ).scalar_one()
            is False
        )


def test_activation_revalidates_active_portal_and_store(iam_v2, engine):
    client, ids, organization_id, prefix = iam_v2
    manager = _invite_and_activate_manager(
        client, ids, organization_id, prefix, [ids["portal"]]
    )
    invited, manager_headers = _invite_operator(
        client,
        portal_id=ids["portal"],
        manager_id=str(manager["id"]),
        organization_id=organization_id,
        prefix=prefix,
    )
    operator_id = str(invited["user"]["id"])
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": invited["activation_token"],
                "new_password": "operator-password-123",
            },
        ).status_code
        == 200
    )

    portal_reset = client.post(
        f"/v1/operators/{operator_id}/credential-reset", headers=manager_headers
    )
    assert portal_reset.status_code == 200
    admin_headers = _headers(
        "identity:portals:manage", "admin", ids["admin"], organization_id
    )
    assert (
        client.put(
            f"/v1/stores/{ids['store']}/portals",
            headers=admin_headers,
            json={"portal_id": ids["portal"], "active": False},
        ).status_code
        == 200
    )
    portal_token = portal_reset.json()["activation_token"]
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": portal_token,
                "new_password": "invalidated-portal-123",
            },
        ).status_code
        == 401
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE identity.account_activation SET used_at = NULL "
                "WHERE token_hash = :token_hash"
            ),
            {"token_hash": hashlib.sha256(portal_token.encode()).hexdigest()},
        )
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={"token": portal_token, "new_password": "inactive-portal-123"},
        ).status_code
        == 401
    )

    assert (
        client.put(
            f"/v1/stores/{ids['store']}/portals",
            headers=admin_headers,
            json={"portal_id": ids["portal"], "active": True},
        ).status_code
        == 200
    )
    store_reset = client.post(
        f"/v1/operators/{operator_id}/credential-reset", headers=manager_headers
    )
    assert store_reset.status_code == 200
    with engine.begin() as conn:
        set_audit_context(
            conn,
            actor_id=ids["admin"],
            action="identity.test_store_deactivated",
            correlation_id=prefix,
            trace_id=prefix,
        )
        conn.execute(
            text("UPDATE identity.store SET active = false WHERE id = :store_id"),
            {"store_id": ids["store"]},
        )
    assert (
        client.post(
            "/v1/mobile/auth/activate",
            json={
                "token": store_reset.json()["activation_token"],
                "new_password": "inactive-store-123",
            },
        ).status_code
        == 401
    )
    with engine.begin() as conn:
        set_audit_context(
            conn,
            actor_id=ids["admin"],
            action="identity.test_store_reactivated",
            correlation_id=prefix,
            trace_id=prefix,
        )
        conn.execute(
            text("UPDATE identity.store SET active = true WHERE id = :store_id"),
            {"store_id": ids["store"]},
        )


def test_mobile_activation_is_operator_only_and_does_not_consume_other_tokens(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    manager_invite = client.post(
        "/v1/managers",
        headers=_headers(
            "identity:managers:manage", "admin", ids["admin"], organization_id
        ),
        json={
            "username": f"{prefix}-mobile-rejected-manager",
            "display_name": "Mobile Rejected Manager",
            "business_portal_ids": [ids["portal"]],
        },
    )
    assert manager_invite.status_code == 201
    token = manager_invite.json()["activation_token"]

    rejected = client.post(
        "/v1/mobile/auth/activate",
        json={"token": token, "new_password": "manager-password-123"},
    )
    assert rejected.status_code == 401
    # The surface mismatch is checked before mutation: the normal browser flow can
    # still consume the exact same one-time grant.
    accepted = client.post(
        "/v1/auth/activate",
        json={"token": token, "new_password": "manager-password-123"},
    )
    assert accepted.status_code == 200
    assert accepted.json()["role"] == "manager"

    manager = _invite_and_activate_manager(
        client, ids, organization_id, prefix, [ids["portal"]]
    )
    operator_invite = client.post(
        f"/v1/portals/{ids['portal']}/operators",
        headers=_headers(
            "identity:operators:manage",
            "manager",
            str(manager["id"]),
            organization_id,
        ),
        json={
            "username": f"{prefix}-mobile-operator",
            "display_name": "Mobile Operator",
        },
    )
    assert operator_invite.status_code == 201
    operator_activation = client.post(
        "/v1/mobile/auth/activate",
        json={
            "token": operator_invite.json()["activation_token"],
            "new_password": "operator-password-123",
        },
    )
    assert operator_activation.status_code == 200
    assert operator_activation.json()["role"] == "operator"


def test_me_returns_role_scoped_capabilities_stores_and_detailed_portals(iam_v2):
    client, ids, organization_id, prefix = iam_v2
    admin_me = client.get(
        "/v1/me",
        headers=_headers("identity:read", "admin", ids["admin"], organization_id),
    )
    assert admin_me.status_code == 200
    admin_payload = admin_me.json()
    assert admin_payload["user"]["id"] == ids["admin"]
    assert admin_payload["capabilities"] == admin_payload["scopes"]
    assert "identity:portals:manage" in admin_payload["capabilities"]
    assert ids["store"] in {store["id"] for store in admin_payload["stores"]}
    admin_portals = {
        portal["id"]: portal for portal in admin_payload["business_portals"]
    }
    assert {ids["portal"], ids["other"]} <= admin_portals.keys()
    assert admin_portals[ids["portal"]] == {
        "id": ids["portal"],
        "store_id": ids["store"],
        "store_code": next(
            store["code"]
            for store in admin_payload["stores"]
            if store["id"] == ids["store"]
        ),
        "store_name": "IAM V2",
        "profession_code": "poissonnerie",
        "profession_name": "Poissonnerie",
        "name": "poissonnerie",
        "active": True,
    }

    manager = _invite_and_activate_manager(
        client, ids, organization_id, prefix, [ids["portal"]]
    )
    manager_me = client.get(
        "/v1/me",
        headers=_headers(
            "identity:read", "manager", str(manager["id"]), organization_id
        ),
    )
    assert manager_me.status_code == 200
    manager_payload = manager_me.json()
    assert [store["id"] for store in manager_payload["stores"]] == [ids["store"]]
    assert [portal["id"] for portal in manager_payload["business_portals"]] == [
        ids["portal"]
    ]
    assert "identity:portals:manage" not in manager_payload["capabilities"]

    operator = client.post(
        f"/v1/portals/{ids['portal']}/operators",
        headers=_headers(
            "identity:operators:manage",
            "manager",
            str(manager["id"]),
            organization_id,
        ),
        json={
            "username": f"{prefix}-me-operator",
            "display_name": "Operator",
        },
    )
    assert operator.status_code == 201
    assert (
        client.post(
            "/v1/auth/activate",
            json={
                "token": operator.json()["activation_token"],
                "new_password": "operator-password-123",
            },
        ).status_code
        == 200
    )
    operator_me = client.get(
        "/v1/me",
        headers=_headers(
            "ingestion:read",
            "operator",
            operator.json()["user"]["id"],
            organization_id,
        ),
    )
    assert operator_me.status_code == 200
    assert [portal["id"] for portal in operator_me.json()["business_portals"]] == [
        ids["portal"]
    ]


def test_store_portals_get_is_scoped_and_put_is_soft_idempotent_and_audited(
    iam_v2, engine
):
    client, ids, organization_id, prefix = iam_v2
    manager = _invite_and_activate_manager(
        client, ids, organization_id, prefix, [ids["other"]]
    )
    manager_id = str(manager["id"])
    manager_headers = _headers("identity:read", "manager", manager_id, organization_id)
    scoped = client.get(f"/v1/stores/{ids['store']}/portals", headers=manager_headers)
    assert scoped.status_code == 200
    assert [portal["id"] for portal in scoped.json()] == [ids["other"]]
    assert (
        client.get(
            f"/v1/stores/{uuid.uuid4()}/portals", headers=manager_headers
        ).status_code
        == 404
    )

    # Even a forged capability cannot bypass the persisted manager role.
    assert (
        client.put(
            f"/v1/stores/{ids['store']}/portals",
            headers=_headers(
                "identity:portals:manage", "manager", manager_id, organization_id
            ),
            json={"portal_id": ids["other"], "active": False},
        ).status_code
        == 403
    )

    session_id = str(uuid.uuid4())
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO identity.auth_session "
                "(id, family_id, organization_id, user_id, client_type, "
                "refresh_token_hash, refresh_expires_at) "
                "VALUES (:id, :family_id, :organization_id, :user_id, 'browser', "
                ":token_hash, clock_timestamp() + interval '1 hour')"
            ),
            {
                "id": session_id,
                "family_id": str(uuid.uuid4()),
                "organization_id": organization_id,
                "user_id": manager_id,
                "token_hash": uuid.uuid4().hex * 2,
            },
        )

    admin_headers = _headers(
        "identity:portals:manage", "admin", ids["admin"], organization_id
    )
    disabled = client.put(
        f"/v1/stores/{ids['store']}/portals",
        headers=admin_headers,
        json={"portal_id": ids["other"], "active": False},
    )
    assert disabled.status_code == 200
    assert disabled.json()["active"] is False
    repeated = client.put(
        f"/v1/stores/{ids['store']}/portals",
        headers=admin_headers,
        json={"portal_id": ids["other"], "active": False},
    )
    assert repeated.status_code == 200

    with engine.begin() as conn:
        assert conn.execute(
            text(
                "SELECT revoked_at IS NOT NULL FROM identity.auth_session WHERE id = :id"
            ),
            {"id": session_id},
        ).scalar_one()
        assert (
            conn.execute(
                text("SELECT active FROM identity.business_portal WHERE id = :id"),
                {"id": ids["other"]},
            ).scalar_one()
            is False
        )
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM audit.audit_log "
                    "WHERE actor_id = :actor_id AND action = 'identity.store_portal_deactivated' "
                    "AND subject_schema = 'identity' AND subject_table = 'store' "
                    "AND subject_id = :store_id"
                ),
                {"actor_id": ids["admin"], "store_id": ids["store"]},
            ).scalar_one()
            == 1
        )

    visible_to_admin = client.get(
        f"/v1/stores/{ids['store']}/portals", headers=admin_headers
    )
    assert visible_to_admin.status_code == 200
    assert (
        next(
            portal for portal in visible_to_admin.json() if portal["id"] == ids["other"]
        )["active"]
        is False
    )
    assert (
        client.get(
            f"/v1/stores/{ids['store']}/portals", headers=manager_headers
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/v1/stores/{uuid.uuid4()}/portals",
            headers=admin_headers,
            json={"portal_id": ids["other"], "active": True},
        ).status_code
        == 404
    )


def test_store_portal_soft_activation_contract_is_documented_in_openapi():
    operation = create_app().openapi()["paths"]["/v1/stores/{store_id}/portals"]
    assert (
        operation["get"]["summary"] == "List the business portals visible for a store"
    )
    assert operation["put"]["summary"] == "Soft-activate or deactivate a store portal"
    assert "idempotent" in operation["put"]["description"]
    assert "never deletes" in operation["put"]["description"]
