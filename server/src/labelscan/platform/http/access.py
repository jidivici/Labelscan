"""Framework-free data-scope derived from an authenticated principal.

Roles decide *capabilities* elsewhere.  This value object decides which tenant,
store and business-portal rows a capability may operate on.  Keeping the two
concerns separate prevents a broad scope (for example ``catalog:read``) from
silently becoming organization-wide access.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

_ORGANIZATION_WIDE_ROLES = frozenset({"super_admin", "admin"})


def _identifiers(value: Any) -> frozenset[str]:
    if value is None:
        return frozenset()
    if isinstance(value, str):
        normalized = value.strip()
        return frozenset({normalized}) if normalized else frozenset()
    if isinstance(value, Iterable):
        return frozenset(str(item).strip() for item in value if str(item).strip())
    normalized = str(value).strip()
    return frozenset({normalized}) if normalized else frozenset()


@dataclass(frozen=True)
class AccessContext:
    organization_id: str
    role: str
    store_ids: frozenset[str] = frozenset()
    business_portal_ids: frozenset[str] = frozenset()
    trade_codes: frozenset[str] = frozenset()
    organization_wide: bool = False

    @property
    def is_scoped(self) -> bool:
        return not self.organization_wide

    def permits(
        self,
        *,
        organization_id: str,
        store_id: str | None,
        business_portal_id: str | None,
    ) -> bool:
        if organization_id != self.organization_id:
            return False
        if self.organization_wide:
            return True
        if self.role == "operator":
            return bool(
                business_portal_id and business_portal_id in self.business_portal_ids
            )
        if self.business_portal_ids:
            return bool(
                business_portal_id and business_portal_id in self.business_portal_ids
            )
        # Compatibility during the additive portal-claim rollout.  Once every
        # operator token carries a portal id, this remains useful for historical
        # rows that have a store but no attributable portal.
        return bool(store_id and store_id in self.store_ids)


def access_context_for_principal(
    principal: Any, *, default_organization_id: str | None = None
) -> AccessContext:
    organization_id = str(
        getattr(principal, "organization_id", None) or default_organization_id or ""
    )
    role = str(getattr(principal, "role", None) or "operator")

    portal_ids = set(_identifiers(getattr(principal, "portal_ids", None)))
    portal_ids.update(_identifiers(getattr(principal, "business_portal_ids", None)))
    portal_ids.update(_identifiers(getattr(principal, "business_portal_id", None)))
    store_ids = set(_identifiers(getattr(principal, "store_ids", None)))
    store_ids.update(_identifiers(getattr(principal, "store_id", None)))
    trade_codes = set(_identifiers(getattr(principal, "trade_codes", None)))
    trade_codes.update(_identifiers(getattr(principal, "trade_code", None)))

    # Header-auth compatibility tests predate tenant claims.  Production bearer
    # validation rejects a missing tenant before this function is reached.
    legacy_untenantized = not getattr(principal, "organization_id", None)
    return AccessContext(
        organization_id=organization_id,
        role=role,
        store_ids=frozenset(store_ids),
        business_portal_ids=frozenset(portal_ids),
        trade_codes=frozenset(trade_codes),
        organization_wide=role in _ORGANIZATION_WIDE_ROLES or legacy_untenantized,
    )


def postgres_scope(
    access: AccessContext,
    *,
    alias: str,
    organization_column: str = "organization_id",
    store_column: str = "store_id",
    portal_column: str = "business_portal_id",
    parameter_prefix: str = "access",
) -> tuple[str, dict[str, object]]:
    """Return a parameterized PostgreSQL predicate for a portal-owned row."""

    org = f"{parameter_prefix}_organization_id"
    wide = f"{parameter_prefix}_organization_wide"
    stores = f"{parameter_prefix}_store_ids"
    portals = f"{parameter_prefix}_portal_ids"
    store_fallback = f"{parameter_prefix}_store_fallback"
    predicate = (
        f"{alias}.{organization_column}::text = :{org} AND (:{wide} OR "
        f"{alias}.{portal_column}::text = ANY(CAST(:{portals} AS text[])) OR ("
        f":{store_fallback} AND cardinality(CAST(:{portals} AS text[])) = 0 AND "
        f"{alias}.{store_column}::text = ANY(CAST(:{stores} AS text[]))))"
    )
    return predicate, {
        org: access.organization_id,
        wide: access.organization_wide,
        stores: sorted(access.store_ids),
        portals: sorted(access.business_portal_ids),
        store_fallback: access.role != "operator",
    }
