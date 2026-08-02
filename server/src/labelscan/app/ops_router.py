"""Ops / probe endpoints (app-layer composition) — BACKEND-ARCHITECTURE §3.

Liveness, readiness, and version: the minimal operational surface infra and the
mobile thin client depend on. These live in the app/composition layer because
readiness must reach the real engine + object store and /version reports the
active rule-set version — knowledge the bounded contexts and platform must not
carry.

Paths carry the /v1 prefix to match the deployed contract (openapi `servers`
base `/v1`; the path keys `/health/live` etc. are relative to it) and the
existing /v1/ingestions route. All three are unauthenticated (openapi
`security: []`).
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends

from labelscan.app.extraction_wiring import _PLACEHOLDER_RULESET
from labelscan.platform.http.errors import ApiError

router = APIRouter(tags=["ops"])


def _build_version() -> str:
    """Build/version string. Prefer an explicit deploy-injected value, else the
    installed package version, else a safe sentinel — never fabricated."""
    env = os.environ.get("LABELSCAN_VERSION")
    if env:
        return env
    try:
        from importlib.metadata import version as _pkg_version

        return _pkg_version("labelscan-server")
    except Exception:  # pragma: no cover - dist metadata not always present
        return "0.0.0+unknown"


class ReadinessProbe:
    """Checks the dependencies required to serve: DB and object store reachable.

    Constructed per-request and overridden in tests; importing this module and
    constructing the probe perform no I/O. Provider circuit-breaker state
    (BACKEND §3) is not implemented yet, so it is intentionally omitted rather
    than reported with a fabricated value.
    """

    def check(self) -> dict[str, str]:
        return {"database": self._database(), "object_store": self._object_store()}

    def _database(self) -> str:
        try:
            from sqlalchemy import text

            from labelscan.platform.db.engine import make_engine

            engine = make_engine()
            try:
                with engine.connect() as conn:
                    conn.execute(text("SELECT 1"))
            finally:
                engine.dispose()  # probe owns a short-lived engine; no pool leak
            return "ok"
        except Exception:
            return "unavailable"

    def _object_store(self) -> str:
        try:
            from labelscan.platform.storage_factory import build_raw_store

            store = build_raw_store()
            return "ok" if store.healthcheck() else "unavailable"
        except Exception:
            return "unavailable"


def get_readiness_probe() -> ReadinessProbe:
    return ReadinessProbe()


@router.get("/v1/health/live")
def live() -> dict:
    # Liveness: the process is up and serving. No dependency checks (BACKEND §3).
    return {"status": "alive"}


@router.get("/v1/health/ready")
def ready(probe: ReadinessProbe = Depends(get_readiness_probe)) -> dict:
    checks = probe.check()
    unavailable = sorted(name for name, state in checks.items() if state != "ok")
    if unavailable:
        # 503 problem+json (DEPENDENCY_UNAVAILABLE) per openapi /health/ready.
        raise ApiError("DEPENDENCY_UNAVAILABLE", f"not ready: {', '.join(unavailable)}")
    return {"status": "ready", "checks": checks}


@router.get("/v1/version")
def version() -> dict:
    # Build/version + active rule-set version (BACKEND §3). The rule set is the
    # B2 placeholder until Compliance authors it — reported honestly, not faked.
    return {
        "version": _build_version(),
        "rule_set_version": _PLACEHOLDER_RULESET.version,
    }
