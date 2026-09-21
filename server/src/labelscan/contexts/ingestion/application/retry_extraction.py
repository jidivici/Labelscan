"""Requeue a provider-failed extraction without asking for another photo."""

from __future__ import annotations

from dataclasses import dataclass

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    ExtractionRetryRepository,
    RetriedExtraction,
)
from labelscan.platform.http.access import AccessContext


class ExtractionRetryNotFound(Exception):
    """The ingestion does not exist in the authenticated scope."""


class ExtractionRetryNotAllowed(Exception):
    """The ingestion is not in a provider-failed or already-retrying state."""

    def __init__(self, status: str) -> None:
        super().__init__(status)
        self.status = status


@dataclass(frozen=True)
class RetryExtractionCommand:
    ingestion_id: str
    organization_id: str
    actor_id: str
    correlation_id: str
    trace_id: str
    access: AccessContext | None = None


class RetryExtraction:
    def __init__(self, repository: ExtractionRetryRepository) -> None:
        self._repository = repository

    def __call__(self, command: RetryExtractionCommand) -> RetriedExtraction:
        result = self._repository.retry(
            ingestion_id=command.ingestion_id,
            organization_id=command.organization_id,
            audit=AuditContext(
                actor_id=command.actor_id,
                correlation_id=command.correlation_id,
                trace_id=command.trace_id,
            ),
            action="ingestion.extraction_retried",
            access=command.access,
        )
        if result is None:
            raise ExtractionRetryNotFound(command.ingestion_id)
        return result
