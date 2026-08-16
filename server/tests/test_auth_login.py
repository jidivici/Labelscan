"""HTTP proofs for POST /v1/auth/login and JWT-gated access.

Needs PostgreSQL (the engine fixture skips otherwise). Verifies:
  - login returns a Bearer token; the token authorizes a scoped endpoint
  - wrong password / unknown user -> generic 401 UNAUTHENTICATED (no enumeration)
  - protected endpoints reject a missing or invalid token with 401
"""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.identity.adapters.http.router import (
    get_login,
    get_session_service,
)
from labelscan.contexts.identity.adapters.sql_session_repository import (
    SqlSessionRepository,
)
from labelscan.contexts.identity.adapters.sql_user_repository import SqlUserRepository
from labelscan.contexts.identity.application.login import Login
from labelscan.contexts.identity.application.sessions import (
    InvalidRefreshToken,
    RefreshSession,
    SessionService,
)
from labelscan.contexts.identity.domain.password import hash_password
from labelscan.contexts.identity.domain.user import (
    OPERATOR_SCOPES,
    AuthenticatedUser,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.http.deps import get_engine
from tests.conftest import ACTOR_ID
from tests.test_http_security_guards import configure_production

USERNAME = "admin-test"
PASSWORD = "correct-horse-battery"


@pytest.fixture
def admin(engine):
    with engine.begin() as c:
        c.execute(
            text("DELETE FROM identity.app_user WHERE username = :u"), {"u": USERNAME}
        )
        set_audit_context(
            c,
            actor_id=ACTOR_ID,
            action="identity.test_user_created",
            correlation_id="test-auth-login",
            trace_id="test-auth-login",
        )
        c.execute(
            text(
                "INSERT INTO identity.app_user "
                "(id, username, display_name, password_hash, role, active, created_by) "
                "VALUES (:id, :u, :u, :h, 'admin', true, :id)"
            ),
            {"id": ACTOR_ID, "u": USERNAME, "h": hash_password(PASSWORD)},
        )
    yield USERNAME
    with engine.begin() as c:
        c.execute(
            text("DELETE FROM identity.app_user WHERE username = :u"), {"u": USERNAME}
        )


@pytest.fixture
def client(engine):
    app = create_app()
    app.dependency_overrides[get_login] = lambda: Login(SqlUserRepository(engine))
    app.dependency_overrides[get_session_service] = lambda: SessionService(
        SqlSessionRepository(engine)
    )
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


def _login(client, username, password, headers=None):
    return client.post(
        "/v1/auth/login",
        json={"username": username, "password": password},
        headers=headers,
    )


def test_login_success_returns_bearer_token(client, admin):
    r = _login(client, admin, PASSWORD)
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["expires_in"] == 900
    assert "refresh_token" not in body
    cookie = r.headers["set-cookie"]
    assert "labelscan_refresh=" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=strict" in cookie
    assert "Path=/v1/auth" in cookie
    assert "Secure" not in cookie
    assert body["user"] == {
        "id": ACTOR_ID,
        "username": USERNAME,
        "display_name": USERNAME,
        "role": "admin",
        "organization_id": body["user"]["organization_id"],
        "organization_slug": "labelscan",
        "store_id": None,
        "store_code": None,
        "business_portal_ids": [],
        "business_portal_id": None,
        "trade_code": None,
        "client_type": "browser",
    }


def test_production_refresh_cookie_is_secure(monkeypatch, admin, engine):
    configure_production(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_login] = lambda: Login(SqlUserRepository(engine))
    app.dependency_overrides[get_session_service] = lambda: SessionService(
        SqlSessionRepository(engine)
    )
    response = _login(
        TestClient(app), admin, PASSWORD, headers={"Origin": "https://testserver"}
    )
    assert response.status_code == 200
    assert "Secure" in response.headers["set-cookie"]


def test_mobile_login_rejects_an_administrator(client, admin):
    response = client.post(
        "/v1/mobile/auth/login",
        json={"username": admin, "password": PASSWORD},
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "FORBIDDEN"


def test_refresh_rotation_replay_revokes_access_family(client, admin, engine):
    login_response = _login(client, admin, PASSWORD)
    old_refresh = login_response.cookies["labelscan_refresh"]

    refreshed = client.post("/v1/auth/refresh")
    assert refreshed.status_code == 200
    new_access = refreshed.json()["access_token"]
    assert refreshed.cookies["labelscan_refresh"] != old_refresh

    service = SessionService(SqlSessionRepository(engine))
    with pytest.raises(InvalidRefreshToken):
        service.rotate(old_refresh)

    rejected = client.get(
        f"/v1/ingestions/{uuid.uuid4()}",
        headers={"Authorization": f"Bearer {new_access}"},
    )
    assert rejected.status_code == 401


def test_logout_immediately_rejects_existing_access_token(client, admin):
    login_response = _login(client, admin, PASSWORD)
    access = login_response.json()["access_token"]
    logout = client.post("/v1/auth/logout")
    assert logout.status_code == 204
    assert 'labelscan_refresh=""' in logout.headers["set-cookie"]

    rejected = client.get(
        f"/v1/ingestions/{uuid.uuid4()}",
        headers={"Authorization": f"Bearer {access}"},
    )
    assert rejected.status_code == 401


def test_concurrent_refresh_detects_replay_and_revokes_winner(client, admin, engine):
    old_refresh = _login(client, admin, PASSWORD).cookies["labelscan_refresh"]
    service = SessionService(SqlSessionRepository(engine))
    barrier = Barrier(2)

    def rotate():
        barrier.wait()
        try:
            return service.rotate(old_refresh)
        except InvalidRefreshToken:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: rotate(), range(2)))

    winners = [result for result in results if result is not None]
    assert len(winners) == 1
    assert service.family_is_active(winners[0].family_id, ACTOR_ID) is False


def _mobile_operator(*, portal_count: int = 1, role: str = "operator") -> AuthenticatedUser:
    store_id = str(uuid.uuid4())
    portal_ids = tuple(str(uuid.uuid4()) for _ in range(portal_count))
    return AuthenticatedUser(
        actor_id=str(uuid.uuid4()),
        username=f"mobile-operator-{portal_count}",
        display_name="Mobile Operator",
        role=role,
        scopes=OPERATOR_SCOPES,
        store_code="PARIS-01",
        organization_id=str(uuid.uuid4()),
        organization_slug="labelscan",
        store_id=store_id,
        business_portal_ids=portal_ids,
        business_portal_id=portal_ids[0] if portal_ids else None,
        trade_code="poissonnerie" if portal_ids else None,
        store_ids=(store_id,) if portal_ids else (),
    )


class _MobileSessions:
    def __init__(self, user: AuthenticatedUser) -> None:
        self.user = user
        self.created = False
        self.revoked_token: str | None = None

    def create(self, user, client_type="browser") -> RefreshSession:
        self.created = True
        return RefreshSession("test-family", "r" * 43, 604800, user, client_type)

    def rotate(self, token, expected_client_type="browser") -> RefreshSession:
        return RefreshSession(
            "test-family", "n" * 43, 604800, self.user, expected_client_type
        )

    def revoke(self, token) -> None:
        self.revoked_token = token


def test_mobile_login_accepts_a_store_operator():
    operator = _mobile_operator()
    sessions = _MobileSessions(operator)
    app = create_app()
    app.dependency_overrides[get_login] = lambda: (
        lambda username, password, organization_slug: operator
    )
    app.dependency_overrides[get_session_service] = lambda: sessions
    response = TestClient(app).post(
        "/v1/mobile/auth/login",
        json={"username": operator.username, "password": "secret"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["role"] == "operator"
    assert body["user"]["store_code"] == "PARIS-01"
    assert body["refresh_token"] == "r" * 43
    assert body["refresh_expires_in"] == 604800
    assert sessions.created is True


def test_mobile_login_accepts_an_assigned_manager():
    manager = _mobile_operator(role="manager")
    sessions = _MobileSessions(manager)
    app = create_app()
    app.dependency_overrides[get_login] = lambda: (
        lambda username, password, organization_slug: manager
    )
    app.dependency_overrides[get_session_service] = lambda: sessions

    response = TestClient(app).post(
        "/v1/mobile/auth/login",
        json={"username": manager.username, "password": "secret"},
    )

    assert response.status_code == 200
    assert response.json()["user"]["role"] == "manager"


@pytest.mark.parametrize("portal_count", [0, 2])
def test_mobile_login_rejects_an_operator_without_exactly_one_portal(portal_count):
    operator = _mobile_operator(portal_count=portal_count)
    sessions = _MobileSessions(operator)
    app = create_app()
    app.dependency_overrides[get_login] = lambda: (
        lambda username, password, organization_slug: operator
    )
    app.dependency_overrides[get_session_service] = lambda: sessions

    response = TestClient(app).post(
        "/v1/mobile/auth/login",
        json={"username": operator.username, "password": "secret"},
    )

    assert response.status_code == 403
    assert response.json()["error_code"] == "FORBIDDEN"
    assert sessions.created is False


def test_mobile_refresh_revokes_an_operator_session_without_one_active_portal():
    operator = _mobile_operator(portal_count=0)
    sessions = _MobileSessions(operator)
    app = create_app()
    app.dependency_overrides[get_session_service] = lambda: sessions

    response = TestClient(app).post(
        "/v1/mobile/auth/refresh",
        json={"refresh_token": "r" * 43},
    )

    assert response.status_code == 403
    assert response.json()["error_code"] == "FORBIDDEN"
    assert sessions.revoked_token == "n" * 43


def test_browser_login_accepts_a_store_operator():
    operator = AuthenticatedUser(
        actor_id=str(uuid.uuid4()),
        username="browser-operator",
        display_name="Browser Operator",
        role="operator",
        scopes=OPERATOR_SCOPES,
        store_code="PARIS-01",
        organization_id=str(uuid.uuid4()),
        organization_slug="labelscan",
        store_id=str(uuid.uuid4()),
        business_portal_ids=(str(uuid.uuid4()),),
    )
    app = create_app()
    app.dependency_overrides[get_login] = lambda: (
        lambda username, password, organization_slug: operator
    )
    app.dependency_overrides[get_session_service] = lambda: _MobileSessions(operator)
    response = TestClient(app).post(
        "/v1/auth/login",
        json={"username": operator.username, "password": "secret"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["role"] == "operator"


def test_browser_refresh_token_cannot_be_used_on_mobile(client, admin):
    browser = _login(client, admin, PASSWORD)
    response = client.post(
        "/v1/mobile/auth/refresh",
        json={"refresh_token": browser.cookies["labelscan_refresh"]},
    )
    assert response.status_code == 401
    assert response.json()["error_code"] == "UNAUTHENTICATED"


def test_token_authorizes_a_scoped_endpoint(client, admin):
    token = _login(client, admin, PASSWORD).json()["access_token"]
    # admin scopes include ingestion:read -> authorized; the id just doesn't exist.
    r = client.get(
        f"/v1/ingestions/{uuid.uuid4()}", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 404
    assert r.json()["error_code"] == "NOT_FOUND"


def test_wrong_password_is_401(client, admin):
    r = _login(client, admin, "wrong")
    assert r.status_code == 401
    assert r.json()["error_code"] == "UNAUTHENTICATED"


def test_unknown_user_is_401(client):
    r = _login(client, "ghost", "whatever")
    assert r.status_code == 401
    assert r.json()["error_code"] == "UNAUTHENTICATED"


def test_protected_without_token_is_401(client):
    r = client.get(f"/v1/ingestions/{uuid.uuid4()}")
    assert r.status_code == 401
    assert r.json()["error_code"] == "UNAUTHENTICATED"


def test_protected_with_invalid_token_is_401(client):
    r = client.get(
        f"/v1/ingestions/{uuid.uuid4()}", headers={"Authorization": "Bearer not.a.jwt"}
    )
    assert r.status_code == 401
    assert r.json()["error_code"] == "UNAUTHENTICATED"
