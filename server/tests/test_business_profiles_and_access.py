"""Database-free proofs for trade profiles and portal data scoping."""

from __future__ import annotations

import pytest

from labelscan.business_profiles import COMMON_FIELDS, TRADE_PROFILES, trade_profile
from labelscan.contexts.traceability.application.catalog import (
    CatalogAccess,
    CatalogAccessDenied,
    CatalogArrivalNotFound,
    CatalogImageQuery,
    CatalogQuery,
    CatalogService,
)
from labelscan.platform.http.access import AccessContext, postgres_scope


class _ScopedRepository:
    def __init__(self) -> None:
        self.filters = None
        self.image_access = None

    def list_products(self, filters):
        self.filters = filters
        return [], 0

    def image_checksum(self, organization_id, batch_id, store_code, access):
        self.image_access = access
        if access.permits(
            organization_id=organization_id,
            store_id="store-1",
            business_portal_id="portal-1",
        ):
            return "a" * 64
        return None


def _manager_access(*portal_ids: str) -> AccessContext:
    return AccessContext(
        organization_id="organization-1",
        role="manager",
        business_portal_ids=frozenset(portal_ids),
    )


def test_three_versioned_trade_profiles_share_the_common_contract() -> None:
    assert set(TRADE_PROFILES) == {
        "poissonnerie",
        "boucherie",
        "charcuterie_traiteur",
    }
    assert {profile.version for profile in TRADE_PROFILES.values()} == {"1"}
    assert all(
        profile.fields[: len(COMMON_FIELDS)] == COMMON_FIELDS
        for profile in TRADE_PROFILES.values()
    )
    assert {code: len(profile.fields) for code, profile in TRADE_PROFILES.items()} == {
        "poissonnerie": 17,
        "boucherie": 22,
        "charcuterie_traiteur": 22,
    }
    assert all(profile.required_fields for profile in TRADE_PROFILES.values())
    assert "FAO_area" in trade_profile("poissonnerie").specific_fields
    assert "slaughter_country" in trade_profile("boucherie").specific_fields
    assert "ingredients" in trade_profile("charcuterie_traiteur").specific_fields


def test_portal_scope_never_grants_another_portal_or_organization() -> None:
    access = _manager_access("portal-1", "portal-2")
    assert access.permits(
        organization_id="organization-1",
        store_id="store-1",
        business_portal_id="portal-2",
    )
    assert not access.permits(
        organization_id="organization-1",
        store_id="store-1",
        business_portal_id="portal-3",
    )
    assert not access.permits(
        organization_id="organization-2",
        store_id="store-1",
        business_portal_id="portal-1",
    )


def test_operator_scope_never_falls_back_to_its_store_without_a_portal() -> None:
    access = AccessContext(
        organization_id="organization-1",
        role="operator",
        store_ids=frozenset({"store-1"}),
    )

    assert not access.permits(
        organization_id="organization-1",
        store_id="store-1",
        business_portal_id="portal-1",
    )
    predicate, params = postgres_scope(access, alias="arrival")
    assert "access_store_fallback" in predicate
    assert params["access_store_fallback"] is False


def test_postgres_scope_contains_tenant_store_and_portal_guards() -> None:
    predicate, params = postgres_scope(_manager_access("portal-1"), alias="arrival")
    assert "arrival.organization_id" in predicate
    assert "arrival.business_portal_id" in predicate
    assert "arrival.store_id" in predicate
    assert params["access_organization_id"] == "organization-1"
    assert params["access_portal_ids"] == ["portal-1"]
    assert params["access_organization_wide"] is False


def test_manager_catalogue_is_scoped_by_assigned_portals_without_store_code() -> None:
    repository = _ScopedRepository()
    access = _manager_access("portal-1", "portal-2")
    CatalogService(repository).list(
        CatalogQuery(
            access=CatalogAccess(
                store_code=None,
                organization_id="organization-1",
                context=access,
            ),
            requested_business_portal_id="portal-2",
            profession_code="boucherie",
            field_filters=(("animal_species", "bovine"),),
        )
    )
    assert repository.filters.access == access
    assert repository.filters.business_portal_id == "portal-2"
    assert repository.filters.profession_code == "boucherie"
    assert repository.filters.field_filters == (("animal_species", "bovine"),)


def test_manager_cannot_request_an_unassigned_portal() -> None:
    with pytest.raises(CatalogAccessDenied):
        CatalogService(_ScopedRepository()).list(
            CatalogQuery(
                access=CatalogAccess(
                    store_code=None,
                    organization_id="organization-1",
                    context=_manager_access("portal-1"),
                ),
                requested_business_portal_id="portal-2",
            )
        )


def test_image_lookup_receives_the_same_access_context() -> None:
    repository = _ScopedRepository()
    access = _manager_access("portal-1")
    checksum = CatalogService(repository).image_checksum(
        CatalogImageQuery(
            access=CatalogAccess(
                store_code=None,
                organization_id="organization-1",
                context=access,
            ),
            batch_id="batch-1",
        )
    )
    assert checksum == "a" * 64
    assert repository.image_access == access

    with pytest.raises(CatalogArrivalNotFound):
        CatalogService(_ScopedRepository()).image_checksum(
            CatalogImageQuery(
                access=CatalogAccess(
                    store_code=None,
                    organization_id="organization-1",
                    context=_manager_access("portal-9"),
                ),
                batch_id="batch-1",
            )
        )
