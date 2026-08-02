"""Identity domain — pure. Application roles and their capabilities.

No frameworks, no DB, no token format here (G-ARCH domain-purity). The login use
case returns an ``AuthenticatedUser``; adapters map it to a transport Principal
or a JWT.
"""

from __future__ import annotations

from dataclasses import dataclass

ADMIN_ROLE = "admin"
OPERATOR_ROLE = "operator"
USER_ROLES: frozenset[str] = frozenset(
    {ADMIN_ROLE, OPERATOR_ROLE}
)

FULL_APPLICATION_SCOPES: frozenset[str] = frozenset(
    {
        "ingestion:write",
        "ingestion:read",
        # Human override and final confirmation currently share this gate.
        "extraction:review",
        "catalog:read",
        "haccp:read",
        "alert:ack",
        "alert:resolve",
        "traceability:read",
        "export:read",
        "identity:admin",
    }
)

# Operators can scan, review, search, export and consult their store's catalogue.
# Administration of stores and accounts remains an administrator-only capability,
# enforced by the API as well as hidden by the web navigation.
OPERATOR_SCOPES: frozenset[str] = frozenset(
    scope for scope in FULL_APPLICATION_SCOPES if scope != "identity:admin"
)
ADMIN_SCOPES: frozenset[str] = FULL_APPLICATION_SCOPES

_ROLE_SCOPES: dict[str, frozenset[str]] = {
    ADMIN_ROLE: ADMIN_SCOPES,
    OPERATOR_ROLE: OPERATOR_SCOPES,
}


def scopes_for_role(role: str) -> frozenset[str]:
    """Scopes granted to a role. Unknown roles get nothing (fail closed)."""
    return _ROLE_SCOPES.get(role, frozenset())


@dataclass(frozen=True)
class StoredUser:
    """A credential record as loaded from the repository."""

    id: str  # uuid — recorded as the audit actor_id on authenticated writes
    username: str
    display_name: str
    password_hash: str
    role: str
    active: bool
    store_code: str | None
    organization_id: str | None = None
    organization_slug: str = "labelscan"
    store_id: str | None = None


@dataclass(frozen=True)
class AuthenticatedUser:
    """The identity established by a successful login — what goes into a token."""

    actor_id: str  # StoredUser.id (uuid)
    username: str  # logical principal / idempotency scope
    display_name: str
    role: str
    scopes: frozenset[str]
    store_code: str | None
    organization_id: str | None = None
    organization_slug: str = "labelscan"
    store_id: str | None = None


@dataclass(frozen=True)
class ManagedUser:
    """A user safe to expose to the administration API (never a password hash)."""

    id: str
    username: str
    display_name: str
    role: str
    active: bool
    store_code: str | None
    created_by: str
    created_at: str
    updated_at: str
    organization_id: str | None = None
    store_id: str | None = None
