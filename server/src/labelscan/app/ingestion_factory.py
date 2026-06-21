"""Composition root for the ingestion use case (app layer wires adapters).

This is the only place the concrete adapters are bound to the ports. The
"internal only" entrypoint: callers obtain a configured SubmitIngestion and
invoke it directly — there is no public HTTP surface yet (that is PG-6).
"""

from __future__ import annotations

import os

from labelscan.contexts.ingestion.adapters.filesystem_raw_store import (
    FilesystemRawStore,
)
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.application.submit_ingestion import SubmitIngestion
from labelscan.platform.db.engine import make_engine


def build_submit_ingestion() -> SubmitIngestion:
    raw_store_dir = os.environ.get("LABELSCAN_RAW_STORE_DIR")
    if not raw_store_dir:
        raise RuntimeError(
            "LABELSCAN_RAW_STORE_DIR is not set (object-store base dir)."
        )
    engine = make_engine()
    return SubmitIngestion(
        raw_store=FilesystemRawStore(raw_store_dir),
        repository=SqlIngestionRepository(engine),
    )
