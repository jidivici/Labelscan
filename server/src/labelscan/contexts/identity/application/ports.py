"""Credential lookup port for the identity context (no frameworks/DB here)."""

from __future__ import annotations

from typing import Protocol

from labelscan.contexts.identity.domain.user import StoredUser


class UserRepository(Protocol):
    def find_active_by_username(
        self, username: str, organization_slug: str = "labelscan"
    ) -> StoredUser | None:
        """Return the active credential record for ``username``, or None."""
        ...
