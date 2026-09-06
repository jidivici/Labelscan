"""Credential lookup port for the identity context (no frameworks/DB here)."""

from __future__ import annotations

from typing import Protocol

from labelscan.contexts.identity.domain.user import StoredUser


class UserRepository(Protocol):
    def find_active_by_username(
        self, username: str, organization_slug: str = "labelscan"
    ) -> StoredUser | None:
        """Return one unambiguous active credential, or None."""
        ...

    def find_active_candidates_by_username(
        self, username: str, organization_slug: str = "labelscan"
    ) -> tuple[StoredUser, ...]:
        """Return active credentials sharing a store-scoped identifier."""
        ...
