"""Identity domain — pure. The single application role and what it may do.

No frameworks, no DB, no token format here (G-ARCH domain-purity). The login use
case returns an ``AuthenticatedUser``; adapters map it to a transport Principal
or a JWT.
"""

from __future__ import annotations

from dataclasses import dataclass

# The single application role. 'admin' is granted exactly the scope set the
# existing require_scope() gates already use — auth is additive: it does not
# invent new scopes, it just authenticates who carries them.
ADMIN_ROLE = "admin"

ADMIN_SCOPES: frozenset[str] = frozenset(
    {
        "ingestion:write",
        "ingestion:read",
        "haccp:read",
        "alert:ack",
        "alert:resolve",
        "traceability:read",
    }
)

_ROLE_SCOPES: dict[str, frozenset[str]] = {ADMIN_ROLE: ADMIN_SCOPES}


def scopes_for_role(role: str) -> frozenset[str]:
    """Scopes granted to a role. Unknown roles get nothing (fail closed)."""
    return _ROLE_SCOPES.get(role, frozenset())


@dataclass(frozen=True)
class StoredUser:
    """A credential record as loaded from the repository."""

    id: str  # uuid — recorded as the audit actor_id on authenticated writes
    username: str
    password_hash: str
    role: str
    is_active: bool


@dataclass(frozen=True)
class AuthenticatedUser:
    """The identity established by a successful login — what goes into a token."""

    actor_id: str  # StoredUser.id (uuid)
    username: str  # logical principal / idempotency scope
    role: str
    scopes: frozenset[str]
