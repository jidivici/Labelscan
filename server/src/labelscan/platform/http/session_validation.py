"""Composition seam for checking the server-side session behind a JWT sid."""

from __future__ import annotations

from collections.abc import Callable

_validator: Callable[[str, str], bool] | None = None


def configure_session_validator(validator: Callable[[str, str], bool]) -> None:
    global _validator
    _validator = validator


def session_is_active(family_id: str, actor_id: str) -> bool:
    if _validator is None:
        return False
    return _validator(family_id, actor_id)
