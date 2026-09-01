"""Identity domain — pure. Application roles and their capabilities.

No frameworks, no DB, no token format here (G-ARCH domain-purity). The login use
case returns an ``AuthenticatedUser``; adapters map it to a transport Principal
or a JWT.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass

SUPER_ADMIN_ROLE = "super_admin"
ADMIN_ROLE = "admin"
MANAGER_ROLE = "manager"
# ``operator`` was retired. Keep the symbol temporarily for old migration/import
# compatibility, but it is deliberately not an assignable role anymore.
OPERATOR_ROLE = "operator"
USER_ROLES: frozenset[str] = frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE, MANAGER_ROLE})

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

# Managers can scan, review, search, export and consult only their assigned portals.
# Administration of stores and accounts remains an administrator-only capability.
MANAGER_SCOPES: frozenset[str] = frozenset(
    scope for scope in FULL_APPLICATION_SCOPES if scope != "identity:admin"
) | frozenset({"identity:read"})
SUPER_ADMIN_SCOPES: frozenset[str] = FULL_APPLICATION_SCOPES | frozenset(
    {
        "identity:admins:manage",
        "identity:managers:manage",
        "identity:portals:manage",
        "identity:read",
    }
)
ADMIN_SCOPES: frozenset[str] = FULL_APPLICATION_SCOPES | frozenset(
    {"identity:managers:manage", "identity:portals:manage", "identity:read"}
)

_ROLE_SCOPES: dict[str, frozenset[str]] = {
    SUPER_ADMIN_ROLE: SUPER_ADMIN_SCOPES,
    ADMIN_ROLE: ADMIN_SCOPES,
    MANAGER_ROLE: MANAGER_SCOPES,
}


def normalize_identity_text(value: str, *, field: str, maximum: int) -> str:
    """Canonicalize a human identity label and reject spoofing characters."""

    normalized = unicodedata.normalize("NFC", value)
    if any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"}
        for character in normalized
    ):
        raise ValueError(f"{field} contains control or direction characters")
    normalized = " ".join(normalized.split())
    if not normalized:
        raise ValueError(f"{field} must not be blank")
    if len(normalized) > maximum:
        raise ValueError(f"{field} must be at most {maximum} characters")
    return normalized


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
    business_portal_ids: tuple[str, ...] = ()
    business_portal_id: str | None = None
    trade_code: str | None = None
    store_ids: tuple[str, ...] = ()


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
    business_portal_ids: tuple[str, ...] = ()
    business_portal_id: str | None = None
    trade_code: str | None = None
    store_ids: tuple[str, ...] = ()


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
    business_portal_ids: tuple[str, ...] = ()
