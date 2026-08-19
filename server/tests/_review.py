"""Helpers that publish an ingestion through the real final-review contract."""

from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.business_profiles import trade_profile
from labelscan.contexts.ingestion.adapters.sql_review_repository import (
    SqlReviewRepository,
)
from labelscan.contexts.ingestion.application.finalize_review import (
    FinalizeReview,
    FinalizeReviewCommand,
)
from tests.conftest import ACTOR_ID


def finalize_poissonnerie(
    engine: Engine,
    ingestion_id: str,
    *,
    lot: str = "L24-0917",
    supplier: str = "Nordic Seafood AS",
    use_by: str = "2026-06-20",
    packaging: str = "2026-06-10",
) -> str:
    """Confirm a fish-label ingestion exactly as the mobile reviewer does."""

    fields = {name: "NC" for name in trade_profile("poissonnerie").fields}
    fields.update(
        {
            "commercial_designation": "Atlantic Cod",
            "reseller_brand": supplier,
            "batch_number": lot,
            "expiry_date": use_by,
            "packaging_date": packaging,
            "scientific_name": "Gadus morhua",
            "FAO_area": "27",
            "production_method": "wild_caught",
        }
    )
    with engine.connect() as conn:
        organization_id = str(
            conn.execute(
                text("SELECT organization_id FROM ingestion.ingestion WHERE id = :id"),
                {"id": ingestion_id},
            ).scalar_one()
        )
    correlation_id = f"test-review-{uuid.uuid4().hex}"
    result = FinalizeReview(SqlReviewRepository(engine))(
        FinalizeReviewCommand(
            ingestion_id=ingestion_id,
            organization_id=organization_id,
            fields=fields,
            idempotency_key=correlation_id,
            actor_id=ACTOR_ID,
            correlation_id=correlation_id,
            trace_id=correlation_id,
            note="Validated by integration test",
        )
    )
    return result.run_id
