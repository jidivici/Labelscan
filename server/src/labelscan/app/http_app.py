"""HTTP application composition root (app layer)."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from labelscan.app.ops_router import router as ops_router
from labelscan.contexts.haccp.adapters.http.lifecycle_router import (
    router as alerts_lifecycle_router,
)
from labelscan.contexts.haccp.adapters.http.read_router import (
    router as alerts_read_router,
)
from labelscan.contexts.identity.adapters.http.admin_router import (
    router as user_admin_router,
)
from labelscan.contexts.identity.adapters.http.router import get_session_service
from labelscan.contexts.identity.adapters.http.router import router as auth_router
from labelscan.contexts.identity.adapters.http.store_admin_router import (
    router as store_admin_router,
)
from labelscan.contexts.ingestion.adapters.http.read_router import (
    router as ingestion_read_router,
)
from labelscan.contexts.ingestion.adapters.http.router import router as ingestion_router
from labelscan.contexts.traceability.adapters.http.catalog_router import (
    router as catalog_router,
)
from labelscan.contexts.traceability.adapters.http.read_router import (
    router as batches_read_router,
)
from labelscan.platform.config import (
    allowed_hosts,
    deployment_environment,
    validate_runtime_configuration,
)
from labelscan.platform.http.errors import install_error_handlers
from labelscan.platform.http.middleware import (
    CorrelationMiddleware,
    MutationRateLimitMiddleware,
    SecurityHeadersMiddleware,
)
from labelscan.platform.http.rate_limit import rate_limits
from labelscan.platform.http.session_validation import configure_session_validator
from labelscan.platform.http.spa_static import SpaStaticFiles
from labelscan.platform.observability import configure_logging


def _backoffice_static_dir() -> Path:
    candidates: list[Path] = []
    configured_dir = os.environ.get("LABELSCAN_STATIC_DIR")
    if configured_dir:
        candidates.append(Path(configured_dir).expanduser())
    candidates.extend(
        [
            Path.cwd() / "static",
            Path(__file__).resolve().parents[3] / "static",
        ]
    )
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    raise RuntimeError("LabelScan backoffice static directory was not found")


def create_app() -> FastAPI:
    configure_logging()
    environment = deployment_environment()
    validate_runtime_configuration("api")
    configure_session_validator(
        lambda family_id, actor_id: get_session_service().family_is_active(
            family_id, actor_id
        )
    )
    rate_limits.reset()
    production = environment == "production"
    app = FastAPI(
        title="LabelScan API",
        version="v1",
        docs_url=None if production else "/docs",
        redoc_url=None if production else "/redoc",
        openapi_url=None if production else "/openapi.json",
    )
    if production:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts())
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(MutationRateLimitMiddleware)
    app.add_middleware(CorrelationMiddleware)
    install_error_handlers(app)
    app.include_router(auth_router)  # auth: POST /v1/auth/login (unauthenticated)
    app.include_router(user_admin_router)  # admin: POST/GET/PATCH /v1/users
    app.include_router(store_admin_router)  # admin: POST/GET/PATCH /v1/stores
    app.include_router(ingestion_router)  # write: POST /v1/ingestions
    app.include_router(
        ingestion_read_router
    )  # read: GET /v1/ingestions/{id}, /v1/extraction-runs/{id}
    app.include_router(batches_read_router)  # read: GET /v1/batches/{id}
    app.include_router(catalog_router)  # store-scoped: GET /v1/arrivals
    app.include_router(alerts_read_router)  # read: GET /v1/alerts
    app.include_router(
        alerts_lifecycle_router
    )  # write: POST /v1/alerts/{id}/acknowledge|resolve
    app.include_router(ops_router)  # ops: GET /v1/health/live|ready, /v1/version
    app.mount(
        "/backoffice",
        SpaStaticFiles(directory=_backoffice_static_dir(), html=True),
        name="backoffice",
    )
    return app
