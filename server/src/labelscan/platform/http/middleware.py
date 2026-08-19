"""Correlation/trace middleware (platform / infra) — BACKEND §10.1.

Reads or generates `correlation_id` (X-Correlation-Id) and `trace_id`
(W3C traceparent) and binds them to request.state so the route can put them into
the audit context, and so every error envelope echoes them. This is what
guarantees correlation_id/trace_id are present end-to-end.
"""

from __future__ import annotations

import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from labelscan.platform.http import jwt as jwt_codec
from labelscan.platform.http.errors import problem_response
from labelscan.platform.http.rate_limit import LimitExceeded, rate_limits
from labelscan.platform.observability import get_logger

_log = get_logger("http.security")
_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def _trace_id_from(traceparent: str | None) -> str:
    # W3C traceparent: version-traceid-spanid-flags ; fall back to a fresh id.
    if traceparent:
        parts = traceparent.split("-")
        if len(parts) >= 2 and _TRACE_ID.fullmatch(parts[1]) and parts[1] != "0" * 32:
            return parts[1]
    return uuid.uuid4().hex


class CorrelationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        supplied = request.headers.get("X-Correlation-Id")
        correlation_id = (
            supplied
            if supplied and _CORRELATION_ID.fullmatch(supplied)
            else f"corr_{uuid.uuid4().hex}"
        )
        trace_id = _trace_id_from(request.headers.get("traceparent"))
        request.state.correlation_id = correlation_id
        request.state.trace_id = trace_id
        response = await call_next(request)
        response.headers.setdefault("X-Correlation-Id", correlation_id)
        return response


class MutationRateLimitMiddleware(BaseHTTPMiddleware):
    """Throttle authenticated write traffic before it reaches paid/storage work."""

    async def dispatch(self, request: Request, call_next):
        if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
            return await call_next(request)
        if request.url.path.startswith("/v1/auth/") or request.url.path.startswith(
            "/v1/mobile/auth/"
        ) or "/auth/" in request.url.path:
            return await call_next(request)
        authorization = request.headers.get("Authorization") or ""
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            return await call_next(request)
        try:
            claims = jwt_codec.decode(token)
            actor_id = str(claims.get("actor_id") or "")
            if not actor_id:
                return await call_next(request)
            if request.url.path == "/v1/ingestions":
                rate_limits.check_ingestion(actor_id)
            else:
                rate_limits.check_mutation(actor_id)
        except jwt_codec.TokenError:
            return await call_next(request)
        except LimitExceeded as exc:
            _log.warning(
                "rate_limited",
                extra={
                    "actor_id": actor_id,
                    "rate_limit_scope": exc.scope,
                    "retry_after": exc.retry_after,
                    "path": request.url.path,
                },
            )
            return problem_response(
                request,
                "RATE_LIMITED",
                detail="request rate limit exceeded",
                extra_headers={"Retry-After": str(exc.retry_after)},
            )
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        if request.url.path.startswith("/v1"):
            # APIs are non-cacheable by default.  Endpoints serving immutable,
            # private assets (such as authenticated arrival photos) may opt in
            # to a narrower cache policy by supplying Cache-Control themselves.
            if "Cache-Control" not in response.headers:
                response.headers["Cache-Control"] = "no-store"
                response.headers["Pragma"] = "no-cache"
        if request.url.path.startswith("/backoffice"):
            response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
            response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: blob:; "
                "style-src 'self'; script-src 'self'; connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; form-action 'self'; "
                "frame-ancestors 'none'",
            )
        return response
