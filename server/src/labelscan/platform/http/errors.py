"""RFC 9457 problem+json errors aligned with BACKEND §5.2 (platform / infra).

Clients branch on the STABLE `error_code`, never on status or detail. The
catalog is append-only and never repurposed (same discipline as the audit log).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from labelscan.platform.observability import get_logger

_log = get_logger("http.errors")

# error_code -> (http_status, stable title, retriable)
ERROR_CATALOG: dict[str, tuple[int, str, bool]] = {
    "VALIDATION_ERROR": (400, "Malformed request", False),
    "UNAUTHENTICATED": (401, "Missing or invalid credentials", False),
    "FORBIDDEN": (403, "Insufficient scope for this operation", False),
    "NOT_FOUND": (404, "Resource not found", False),
    "IDEMPOTENCY_KEY_CONFLICT": (
        409,
        "Idempotency-Key reused with a different payload",
        False,
    ),
    "ALERT_INVALID_TRANSITION": (
        409,
        "Alert lifecycle transition not allowed from the current state",
        False,
    ),
    "FIELD_NOT_EDITABLE": (
        409,
        "Field is barcode-derived (GS1) and cannot be overridden by a human",
        False,
    ),
    "PAYLOAD_TOO_LARGE": (413, "Payload exceeds the configured limit", False),
    "UNSUPPORTED_MEDIA_TYPE": (415, "Unsupported image media type", False),
    "RATE_LIMITED": (429, "Too many requests", True),
    "INTERNAL_ERROR": (500, "Unexpected server fault", True),
    "DEPENDENCY_UNAVAILABLE": (503, "A downstream dependency is unavailable", True),
}


class ApiError(Exception):
    """Raise from adapters/dependencies to produce a problem+json response."""

    def __init__(
        self,
        error_code: str,
        detail: str | None = None,
        errors: list[dict] | None = None,
    ) -> None:
        self.error_code = error_code
        self.detail = detail
        self.errors = errors
        super().__init__(error_code)


def problem_response(
    request: Request,
    error_code: str,
    *,
    detail: str | None = None,
    errors: list[dict] | None = None,
) -> JSONResponse:
    status, title, retriable = ERROR_CATALOG[error_code]
    correlation_id = getattr(request.state, "correlation_id", None)
    trace_id = getattr(request.state, "trace_id", None)
    body = {
        "type": f"https://errors.labelscan/{error_code}",
        "title": title,
        "status": status,
        "detail": detail or title,
        "error_code": error_code,
        "correlation_id": correlation_id,
        "trace_id": trace_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "retriable": retriable,
    }
    if errors:
        body["errors"] = errors
    headers = {"X-Correlation-Id": correlation_id} if correlation_id else {}
    return JSONResponse(
        status_code=status,
        content=body,
        media_type="application/problem+json",
        headers=headers,
    )


def _log_ctx(request: Request) -> dict:
    return {
        "path": request.url.path,
        "correlation_id": getattr(request.state, "correlation_id", None),
        "trace_id": getattr(request.state, "trace_id", None),
    }


def install_error_handlers(app) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError):  # noqa: ANN001
        status = ERROR_CATALOG.get(exc.error_code, (500, "", False))[0]
        # 5xx = server fault worth logging; 4xx are expected client errors (quiet).
        if status >= 500:
            _log.error(
                "api_error",
                extra={
                    "error_code": exc.error_code,
                    "status": status,
                    **_log_ctx(request),
                },
            )
        return problem_response(
            request, exc.error_code, detail=exc.detail, errors=exc.errors
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):  # noqa: ANN001
        errors = [
            {
                "field": ".".join(str(p) for p in e.get("loc", [])),
                "code": e.get("type", ""),
                "message": e.get("msg", ""),
            }
            for e in exc.errors()
        ]
        return problem_response(
            request,
            "VALIDATION_ERROR",
            detail="Request failed validation",
            errors=errors,
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # noqa: ANN001
        # never leak internals (BACKEND §5.2 / §12): the detail is LOGGED (server-side,
        # with the traceback), the client only gets a sanitized INTERNAL_ERROR.
        _log.exception(
            "unhandled_exception",
            extra={"error_code": "INTERNAL_ERROR", "status": 500, **_log_ctx(request)},
        )
        return problem_response(request, "INTERNAL_ERROR")
