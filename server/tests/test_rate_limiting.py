"""HTTP proofs for login abuse controls and safe Retry-After responses."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app
from labelscan.contexts.identity.adapters.http.router import (
    get_login,
    get_session_service,
)
from labelscan.contexts.identity.application.login import InvalidCredentials
from labelscan.contexts.identity.application.sessions import RefreshSession
from labelscan.contexts.identity.domain.user import ADMIN_SCOPES, AuthenticatedUser
from labelscan.platform.http.rate_limit import LimitExceeded, RateLimits


class _Login:
    def __call__(self, username: str, password: str, organization_slug: str):
        if password != "correct horse battery":
            raise InvalidCredentials()
        return AuthenticatedUser(
            actor_id=str(uuid.uuid4()),
            username=username,
            display_name=username,
            role="admin",
            scopes=ADMIN_SCOPES,
            store_code=None,
            organization_id=str(uuid.uuid4()),
            organization_slug=organization_slug,
        )


class _Sessions:
    def create(self, user, client_type="browser"):
        return RefreshSession(str(uuid.uuid4()), "r" * 43, 604800, user, client_type)


def _client() -> TestClient:
    app = create_app()
    app.dependency_overrides[get_login] = lambda: _Login()
    app.dependency_overrides[get_session_service] = lambda: _Sessions()
    return TestClient(app)


def _login(client: TestClient, username: str, password: str, ip: str = "198.51.100.1"):
    return client.post(
        "/v1/auth/login",
        json={"username": username, "password": password},
        headers={"X-Forwarded-For": ip},
    )


def test_login_cooldown_returns_retry_after_and_separates_buckets(monkeypatch):
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "testclient")
    client = _client()
    for _ in range(5):
        assert _login(client, "alice", "wrong").status_code == 401

    limited = _login(client, "alice", "wrong")
    assert limited.status_code == 429
    assert limited.json()["error_code"] == "RATE_LIMITED"
    assert int(limited.headers["Retry-After"]) >= 1

    # A distinct client-IP and account bucket remains available.
    other = _login(client, "bob", "correct horse battery", "203.0.113.9")
    assert other.status_code == 200


def test_success_resets_consecutive_account_failures(monkeypatch):
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "testclient")
    client = _client()
    for _ in range(4):
        assert _login(client, "alice", "wrong", "198.51.100.1").status_code == 401
    assert (
        _login(client, "alice", "correct horse battery", "203.0.113.1").status_code
        == 200
    )
    for index in range(5):
        assert (
            _login(client, "alice", "wrong", f"203.0.113.{index + 10}").status_code
            == 401
        )
    assert _login(client, "alice", "wrong", "203.0.113.99").status_code == 429


def test_forwarded_ip_is_ignored_for_untrusted_peer(monkeypatch):
    monkeypatch.delenv("LABELSCAN_TRUSTED_PROXIES", raising=False)
    client = _client()
    for index in range(5):
        assert (
            _login(client, f"user-{index}", "wrong", f"203.0.113.{index}").status_code
            == 401
        )
    limited = _login(client, "another-account", "wrong", "192.0.2.55")
    assert limited.status_code == 429
    assert limited.json()["error_code"] == "RATE_LIMITED"


def test_long_poll_concurrency_limits_and_release(monkeypatch):
    monkeypatch.setenv("LABELSCAN_LONG_POLL_PER_ACTOR", "2")
    monkeypatch.setenv("LABELSCAN_LONG_POLL_GLOBAL", "3")
    limits = RateLimits()

    limits.acquire_hold("alice")
    limits.acquire_hold("alice")
    with pytest.raises(LimitExceeded) as actor_limit:
        limits.acquire_hold("alice")
    assert actor_limit.value.scope == "long_poll_actor"
    assert actor_limit.value.retry_after == 1

    limits.acquire_hold("bob")
    with pytest.raises(LimitExceeded) as global_limit:
        limits.acquire_hold("carol")
    assert global_limit.value.scope == "long_poll_global"

    limits.release_hold("alice")
    limits.acquire_hold("carol")
