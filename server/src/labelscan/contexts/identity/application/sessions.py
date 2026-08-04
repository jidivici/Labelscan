"""Server-side rotating refresh sessions for mobile and browser clients."""

from __future__ import annotations

import hashlib
import os
import secrets
from dataclasses import dataclass
from typing import Protocol

from labelscan.contexts.identity.domain.user import AuthenticatedUser

_DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 3600


class InvalidRefreshToken(Exception):
    """The presented refresh token is missing, expired, revoked, or replayed."""


@dataclass(frozen=True)
class RefreshSession:
    family_id: str
    refresh_token: str
    refresh_expires_in: int
    user: AuthenticatedUser
    client_type: str = "browser"


class SessionRepository(Protocol):
    def create(
        self,
        user: AuthenticatedUser,
        token_hash: str,
        ttl_seconds: int,
        client_type: str,
    ) -> str: ...

    def rotate(
        self,
        token_hash: str,
        replacement_hash: str,
        ttl_seconds: int,
        expected_client_type: str,
    ) -> tuple[str, AuthenticatedUser, str]: ...

    def revoke(self, token_hash: str) -> None: ...

    def family_is_active(self, family_id: str, actor_id: str) -> bool: ...


def refresh_ttl_seconds() -> int:
    raw = os.environ.get("LABELSCAN_REFRESH_TTL_SECONDS")
    if not raw:
        return _DEFAULT_REFRESH_TTL_SECONDS
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError("LABELSCAN_REFRESH_TTL_SECONDS must be an integer") from exc
    if value <= 0:
        raise RuntimeError("LABELSCAN_REFRESH_TTL_SECONDS must be positive")
    return value


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SessionService:
    def __init__(self, repository: SessionRepository) -> None:
        self._repository = repository

    def create(
        self, user: AuthenticatedUser, client_type: str = "browser"
    ) -> RefreshSession:
        if client_type not in {"browser", "mobile"}:
            raise ValueError("unknown authentication client type")
        token = _new_token()
        ttl = refresh_ttl_seconds()
        family_id = self._repository.create(user, token_digest(token), ttl, client_type)
        return RefreshSession(family_id, token, ttl, user, client_type)

    def rotate(
        self, token: str, expected_client_type: str = "browser"
    ) -> RefreshSession:
        if not token:
            raise InvalidRefreshToken()
        if expected_client_type not in {"browser", "mobile"}:
            raise InvalidRefreshToken()
        replacement = _new_token()
        ttl = refresh_ttl_seconds()
        family_id, user, client_type = self._repository.rotate(
            token_digest(token),
            token_digest(replacement),
            ttl,
            expected_client_type,
        )
        return RefreshSession(family_id, replacement, ttl, user, client_type)

    def revoke(self, token: str) -> None:
        if token:
            self._repository.revoke(token_digest(token))

    def family_is_active(self, family_id: str, actor_id: str) -> bool:
        return self._repository.family_is_active(family_id, actor_id)
