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
    def __init__(self):
        self.user = None

    def create(self, user, client_type="browser"):
        self.user = user
        return RefreshSession(str(uuid.uuid4()), "r" * 43, 604800, user, client_type)

    def rotate(self, token, expected_client_type="browser"):
        assert self.user is not None
        return RefreshSession(
            str(uuid.uuid4()), "n" * 43, 604800, self.user, expected_client_type
        )

    def revoke(self, token):
        return None


def _client() -> TestClient:
    app = create_app()
    sessions = _Sessions()
    app.dependency_overrides[get_login] = lambda: _Login()
    app.dependency_overrides[get_session_service] = lambda: sessions
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


def test_forwarded_chain_uses_nearest_untrusted_address(monkeypatch):
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "testclient")
    monkeypatch.setenv("LABELSCAN_LOGIN_RATE_LIMIT", "1")
    client = _client()
    first = _login(
        client,
        "first-account",
        "wrong",
        "192.0.2.10, 198.51.100.77",
    )
    assert first.status_code == 401

    # Changing the attacker-controlled left-most value cannot evade the bucket
    # selected from the nearest untrusted hop on the right.
    limited = _login(
        client,
        "second-account",
        "wrong",
        "203.0.113.99, 198.51.100.77",
    )
    assert limited.status_code == 429
    assert limited.json()["error_code"] == "RATE_LIMITED"


def test_refresh_exchange_is_rate_limited_before_repository_work(monkeypatch):
    monkeypatch.setenv("LABELSCAN_REFRESH_RATE_LIMIT", "2")
    client = _client()
    assert _login(client, "alice", "correct horse battery").status_code == 200
    assert client.post("/v1/auth/refresh").status_code == 200
    assert client.post("/v1/auth/refresh").status_code == 200

    limited = client.post("/v1/auth/refresh")
    assert limited.status_code == 429
    assert limited.json()["error_code"] == "RATE_LIMITED"
    assert int(limited.headers["Retry-After"]) >= 1


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


def test_default_ingestion_limit_accepts_forty_arrivals_in_ten_minutes(monkeypatch):
    monkeypatch.delenv("LABELSCAN_INGESTION_BURST_LIMIT", raising=False)
    monkeypatch.delenv("LABELSCAN_INGESTION_BURST_WINDOW_SECONDS", raising=False)
    monkeypatch.delenv("LABELSCAN_INGESTION_SUSTAINED_LIMIT", raising=False)
    monkeypatch.delenv("LABELSCAN_INGESTION_SUSTAINED_WINDOW_SECONDS", raising=False)
    limits = RateLimits()

    for _ in range(40):
        limits.check_ingestion("receiving-operator")

    # The default keeps operational headroom above the requested workload.
    for _ in range(20):
        limits.check_ingestion("receiving-operator")
    with pytest.raises(LimitExceeded) as limited:
        limits.check_ingestion("receiving-operator")
    assert limited.value.scope == "ingestion_burst"
