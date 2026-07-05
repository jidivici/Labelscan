"""ConfirmIngestion use case — the reviewer finalizes an arrivage (P3, audit §4.2 reste).

The per-field overrides (OverrideField) record WHAT was corrected; this records THAT
the review happened: the ingestion transitions to the terminal 'confirmed' status, on
the authoritative store, audited with the operator as actor. Downstream consumers
(exports, HACCP reporting) can then distinguish "machine-extracted" from
"human-reviewed" without reconstructing it from field sources.

Pure application logic: state rules live in the repository's guarded transition
(review-ready states only — confirming a still-processing or failed ingestion would
assert a review that never happened). Idempotent: re-confirming replays.
"""

from __future__ import annotations

from dataclasses import dataclass

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    ConfirmedIngestion,
    ConfirmIngestionRepository,
)

_ACTION = "ingestion.confirmed"


class IngestionNotFound(Exception):
    """No such ingestion (→ 404)."""


@dataclass(frozen=True)
class ConfirmIngestionCommand:
    ingestion_id: str
    actor_id: str  # authenticated reviewer
    correlation_id: str
    trace_id: str


class ConfirmIngestion:
    def __init__(self, repository: ConfirmIngestionRepository) -> None:
        self._repository = repository

    def __call__(self, cmd: ConfirmIngestionCommand) -> ConfirmedIngestion:
        result = self._repository.confirm(
            ingestion_id=cmd.ingestion_id,
            audit=AuditContext(
                actor_id=cmd.actor_id,
                correlation_id=cmd.correlation_id,
                trace_id=cmd.trace_id,
            ),
            action=_ACTION,
        )
        if result is None:
            raise IngestionNotFound(cmd.ingestion_id)
        return result
