"""Batch 3 — ops/probe endpoints: /v1/health/live, /v1/health/ready, /v1/version.

No DB required: live/version have no dependencies, and readiness is exercised via
a dependency override so the real engine is never built under test.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app
from labelscan.app.ops_router import get_readiness_probe


def test_live_is_200_alive():
    r = TestClient(create_app()).get("/v1/health/live")
    assert r.status_code == 200
    assert r.json() == {"status": "alive"}


def test_version_reports_build_and_rule_set_version():
    r = TestClient(create_app()).get("/v1/version")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["version"], str) and body["version"]
    # active rule set is the B2 placeholder until Compliance authors it
    assert body["rule_set_version"] == "placeholder-pending-B2"


class _FakeProbe:
    def __init__(self, checks: dict[str, str]) -> None:
        self._checks = checks

    def check(self) -> dict[str, str]:
        return self._checks


def test_ready_200_when_all_dependencies_ok():
    app = create_app()
    app.dependency_overrides[get_readiness_probe] = lambda: _FakeProbe(
        {"database": "ok", "object_store": "ok"}
    )
    r = TestClient(app).get("/v1/health/ready")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ready",
        "checks": {"database": "ok", "object_store": "ok"},
    }


def test_ready_503_problem_json_when_dependency_unavailable():
    app = create_app()
    app.dependency_overrides[get_readiness_probe] = lambda: _FakeProbe(
        {"database": "unavailable", "object_store": "ok"}
    )
    r = TestClient(app).get("/v1/health/ready")
    assert r.status_code == 503
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["error_code"] == "DEPENDENCY_UNAVAILABLE"
