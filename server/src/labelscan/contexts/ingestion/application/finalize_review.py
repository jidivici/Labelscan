"""Atomic finalization of a complete versioned trade-profile review."""

from __future__ import annotations

from dataclasses import dataclass

from labelscan.business_profiles import TRADE_PROFILES, trade_profile
from labelscan.contexts.ingestion.application.override_field import FIELD_NAMES
from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    FinalizedReview,
    ReviewRepository,
)
from labelscan.platform.http.access import AccessContext

FINAL_REVIEW_FIELDS: tuple[str, ...] = trade_profile("poissonnerie").fields
NOT_COMMUNICATED = "NC"

assert set(FINAL_REVIEW_FIELDS).issubset(FIELD_NAMES)


class ReviewNotFound(Exception):
    """The ingestion does not exist inside the authenticated organization."""


class ReviewNotAllowed(Exception):
    """The ingestion has not reached a review-ready state."""

    def __init__(self, status: str) -> None:
        super().__init__(status)
        self.status = status


class InvalidReviewFields(Exception):
    """The submitted field set is not an exact supported trade-profile contract."""

    def __init__(self, *, missing: set[str], extra: set[str]) -> None:
        self.missing = missing
        self.extra = extra
        super().__init__("invalid final review field set")


class IncompleteReviewFields(Exception):
    """The operator attempted to validate one or more empty values."""

    def __init__(self, fields: set[str]) -> None:
        self.fields = fields
        super().__init__("final review contains empty values")


class ReviewIdempotencyConflict(Exception):
    """A durable request key was reused for a different final review."""


@dataclass(frozen=True)
class FinalizeReviewCommand:
    ingestion_id: str
    organization_id: str
    fields: dict[str, str | None]
    idempotency_key: str
    actor_id: str
    correlation_id: str
    trace_id: str
    note: str | None = None
    photo_rotation_degrees: int = 0
    photo_base_rotation_degrees: int = -90
    access: AccessContext | None = None


class FinalizeReview:
    def __init__(self, repository: ReviewRepository) -> None:
        self._repository = repository

    def __call__(self, command: FinalizeReviewCommand) -> FinalizedReview:
        if command.photo_rotation_degrees not in (0, 180):
            raise ValueError("photo rotation must be 0 or 180 degrees")
        if command.photo_base_rotation_degrees not in (-90, 0):
            raise ValueError("photo base rotation must be -90 or 0 degrees")
        submitted = set(command.fields)
        contracts = [set(profile.fields) for profile in TRADE_PROFILES.values()]
        if submitted not in contracts:
            # Report the closest versioned contract. This preserves the useful
            # missing/unknown response before a DB lookup while allowing every
            # supported trade to submit its own exact field set.
            expected = min(
                contracts,
                key=lambda candidate: len(candidate ^ submitted),
            )
            raise InvalidReviewFields(
                missing=expected - submitted,
                extra=submitted - expected,
            )
        normalized: dict[str, str] = {}
        incomplete: set[str] = set()
        for name, value in command.fields.items():
            stripped = value.strip() if isinstance(value, str) else ""
            if not stripped:
                incomplete.add(name)
                continue
            normalized[name] = NOT_COMMUNICATED if stripped.upper() == NOT_COMMUNICATED else stripped
        if incomplete:
            raise IncompleteReviewFields(incomplete)
        result = self._repository.finalize(
            ingestion_id=command.ingestion_id,
            organization_id=command.organization_id,
            fields=normalized,
            note=command.note,
            photo_rotation_degrees=command.photo_rotation_degrees,
            photo_base_rotation_degrees=command.photo_base_rotation_degrees,
            idempotency_key=command.idempotency_key,
            audit=AuditContext(
                actor_id=command.actor_id,
                correlation_id=command.correlation_id,
                trace_id=command.trace_id,
            ),
            action="ingestion.review_finalized",
            access=command.access,
        )
        if result is None:
            raise ReviewNotFound(command.ingestion_id)
        return result
