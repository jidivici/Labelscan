"""Composition root for extraction — wires the consumer onto the relay worker.

This is the single place producer/relay/consumer meet. Registering the consumer
here (not in the relay) keeps the platform relay free of any context import, and
keeps ingestion unable to import the consumer (the decoupling G-ARCH contract).
"""

from __future__ import annotations

import os

from labelscan.business_profiles import trade_profile
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.application.extraction_ports import OcrProvider
from labelscan.contexts.ingestion.domain.extraction import (
    OcrQualityPolicy,
    RuleSet,
    Thresholds,
)
from labelscan.platform.db.engine import make_engine
from labelscan.platform.outbox.worker import OutboxWorker

# PLACEHOLDER rule set — pending BLOCKER B2 (Compliance authors the versioned
# RequiredFieldRuleSet). This is configuration data, never fabricated regulatory truth.
_POISSONNERIE_PROFILE = trade_profile("poissonnerie")
_PLACEHOLDER_RULESET = RuleSet(
    version=(
        f"trade-profile:{_POISSONNERIE_PROFILE.code}:v{_POISSONNERIE_PROFILE.version}"
    ),
    required_fields=frozenset(_POISSONNERIE_PROFILE.required_fields),
)


def _env_prob(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a float in [0,1]") from exc
    if not 0.0 <= value <= 1.0:
        raise RuntimeError(f"{name} must be within [0,1]")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < 0:
        raise RuntimeError(f"{name} must be >= 0")
    return value


def ocr_quality_from_env() -> tuple[OcrQualityPolicy, bool]:
    """Build the OCR-quality gate policy + toggle from env. Defaults keep the gate ON
    with conservative thresholds (only a clearly-illegible image skips the LLM call).
    The thresholds are a quality heuristic, never regulatory truth."""
    enabled = _env_bool("LABELSCAN_OCR_QUALITY_GATE_ENABLED", True)
    policy = OcrQualityPolicy(
        min_chars=_env_int("LABELSCAN_OCR_MIN_CHARS", OcrQualityPolicy.min_chars),
        min_alnum_chars=_env_int(
            "LABELSCAN_OCR_MIN_ALNUM_CHARS", OcrQualityPolicy.min_alnum_chars
        ),
        min_mean_confidence=_env_prob(
            "LABELSCAN_OCR_MIN_CONFIDENCE", OcrQualityPolicy.min_mean_confidence
        ),
    )
    return policy, enabled


def thresholds_from_env() -> Thresholds:
    """Build the confidence Thresholds from env. Defaults preserve current behaviour
    EXACTLY (no change unless an operator sets these).

    These are a CONFIDENCE RULE: the values must be CALIBRATED on real labelled data
    (see scripts/calibrate_confidence.py) — never guessed. When you change them, bump
    the rule-set version so each extraction_run records which calibration produced it.
    A cheaper model (Haiku) is typically less precise than Opus → calibrate (or raise
    LABELSCAN_REVIEW_BELOW conservatively) before relying on auto-accept.
    """
    review_below = _env_prob("LABELSCAN_REVIEW_BELOW", 0.70)
    medium_at = _env_prob("LABELSCAN_BAND_MEDIUM_AT", 0.70)
    high_at = _env_prob("LABELSCAN_BAND_HIGH_AT", 0.90)
    if medium_at > high_at:
        raise RuntimeError("LABELSCAN_BAND_MEDIUM_AT must be <= LABELSCAN_BAND_HIGH_AT")
    return Thresholds(review_below=review_below, high_at=high_at, medium_at=medium_at)


def provider_max_attempts_from_env() -> int:
    """Bounded retry budget for transient provider errors, including HTTP 429."""

    attempts = _env_int("LABELSCAN_PROVIDER_MAX_ATTEMPTS", 6)
    if attempts < 1:
        raise RuntimeError("LABELSCAN_PROVIDER_MAX_ATTEMPTS must be >= 1")
    return attempts


def register_extraction_consumer(
    worker: OutboxWorker,
    *,
    ocr_provider: OcrProvider,
    raw_store,
    rule_set: RuleSet = _PLACEHOLDER_RULESET,
) -> None:
    """Wire extraction into the relay.

    The LLM default is Claude (built lazily so importing this module never requires
    the SDK). The OCR provider is injected (built by build_ocr_provider in ocr_wiring).
    """
    from labelscan.contexts.ingestion.adapters.claude_llm_provider import (
        ESCALATION_ENABLED,
        ESCALATION_MODEL,
        ClaudeLlmExtractor,
    )

    # Work Item A: a SECOND extractor bound to the escalation model is ALWAYS
    # constructed (same adapter, stronger model behind the same port), but the
    # consumer only ever CALLS it when ESCALATION_ENABLED is true AND the gated
    # primary would force needs_review on a recoverable free-text field. Flag off =>
    # built, never called, extraction path byte-for-byte unchanged.
    ocr_quality, ocr_quality_gate_enabled = ocr_quality_from_env()
    consumer = ExtractionConsumer(
        engine=make_engine(),
        raw_store=raw_store,
        ocr=ocr_provider,
        llm=ClaudeLlmExtractor(),
        rule_set=rule_set,
        thresholds=thresholds_from_env(),
        max_provider_attempts=provider_max_attempts_from_env(),
        escalation_llm=ClaudeLlmExtractor(model=ESCALATION_MODEL),
        escalation_enabled=ESCALATION_ENABLED,
        ocr_quality=ocr_quality,
        ocr_quality_gate_enabled=ocr_quality_gate_enabled,
    )
    worker.register(consumer.event_type, consumer.consumer_name, consumer)
