"""Trusted client attribution shared by abuse controls and security logs."""

from __future__ import annotations

import ipaddress

from starlette.requests import Request

from labelscan.platform.config import is_trusted_proxy


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    if not is_trusted_proxy(peer):
        return peer
    chain = [
        item.strip()
        for value in request.headers.getlist("X-Forwarded-For")
        for item in value.split(",")
        if item.strip()
    ]
    for forwarded in reversed(chain):
        try:
            normalized = str(ipaddress.ip_address(forwarded))
        except ValueError:
            # An invalid intervening hop breaks the chain of trust.
            return peer
        if not is_trusted_proxy(normalized):
            return normalized
    return peer


def request_context(request: Request) -> dict:
    # No query strings, arbitrary headers, credentials or request bodies.
    return {
        "client_ip": client_ip(request),
        "peer_ip": request.client.host if request.client else "unknown",
        "method": request.method,
        "path": request.url.path[:512],
        "correlation_id": getattr(request.state, "correlation_id", None),
        "trace_id": getattr(request.state, "trace_id", None),
        "actor_id": getattr(request.state, "actor_id", None),
        "organization_id": getattr(request.state, "organization_id", None),
    }
