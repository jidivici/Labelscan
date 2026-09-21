"""Composition root for the ingestion use case (app layer wires adapters).

This is the only place the concrete adapters are bound to the ports. The
"internal only" entrypoint: callers obtain a configured SubmitIngestion and
invoke it directly — there is no public HTTP surface yet (that is PG-6).
"""

from __future__ import annotations

from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.application.submit_ingestion import SubmitIngestion
from labelscan.platform.db.engine import make_engine
from labelscan.platform.storage_factory import build_raw_store


def build_submit_ingestion() -> SubmitIngestion:
    engine = make_engine()
    return SubmitIngestion(
        raw_store=build_raw_store(),
        repository=SqlIngestionRepository(engine),
    )
