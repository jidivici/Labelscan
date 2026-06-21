"""Correlation/trace middleware (platform / infra) — BACKEND §10.1.

Reads or generates `correlation_id` (X-Correlation-Id) and `trace_id`
(W3C traceparent) and binds them to request.state so the route can put them into
the audit context, and so every error envelope echoes them. This is what
guarantees correlation_id/trace_id are present end-to-end.
"""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


def _trace_id_from(traceparent: str | None) -> str:
    # W3C traceparent: version-traceid-spanid-flags ; fall back to a fresh id.
    if traceparent:
        parts = traceparent.split("-")
        if len(parts) >= 2 and parts[1]:
            return parts[1]
    return uuid.uuid4().hex


class CorrelationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        correlation_id = (
            request.headers.get("X-Correlation-Id") or f"corr_{uuid.uuid4().hex}"
        )
        trace_id = _trace_id_from(request.headers.get("traceparent"))
        request.state.correlation_id = correlation_id
        request.state.trace_id = trace_id
        response = await call_next(request)
        response.headers.setdefault("X-Correlation-Id", correlation_id)
        return response
