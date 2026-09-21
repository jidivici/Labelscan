"""Security telemetry must remain attributable without collecting credentials."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from labelscan.platform.http.rate_limit import LimitExceeded, RateLimits
from labelscan.platform.observability import JsonFormatter
from tests.conftest import capture_logger
from tests.test_rate_limiting import _client, _login


def test_concurrent_attempts_reserve_ip_budget_before_password_checks():
    limits = RateLimits()

    def attempt(index):
        try:
            limits.check_login("198.51.100.4", f"account-{index}")
            return True
        except LimitExceeded:
            return False

    # No login_failed callback has run yet: all requests are still in flight.
    with ThreadPoolExecutor(max_workers=20) as pool:
        assert sum(pool.map(attempt, range(40))) == 5


def test_distributed_login_attempts_are_bounded_per_account(monkeypatch):
    monkeypatch.setenv("LABELSCAN_LOGIN_ACCOUNT_ATTEMPTS", "3")
    limits = RateLimits()
    for i in range(3):
        limits.check_login(f"198.51.100.{i}", "same-account")
    with pytest.raises(LimitExceeded) as exc:
        limits.check_login("203.0.113.99", "same-account")
    assert exc.value.scope == "login_account_attempt"


def test_bucket_capacity_fails_closed_then_reclaims_expired_keys(monkeypatch):
    monkeypatch.setenv("LABELSCAN_RATE_MAX_BUCKETS", "2")
    monkeypatch.setenv("LABELSCAN_REFRESH_RATE_LIMIT", "1")
    now = [100.0]
    monkeypatch.setattr("labelscan.platform.http.rate_limit.time.monotonic", lambda: now[0])
    limits = RateLimits()
    limits.check_refresh("198.51.100.1")
    limits.check_refresh("198.51.100.2")
    with pytest.raises(LimitExceeded) as exc:
        limits.check_refresh("198.51.100.3")
    assert exc.value.scope == "rate_limit_capacity"
    # Churning keys cannot evict the first address's live restriction.
    with pytest.raises(LimitExceeded):
        limits.check_refresh("198.51.100.1")
    now[0] += 61
    limits.check_refresh("198.51.100.3")
    assert len(limits._events) == 1


def test_authentication_events_have_ip_and_no_credentials(monkeypatch, caplog):
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "testclient")
    client = _client()
    with capture_logger(caplog, "labelscan.http.security"):
        assert _login(client, "private-username", "private-password").status_code == 401
        assert _login(client, "private-username", "correct horse battery").status_code == 200
        assert client.post("/v1/auth/refresh").status_code == 200
        assert client.post("/v1/auth/logout").status_code == 204
        client.get("/missing?access_token=private-query-secret", headers={"Authorization": "Bearer private-bearer-secret"})
    records = [json.loads(JsonFormatter().format(r)) for r in caplog.records]
    failure = next(r for r in records if r["message"] == "auth_login_failed")
    success = next(r for r in records if r["message"] == "auth_login_succeeded")
    assert failure["client_ip"] == success["client_ip"] == "198.51.100.1"
    assert failure["correlation_id"] and len(failure["account_key"]) == 64
    assert success["actor_id"] and success["session_family_id"]
    assert {"auth_refresh_succeeded", "auth_logout_requested"} <= {r["message"] for r in records}
    encoded = json.dumps(records)
    for secret in ("private-username", "private-password", "correct horse battery", "private-query-secret", "private-bearer-secret", "r" * 43):
        assert secret not in encoded
    assert any(r.get("status") == 404 and r.get("path") == "/missing" for r in records)


def test_spoofed_client_headers_do_not_change_logged_ip(monkeypatch, caplog):
    monkeypatch.delenv("LABELSCAN_TRUSTED_PROXIES", raising=False)
    client = _client()
    with capture_logger(caplog, "labelscan.http.security"):
        _login(client, "alice", "wrong", "198.51.100.88")
    failure = next(r for r in caplog.records if r.message == "auth_login_failed")
    assert failure.client_ip == "testclient"


def test_invalid_forwarded_hop_does_not_select_attacker_ip(monkeypatch, caplog):
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "testclient")
    client = _client()
    with capture_logger(caplog, "labelscan.http.security"):
        _login(client, "alice", "wrong", "198.51.100.88, invalid-hop")
    failure = next(r for r in caplog.records if r.message == "auth_login_failed")
    assert failure.client_ip == "testclient"


def test_public_request_limit_runs_before_application_and_keeps_security_headers(monkeypatch):
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from labelscan.platform.http.middleware import (
        CorrelationMiddleware,
        RequestRateLimitMiddleware,
        SecurityHeadersMiddleware,
    )
    from labelscan.platform.http.rate_limit import rate_limits

    monkeypatch.setenv("LABELSCAN_ENV", "production")
    monkeypatch.setenv("LABELSCAN_HTTP_RATE_LIMIT", "2")
    monkeypatch.delenv("LABELSCAN_TRUSTED_PROXIES", raising=False)
    rate_limits.reset()
    calls = []

    async def endpoint(request):
        calls.append(request.method)
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/v1/probe", endpoint, methods=["GET", "POST"])])
    app.add_middleware(RequestRateLimitMiddleware)
    app.add_middleware(CorrelationMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    with TestClient(app) as client:
        assert client.get("/v1/probe").status_code == 200
        assert client.post("/v1/probe").status_code == 200
        limited = client.get("/v1/probe", headers={"X-Forwarded-For": "198.51.100.9"})
    assert limited.status_code == 429 and int(limited.headers["Retry-After"]) > 0
    assert limited.headers["Cache-Control"] == "no-store"
    assert limited.headers["X-Correlation-Id"]
    assert "max-age=" in limited.headers["Strict-Transport-Security"]
    assert calls == ["GET", "POST"]
    rate_limits.reset()
