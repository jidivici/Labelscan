"""HTTP proofs for POST /v1/auth/login and JWT-gated access.

Needs PostgreSQL (the engine fixture skips otherwise). Verifies:
  - login returns a Bearer token; the token authorizes a scoped endpoint
  - wrong password / unknown user -> generic 401 UNAUTHENTICATED (no enumeration)
  - protected endpoints reject a missing or invalid token with 401
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.identity.adapters.http.router import get_login
from labelscan.contexts.identity.adapters.sql_user_repository import SqlUserRepository
from labelscan.contexts.identity.application.login import Login
from labelscan.contexts.identity.domain.password import hash_password
from labelscan.platform.http.deps import get_engine

USERNAME = "admin-test"
PASSWORD = "correct-horse-battery"


@pytest.fixture
def admin(engine):
    with engine.begin() as c:
        c.execute(
            text("DELETE FROM identity.app_user WHERE username = :u"), {"u": USERNAME}
        )
        c.execute(
            text(
                "INSERT INTO identity.app_user (username, password_hash, role, is_active) "
                "VALUES (:u, :h, 'admin', true)"
            ),
            {"u": USERNAME, "h": hash_password(PASSWORD)},
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
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


def _login(client, username, password):
    return client.post(
        "/v1/auth/login", json={"username": username, "password": password}
    )


def test_login_success_returns_bearer_token(client, admin):
    r = _login(client, admin, PASSWORD)
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["expires_in"] > 0


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
