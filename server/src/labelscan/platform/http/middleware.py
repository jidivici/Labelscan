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
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from labelscan.platform.config import is_production
from labelscan.platform.http import jwt as jwt_codec
from labelscan.platform.http.errors import problem_response
from labelscan.platform.http.rate_limit import LimitExceeded, rate_limits
from labelscan.platform.observability import get_logger

_log = get_logger("http.security")
_TRACE_ID = re.compile(r"^[0-9a-f]{32}$")
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_MAX_INGESTION_REQUEST_BYTES = 11 * 1024 * 1024
_MAX_JSON_REQUEST_BYTES = 256 * 1024
_MAX_FORM_REQUEST_BYTES = 64 * 1024


class IngestionRequestSizeLimitMiddleware:
    """Bound every request body before FastAPI parses it.

    Image ingestion receives an 11 MiB multipart envelope. JSON and ordinary
    forms use much smaller limits, including for chunked bodies. Ambiguous HTTP
    framing is rejected consistently on every body-bearing API method.
    """

    def __init__(
        self, app: ASGIApp, max_bytes: int = _MAX_INGESTION_REQUEST_BYTES
    ) -> None:
        self.app = app
        self.max_bytes = max_bytes

    def _limit_for(self, scope: Scope, headers: list[tuple[bytes, bytes]]) -> int:
        content_type = next(
            (
                value.decode("latin-1").lower()
                for name, value in headers
                if name.lower() == b"content-type"
            ),
            "",
        )
        media_type = content_type.partition(";")[0].strip()
        if media_type == "application/json" or media_type.endswith("+json"):
            return _MAX_JSON_REQUEST_BYTES
        if (
            scope.get("path") == "/v1/ingestions"
            and media_type == "multipart/form-data"
        ):
            return self.max_bytes
        return _MAX_FORM_REQUEST_BYTES

    async def _reject(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        error_code: str,
        detail: str,
    ) -> None:
        response = problem_response(
            Request(scope),
            error_code,
            detail=detail,
        )
        await response(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in {
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
        }:
            await self.app(scope, receive, send)
            return

        headers = scope.get("headers", [])
        max_bytes = self._limit_for(scope, headers)
        content_lengths = [
            value for name, value in headers if name.lower() == b"content-length"
        ]
        has_transfer_encoding = any(
            name.lower() == b"transfer-encoding" for name, _value in headers
        )
        if len(content_lengths) > 1 or (content_lengths and has_transfer_encoding):
            await self._reject(
                scope,
                receive,
                send,
                "VALIDATION_ERROR",
                "ambiguous request body framing",
            )
            return
        declared_length: int | None = None
        if content_lengths:
            try:
                declared_length = int(content_lengths[0].decode("ascii"))
            except (UnicodeDecodeError, ValueError):
                declared_length = -1
            if declared_length < 0:
                await self._reject(
                    scope,
                    receive,
                    send,
                    "VALIDATION_ERROR",
                    "invalid Content-Length header",
                )
                return
            if declared_length > max_bytes:
                await self._reject(
                    scope,
                    receive,
                    send,
                    "PAYLOAD_TOO_LARGE",
                    "request body exceeds the configured size limit",
                )
                return

        if max_bytes <= 0:
            await self.app(scope, receive, send)
            return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > max_bytes:
                await self._reject(
                    scope,
                    receive,
                    send,
                    "PAYLOAD_TOO_LARGE",
                    "request body exceeds the configured size limit",
                )
                return
            if not message.get("more_body", False):
                break

        # Never trust Content-Length as proof of the bytes delivered by the ASGI
        # server.  Counting the actual stream closes both an under-declared body
        # bypass and discrepancies introduced by a proxy/server framing bug.
        if declared_length is not None and declared_length != len(body):
            await self._reject(
                scope,
                receive,
                send,
                "VALIDATION_ERROR",
                "Content-Length does not match the request body",
            )
            return

        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return {"type": "http.disconnect"}

        await self.app(scope, replay_receive, send)


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
        if (
            request.url.path.startswith("/v1/auth/")
            or request.url.path.startswith("/v1/mobile/auth/")
            or "/auth/" in request.url.path
        ):
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
        if is_production():
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        if request.url.path.startswith("/v1"):
            # APIs are non-cacheable by default.  Endpoints serving immutable,
            # private assets (such as authenticated arrival photos) may opt in
            # to a narrower cache policy by supplying Cache-Control themselves.
            if "Cache-Control" not in response.headers:
                response.headers["Cache-Control"] = "no-store"
                response.headers["Pragma"] = "no-cache"
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            )
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
