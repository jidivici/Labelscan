"""HTTP application composition root (app layer)."""

from __future__ import annotations

from fastapi import FastAPI

from labelscan.app.ops_router import router as ops_router
from labelscan.contexts.haccp.adapters.http.lifecycle_router import (
    router as alerts_lifecycle_router,
)
from labelscan.contexts.haccp.adapters.http.read_router import (
    router as alerts_read_router,
)
from labelscan.contexts.identity.adapters.http.router import router as auth_router
from labelscan.contexts.ingestion.adapters.http.read_router import (
    router as ingestion_read_router,
)
from labelscan.contexts.ingestion.adapters.http.router import router as ingestion_router
from labelscan.contexts.traceability.adapters.http.read_router import (
    router as batches_read_router,
)
from labelscan.platform.http.errors import install_error_handlers
from labelscan.platform.http.middleware import CorrelationMiddleware
from labelscan.platform.observability import configure_logging


def create_app() -> FastAPI:
    configure_logging()
    app = FastAPI(title="LabelScan API", version="v1")
    app.add_middleware(CorrelationMiddleware)
    install_error_handlers(app)
    app.include_router(auth_router)  # auth: POST /v1/auth/login (unauthenticated)
    app.include_router(ingestion_router)  # write: POST /v1/ingestions
    app.include_router(
        ingestion_read_router
    )  # read: GET /v1/ingestions/{id}, /v1/extraction-runs/{id}
    app.include_router(batches_read_router)  # read: GET /v1/batches/{id}
    app.include_router(alerts_read_router)  # read: GET /v1/alerts
    app.include_router(
        alerts_lifecycle_router
    )  # write: POST /v1/alerts/{id}/acknowledge|resolve
    app.include_router(ops_router)  # ops: GET /v1/health/live|ready, /v1/version
    return app
