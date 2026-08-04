"""Extraction consumer (adapter) — the outbox handler for `ingestion.raw_stored`.

Decoupled from ingestion (it runs in the relay worker, never called synchronously
by ingestion). The pure decision logic is the domain gate; this adapter only
orchestrates and writes.

Transaction model (the heart of the guarantees):
  * Steps 1-2 (OCR, LLM) each run in their OWN committed transaction and store the
    raw provider output as an immutable raw_artifact. Existence of that artifact is
    the dedup guard: on a retry the artifact is already there, so the external
    provider is NOT called again (no duplicate external calls).
  * Step 3 (gate) is pure.
  * Step 4 (persist run + fields + status) runs on the WORKER's connection, so it
    commits atomically with the worker's processed_event + published marks. The
    worker's processed_event guard makes the whole handler idempotent: a committed
    event is never reprocessed, and a crash before commit rolls step 4 back so the
    retry produces exactly one committed run.

extraction_run is append-only: every attempt is a NEW row, never an overwrite.
A failed validation routes to needs_review (HITL) — never silently accepted.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from labelscan.business_profiles import TradeProfile, trade_profile
from labelscan.contexts.ingestion.application.extraction_ports import (
    LlmExtractor,
    LlmResult,
    OcrProvider,
    OcrResult,
)
from labelscan.contexts.ingestion.domain.extraction import (
    GateOutcome,
    GateVerdict,
    LlmField,
    OcrQualityPolicy,
    RuleSet,
    Thresholds,
    evaluate,
    is_ocr_garbage,
)
from labelscan.contexts.ingestion.domain.gs1 import parse_gs1
from labelscan.contexts.ingestion.domain.interim_fields import extract_interim_fields
from labelscan.contexts.ingestion.domain.reconciliation import (
    adjusted_outcome,
    gs1_resolved_field_names,
    reconcile,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.observability import get_logger

_log = get_logger("ingestion.extraction")


class _RelayMessage(Protocol):
    # structural type of the message the relay delivers — avoids coupling this
    # consumer (which lives in the ingestion context) to platform.outbox concretely,
    # preserving the ingestion-decoupled-from-worker boundary.
    id: str
    payload: dict
    correlation_id: str
    trace_id: str


# The worker/system principal for extraction-initiated writes (no human actor).
SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001"

# Fields GS1 can supply exactly from the barcode (lot/DLC/weight/GTIN/packaging).
# Escalation re-extracts only FREE-TEXT required fields, never these — a barcode<->print
# conflict on lot/DLC is a real anomaly that must stay needs_review, never "fixed" by a
# second LLM pass (Work Item A rule).
_GS1_OWNED_FIELDS = frozenset(
    {"batch_number", "expiry_date", "weight", "gtin", "packaging_date"}
)


class _ProviderExhausted(Exception):
    """Raised when OCR/LLM keeps failing past the retry limit -> a FAILED run."""


# Exceptions that signal a bug in our own code, not a transient provider/IO
# condition. Retrying these is futile and would mask the defect behind a FAILED
# run, so they propagate out of the retry loop instead of being swallowed.
_NON_RETRYABLE = (TypeError, AttributeError, NameError, ImportError)


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _ocr_to_json(o: OcrResult) -> bytes:
    return json.dumps(
        {"full_text": o.full_text, "mean_confidence": o.mean_confidence, "page": o.page}
    ).encode()


def _ocr_from_json(b: bytes) -> OcrResult:
    d = json.loads(b)
    return OcrResult(
        raw_json=b,
        full_text=d["full_text"],
        mean_confidence=d["mean_confidence"],
        page=d["page"],
    )


def _llm_to_json(r: LlmResult) -> bytes:
    return json.dumps(
        {
            "extractor_version": r.extractor_version,
            "model": r.model,
            "prompt_version": r.prompt_version,
            "fields": [
                {
                    "name": f.name,
                    "value": f.value,
                    "llm_confidence": f.llm_confidence,
                    "evidence": list(f.evidence),
                    "validation_status": f.validation_status,
                    "warnings": list(f.warnings),
                }
                for f in r.fields
            ],
        }
    ).encode()


def _llm_from_json(b: bytes) -> LlmResult:
    d = json.loads(b)
    fields = tuple(
        LlmField(
            name=f["name"],
            value=f["value"],
            llm_confidence=f["llm_confidence"],
            evidence=tuple(f["evidence"]),
            validation_status=f["validation_status"],
            warnings=tuple(f["warnings"]),
        )
        for f in d["fields"]
    )
    return LlmResult(
        raw_json=b,
        fields=fields,
        extractor_version=d["extractor_version"],
        model=d["model"],
        prompt_version=d["prompt_version"],
    )


def _merge_raw_fields(
    primary_raw: tuple[LlmField, ...],
    escalated_raw: tuple[LlmField, ...],
    primary_eval,
    escalated_eval,
) -> tuple[LlmField, ...]:
    """Per field, keep the better of {primary, escalated}: a grounded value (non-null
    after the gate) with the higher combined_confidence. Returns the chosen RAW
    LlmFields so the merged set is re-gated by evaluate() — the gate stays the single
    source of truth (no relaxation). A field neither model grounds stays the primary's
    (null) field and still triggers needs_review."""
    p_eval = {e.name: e for e in primary_eval}
    e_eval = {e.name: e for e in escalated_eval}
    p_raw = {f.name: f for f in primary_raw}
    e_raw = {f.name: f for f in escalated_raw}
    chosen: dict[str, LlmField] = {}
    for name in (*p_raw, *e_raw):
        if name in chosen:
            continue
        pe, ee = p_eval.get(name), e_eval.get(name)
        take_escalated = (
            ee is not None
            and ee.value is not None
            and (
                pe is None
                or pe.value is None
                or ee.combined_confidence > pe.combined_confidence
            )
        )
        if take_escalated and name in e_raw:
            chosen[name] = e_raw[name]
        elif name in p_raw:
            chosen[name] = p_raw[name]
        else:
            chosen[name] = e_raw[name]
    return tuple(chosen.values())


class ExtractionConsumer:
    consumer_name = "extraction"
    event_type = "ingestion.raw_stored"

    def __init__(
        self,
        *,
        engine: Engine,
        raw_store,
        ocr: OcrProvider,
        llm: LlmExtractor,
        rule_set: RuleSet,
        thresholds: Thresholds | None = None,
        max_provider_attempts: int = 3,
        escalation_llm: LlmExtractor | None = None,
        escalation_enabled: bool = False,
        ocr_quality: OcrQualityPolicy | None = None,
        ocr_quality_gate_enabled: bool = True,
    ) -> None:
        self._engine = engine
        self._raw = raw_store
        self._ocr = ocr
        self._llm = llm
        self._rule_set = rule_set
        self._thresholds = thresholds or Thresholds()
        self._max_provider_attempts = max_provider_attempts
        # OCR-quality gate (cost saver): skip the LLM call on an illegible image. ON
        # by default; the policy thresholds are injected (read from env upstream).
        self._ocr_quality = ocr_quality or OcrQualityPolicy()
        self._ocr_quality_gate_enabled = ocr_quality_gate_enabled
        # Work Item A (two-tier escalation), OFF by default. The second tier is a
        # SECOND LlmExtractor bound to a stronger model; it is constructed/injected
        # regardless but is only ever CALLED when the flag is on AND the gated primary
        # would force needs_review on a recoverable free-text field (see __call__).
        self._escalation_llm = escalation_llm
        self._escalation_enabled = escalation_enabled

    # -- outbox handler signature: (message, worker transaction connection) --
    def __call__(self, msg: _RelayMessage, worker_conn: Connection) -> None:
        ingestion_id = msg.payload["ingestion_id"]
        organization_id = msg.payload["organization_id"]
        corr, trace = msg.correlation_id, msg.trace_id

        # Deterministic socle FIRST: parse the native-scanned barcode (exact data).
        (
            image_bytes,
            image_artifact_id,
            barcode_raw,
            loaded_organization_id,
            profile,
        ) = self._load_image_meta(ingestion_id, organization_id)
        if loaded_organization_id != organization_id:
            raise LookupError("ingestion tenant does not match its outbox event")
        active_rule_set = self._rule_set_for(profile)
        gs1 = parse_gs1(barcode_raw)
        known = tuple(gs1_resolved_field_names(gs1))  # prompt hint (advisory only)

        # Bounded provider retry: a transient OCR/LLM failure is retried up to a
        # limit; on exhaustion a FAILED run is recorded and the event is consumed
        # (published) — so there is NO infinite retry loop.
        _ocr_t0 = time.monotonic()
        try:
            ocr, ocr_artifact_id = self._with_provider_retry(
                lambda: self._ensure_ocr(
                    ingestion_id, organization_id, image_bytes, corr, trace
                )
            )
        except _ProviderExhausted as e:
            self._persist_failed(
                worker_conn,
                ingestion_id,
                corr,
                trace,
                error=str(e),
                rule_set_version=active_rule_set.version,
            )
            return
        # Latency instrumentation: ~0 ms on a dedup/replay (no external call), the real
        # provider time on a miss — isolates the dominant cost (docs/LATENCY-REVIEW.md §6).
        ocr_ms = (time.monotonic() - _ocr_t0) * 1000.0

        # OCR-quality gate (cost saver, BEFORE the LLM): an illegible image is not
        # worth an LLM call. Skip it, route to review with the distinct
        # `ocr_skipped_garbage` status, and STILL preserve the GS1 exact fields
        # (grounded in the barcode symbology, not the OCR). Biased to proceed — only
        # clearly-unusable reads are skipped, never a silent data drop.
        if self._ocr_quality_gate_enabled and is_ocr_garbage(
            ocr.full_text, ocr.mean_confidence, self._ocr_quality
        ):
            _log.info(
                "ocr_skipped_garbage_total",
                extra={
                    "ingestion_id": ingestion_id,
                    "ocr_mean_confidence": ocr.mean_confidence,
                    "correlation_id": corr,
                    "trace_id": trace,
                },
            )
            reconciled = reconcile(
                (),  # no LLM fields — GS1-only complement
                gs1,
                ocr_artifact_id=ocr_artifact_id,
                image_artifact_id=image_artifact_id,
            )
            self._persist_skipped_garbage(
                worker_conn,
                ingestion_id,
                reconciled,
                ocr_artifact_id,
                corr,
                trace,
                rule_set_version=active_rule_set.version,
            )
            return

        # ── Tier 3 wave 2: interim commit BETWEEN OCR and LLM ──────────────────
        # A separate, immediately-committed transaction (NOT worker_conn) writes the
        # conservative regex preview fields + bumps raw_stored -> ocr_done, so the
        # polling client renders wave 2 while the LLM below is still running. Best
        # effort by design: the preview is non-authoritative (the reconciled run
        # supersedes it), so a failure here must never fail the extraction.
        try:
            self._persist_interim(
                ingestion_id,
                ocr,
                known,
                corr,
                trace,
                organization_id=organization_id,
            )
        except Exception as e:  # noqa: BLE001 — preview only, never fatal
            _log.warning(
                "interim_persist_failed",
                extra={
                    "ingestion_id": ingestion_id,
                    "error": str(e),
                    "correlation_id": corr,
                    "trace_id": trace,
                },
            )

        _llm_t0 = time.monotonic()
        try:
            llm = self._with_provider_retry(
                lambda: self._ensure_llm(
                    ingestion_id,
                    organization_id,
                    ocr.full_text,
                    known,
                    corr,
                    trace,
                    profile=profile,
                    llm=self._llm,
                    model=self._llm.model,
                    is_primary=True,
                )
            )
        except _ProviderExhausted as e:
            self._persist_failed(
                worker_conn,
                ingestion_id,
                corr,
                trace,
                error=str(e),
                rule_set_version=active_rule_set.version,
            )
            return
        llm_ms = (time.monotonic() - _llm_t0) * 1000.0
        # The two external-call durations, side by side — so the dominant cost (almost
        # always the LLM) is measurable per ingestion (docs/LATENCY-REVIEW.md §6).
        _log.info(
            "extraction_timing",
            extra={
                "ingestion_id": ingestion_id,
                "ocr_ms": round(ocr_ms, 1),
                "llm_ms": round(llm_ms, 1),
                # Image size actually sent to Vision — correlates OCR time with payload
                # (Tier 7: a smaller image should shrink ocr_ms on a slow egress).
                "image_bytes": len(image_bytes),
                "correlation_id": corr,
                "trace_id": trace,
            },
        )

        # The anti-fabrication gate runs on the PRIMARY LLM fields UNCHANGED.
        verdict = self._gate(llm.fields, ocr, active_rule_set)

        # --- Two-tier escalation (Work Item A), BETWEEN the gate and reconcile. ---
        # The gate, GS1 precedence, and domain stay untouched. Escalate at most ONCE,
        # only when the flag is on AND a RULE-SET-REQUIRED FREE-TEXT field is null /
        # below-threshold and is NOT satisfied by GS1 (lot/DLC conflicts are excluded —
        # they stay needs_review). The escalation call counts toward the bounded provider
        # budget; on exhaustion we fall back to the primary verdict (no unbounded loop).
        escalation_model: str | None = None
        recoverable = self._recoverable_free_text(verdict, known)
        if (
            self._escalation_enabled
            and self._escalation_llm is not None
            and recoverable
        ):
            _log.info(
                "llm_escalation_total",
                extra={
                    "reason": "missing_required_free_text",
                    "model": self._escalation_llm.model,
                    "ingestion_id": ingestion_id,
                    "correlation_id": corr,
                    "trace_id": trace,
                },
            )
            try:
                esc = self._with_provider_retry(
                    lambda: self._ensure_llm(
                        ingestion_id,
                        organization_id,
                        ocr.full_text,
                        known,
                        corr,
                        trace,
                        profile=profile,
                        llm=self._escalation_llm,
                        model=self._escalation_llm.model,
                        is_primary=False,
                    )
                )
            except _ProviderExhausted as e:
                # Best-effort: a failed second tier never fails the run; the primary
                # verdict stands (it still routes the recoverable field to needs_review).
                _log.warning(
                    "llm_escalation_failed",
                    extra={
                        "reason": "provider_exhausted",
                        "model": self._escalation_llm.model,
                        "ingestion_id": ingestion_id,
                        "error": str(e),
                        "correlation_id": corr,
                        "trace_id": trace,
                    },
                )
            else:
                # Per field keep the better of {primary, escalated}; re-gate the merged
                # set ONCE so missing_required/unverifiable/etc. are the gate's own
                # verdict (no relaxation, no re-implementation of the gate).
                merged = _merge_raw_fields(
                    llm.fields,
                    esc.fields,
                    verdict.fields,
                    self._gate(esc.fields, ocr, active_rule_set).fields,
                )
                verdict = self._gate(merged, ocr, active_rule_set)
                escalation_model = self._escalation_llm.model

        # NET-NEW metric: the gate coerced fabricated (non-substring) evidence to null.
        if "EVIDENCE_NOT_IN_RAW_OCR" in verdict.security_flags:
            _log.info(
                "evidence_gate_reject_total",
                extra={
                    "ingestion_id": ingestion_id,
                    "model": self._llm.model,
                    "correlation_id": corr,
                    "trace_id": trace,
                },
            )

        # Merge exact GS1 truth over the LLM complement (GS1 wins on lot/DLC/…).
        reconciled = reconcile(
            verdict.fields,
            gs1,
            ocr_artifact_id=ocr_artifact_id,
            image_artifact_id=image_artifact_id,
        )
        # Option Y: re-derive the outcome from GS1-resolved data (gate `evaluate` is
        # untouched). A GS1-satisfied required field no longer forces review; a
        # barcode↔print conflict on lot/DLC does.
        outcome = adjusted_outcome(verdict, reconciled)

        if escalation_model is not None and outcome == GateOutcome.EXTRACTED:
            # A would-be needs_review (recoverable free-text field) became extracted.
            _log.info(
                "llm_escalation_resolved_total",
                extra={
                    "reason": "free_text_grounded",
                    "model": escalation_model,
                    "ingestion_id": ingestion_id,
                    "outcome": outcome.value,
                    "correlation_id": corr,
                    "trace_id": trace,
                },
            )

        self._persist(
            worker_conn,
            ingestion_id,
            outcome,
            reconciled,
            llm,
            ocr_artifact_id,
            corr,
            trace,
            escalation_model=escalation_model,
            rule_set_version=active_rule_set.version,
        )

    def _rule_set_for(self, profile: TradeProfile) -> RuleSet:
        if profile.code == "poissonnerie":
            return self._rule_set
        return RuleSet(
            version=f"trade-profile:{profile.code}:v{profile.version}",
            required_fields=frozenset(profile.required_fields),
        )

    def _gate(
        self,
        fields: tuple[LlmField, ...],
        ocr: OcrResult,
        rule_set: RuleSet,
    ) -> GateVerdict:
        """Run the anti-fabrication gate (the trust boundary) — never relaxed."""
        return evaluate(
            fields,
            ocr_text=ocr.full_text,
            ocr_confidence=ocr.mean_confidence,
            rule_set=rule_set,
            thresholds=self._thresholds,
            page=ocr.page,
        )

    def _recoverable_free_text(
        self, verdict: GateVerdict, gs1_known: tuple[str, ...]
    ) -> frozenset[str]:
        """Required FREE-TEXT fields the gated primary could not ground (null) or
        returned below the review threshold, AND that GS1 does not / cannot supply.
        These are the only fields a second LLM pass may recover; GS1-owned fields
        (lot/DLC/weight/GTIN/packaging) are excluded so a barcode<->print conflict
        stays needs_review."""
        weak = set(verdict.missing_required) | set(verdict.low_confidence_required)
        gs1_known_set = set(gs1_known)
        return frozenset(
            n for n in weak if n not in gs1_known_set and n not in _GS1_OWNED_FIELDS
        )

    def _with_provider_retry(self, fn):
        last: Exception | None = None
        for _ in range(self._max_provider_attempts):
            try:
                return fn()
            except _NON_RETRYABLE:
                raise  # programming error — surface it, don't swallow as a FAILED run
            except Exception as e:  # expected transient/provider failure
                last = e
        raise _ProviderExhausted(str(last))

    # ---- step helpers -------------------------------------------------------

    def _load_image_meta(
        self, ingestion_id: str, organization_id: str
    ) -> tuple[bytes, str, str | None, str, TradeProfile]:
        """Return image bytes, artifact id, barcode, tenant and trade profile."""
        with self._engine.begin() as c:
            set_tenant_context(c, organization_id)
            row = (
                c.execute(
                    text(
                        "SELECT artifact.id::text AS id, artifact.checksum_sha256, "
                        "artifact.organization_id::text AS organization_id, "
                        "ingestion.barcode_raw, ingestion.trade_code_snapshot, "
                        "ingestion.trade_profile_version "
                        "FROM ingestion.raw_artifact AS artifact "
                        "JOIN ingestion.ingestion AS ingestion "
                        "ON ingestion.id = artifact.ingestion_id "
                        "WHERE artifact.ingestion_id = :id "
                        "AND artifact.artifact_kind = 'image' "
                        "ORDER BY artifact.occurred_at LIMIT 1"
                    ),
                    {"id": ingestion_id},
                )
                .mappings()
                .one()
            )
        image_bytes = self._raw.read(
            checksum=row["checksum_sha256"],
            organization_id=row["organization_id"],
        )
        profile = trade_profile(
            row["trade_code_snapshot"], row["trade_profile_version"]
        )
        return (
            image_bytes,
            row["id"],
            row["barcode_raw"],
            row["organization_id"],
            profile,
        )

    def _ensure_ocr(
        self, ingestion_id, organization_id, image_bytes, corr, trace
    ) -> tuple[OcrResult, str]:
        with self._engine.begin() as c:
            set_tenant_context(c, organization_id)
            existing = (
                c.execute(
                    text(
                        "SELECT id, checksum_sha256 FROM ingestion.raw_artifact "
                        "WHERE ingestion_id = :id AND artifact_kind = 'ocr_json' LIMIT 1"
                    ),
                    {"id": ingestion_id},
                )
                .mappings()
                .first()
            )
            if existing:  # dedup: OCR already ran for this ingestion — no external call
                raw = self._raw.read(
                    checksum=existing["checksum_sha256"],
                    organization_id=organization_id,
                )
                return _ocr_from_json(raw), str(existing["id"])

            ocr = self._ocr.run(image_bytes)  # <-- external call (only on miss)
            normalized = _ocr_to_json(ocr)
            checksum = _sha(normalized)
            ref = self._raw.put(
                normalized,
                checksum=checksum,
                organization_id=organization_id,
            )
            set_audit_context(
                c,
                actor_id=SYSTEM_ACTOR,
                action="ingestion.ocr_stored",
                correlation_id=corr,
                trace_id=trace,
            )
            artifact_id = c.execute(
                text(
                    "INSERT INTO ingestion.raw_artifact "
                    "(ingestion_id, organization_id, artifact_kind, storage_ref, "
                    " checksum_sha256, correlation_id, trace_id) "
                    "VALUES (:id, :organization_id, 'ocr_json', :ref, :ck, :corr, :trace) "
                    "RETURNING id"
                ),
                {
                    "id": ingestion_id,
                    "organization_id": organization_id,
                    "ref": ref,
                    "ck": checksum,
                    "corr": corr,
                    "trace": trace,
                },
            ).scalar_one()
            return _ocr_from_json(normalized), str(artifact_id)

    def _ensure_llm(
        self,
        ingestion_id,
        organization_id,
        ocr_text,
        known_field_names,
        corr,
        trace,
        *,
        profile: TradeProfile,
        llm: LlmExtractor,
        model: str,
        is_primary: bool,
    ) -> LlmResult:
        # Dedup is (ingestion_id, artifact_kind, model)-aware: an existing llm_output
        # artifact for THIS model means the model already ran for this ingestion, so it
        # is NOT called again — the primary AND the escalation model each get at most
        # one external call per ingestion. Legacy rows (pre-0010) have model NULL and
        # count as the primary, so a legacy ingestion is never re-extracted by Haiku.
        if is_primary:
            where_model = "(model = :model OR model IS NULL)"
        else:
            where_model = "model = :model"
        with self._engine.begin() as c:
            set_tenant_context(c, organization_id)
            existing = (
                c.execute(
                    text(
                        "SELECT checksum_sha256 FROM ingestion.raw_artifact "
                        "WHERE ingestion_id = :id AND artifact_kind = 'llm_output' "
                        f"AND {where_model} LIMIT 1"
                    ),
                    {"id": ingestion_id, "model": model},
                )
                .mappings()
                .first()
            )
            if existing:  # dedup: this model already ran — no external call
                return _llm_from_json(
                    self._raw.read(
                        checksum=existing["checksum_sha256"],
                        organization_id=organization_id,
                    )
                )

            result = llm.run(  # <-- external call (only on miss)
                ocr_text,
                known_field_names,
                trade_code=profile.code,
                trade_profile_version=profile.version,
            )
            normalized = _llm_to_json(result)
            checksum = _sha(normalized)
            ref = self._raw.put(
                normalized,
                checksum=checksum,
                organization_id=organization_id,
            )
            set_audit_context(
                c,
                actor_id=SYSTEM_ACTOR,
                action="ingestion.llm_stored",
                correlation_id=corr,
                trace_id=trace,
            )
            c.execute(
                text(
                    "INSERT INTO ingestion.raw_artifact "
                    "(ingestion_id, organization_id, artifact_kind, model, storage_ref, "
                    " checksum_sha256, correlation_id, trace_id) "
                    "VALUES (:id, :organization_id, 'llm_output', :model, :ref, :ck, :corr, :trace)"
                ),
                {
                    "id": ingestion_id,
                    "organization_id": organization_id,
                    "model": model,
                    "ref": ref,
                    "ck": checksum,
                    "corr": corr,
                    "trace": trace,
                },
            )
            return _llm_from_json(normalized)

    def _persist_interim(
        self,
        ingestion_id,
        ocr,
        gs1_known,
        corr,
        trace,
        organization_id=None,
    ) -> None:
        """Tier 3 wave 2: commit the deterministic preview + the ocr_done transit.

        Own transaction on a clean connection (the final persist on worker_conn is
        untouched). Idempotent on redelivery: inserts are ON CONFLICT DO NOTHING and
        the status bump is guarded to the pre-LLM states, so a retry after a crash
        (or a replayed event) never regresses a terminal status or churns values.
        Fields the barcode ACTUALLY resolved (gs1_known) are skipped — the client
        already shows them at T+0 and the barcode (exact) must never be contradicted
        by a regex preview. On a no-barcode scan gs1_known is empty, so lot/dates DO
        get a preview — precisely the scans wave 2 exists for.
        """
        interim = tuple(
            f for f in extract_interim_fields(ocr.full_text) if f.name not in gs1_known
        )
        with self._engine.begin() as c:
            if organization_id:
                set_tenant_context(c, organization_id)
            set_audit_context(
                c,
                actor_id=SYSTEM_ACTOR,
                action="ingestion.ocr_done",
                correlation_id=corr,
                trace_id=trace,
            )
            for f in interim:
                c.execute(
                    text(
                        "INSERT INTO ingestion.interim_field "
                        "(ingestion_id, field_name, value, correlation_id, trace_id) "
                        "VALUES (:iid, :name, CAST(:val AS jsonb), :corr, :trace) "
                        "ON CONFLICT (ingestion_id, field_name) DO NOTHING"
                    ),
                    {
                        "iid": ingestion_id,
                        "name": f.name,
                        "val": json.dumps(f.value),
                        "corr": corr,
                        "trace": trace,
                    },
                )
            # Even with zero matched fields the transit itself is the signal the
            # progress banner binds to (Lecture du texte -> Analyse, for real).
            c.execute(
                text(
                    "UPDATE ingestion.ingestion SET status = 'ocr_done' "
                    "WHERE id = :id AND status IN ('raw_stored', 'ocr_running')"
                ),
                {"id": ingestion_id},
            )
        _log.info(
            "interim_persisted",
            extra={
                "ingestion_id": ingestion_id,
                "interim_field_count": len(interim),
                "correlation_id": corr,
                "trace_id": trace,
            },
        )

    def _persist(
        self,
        conn,
        ingestion_id,
        outcome,
        reconciled,
        llm,
        ocr_artifact_id,
        corr,
        trace,
        *,
        escalation_model: str | None = None,
        rule_set_version: str,
    ) -> None:
        set_audit_context(
            conn,
            actor_id=SYSTEM_ACTOR,
            action=f"ingestion.{outcome.value}",
            correlation_id=corr,
            trace_id=trace,
        )
        attempt_no = conn.execute(
            text(
                "SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM ingestion.extraction_run WHERE ingestion_id = :id"
            ),
            {"id": ingestion_id},
        ).scalar_one()
        # llm_model stays the PRIMARY model (provenance of the base run); escalation_model
        # is set only when the second tier ran (NULL otherwise) — additive, append-only.
        run_id = conn.execute(
            text(
                "INSERT INTO ingestion.extraction_run "
                "(ingestion_id, attempt_no, outcome, extractor_version, prompt_version, ocr_provider, "
                " llm_model, escalation_model, ocr_raw_ref, rule_set_version, correlation_id, trace_id) "
                "VALUES (:iid, :att, :out, :ev, :pv, :ocrp, :llm, :esc, :ocr_ref, :rsv, :corr, :trace) RETURNING id"
            ),
            {
                "iid": ingestion_id,
                "att": attempt_no,
                "out": outcome.value,
                "ev": llm.extractor_version,
                "pv": llm.prompt_version,
                "ocrp": self._ocr.name,
                "llm": llm.model,
                "esc": escalation_model,
                "ocr_ref": ocr_artifact_id,
                "rsv": rule_set_version,
                "corr": corr,
                "trace": trace,
            },
        ).scalar_one()

        self._write_fields(conn, run_id, reconciled)

        conn.execute(
            text("UPDATE ingestion.ingestion SET status = :st WHERE id = :id"),
            {"st": outcome.value, "id": ingestion_id},
        )
        _log.info(
            "extraction_persisted",
            extra={
                "ingestion_id": ingestion_id,
                "run_id": str(run_id),
                "outcome": outcome.value,
                "correlation_id": corr,
                "trace_id": trace,
            },
        )
        self._emit_completed(
            conn, ingestion_id, str(run_id), outcome.value, corr, trace
        )

    def _write_fields(self, conn, run_id, reconciled) -> None:
        # Reconciled fields already carry their final provenance + source ('llm' or
        # 'gs1'); this is a dumb writer. Storage invariants hold by construction:
        # value!=null ⇒ provenance + source_raw_artifact_id set; value==null ⇒ neither.
        for f in reconciled:
            has_value = f.value is not None
            conn.execute(
                text(
                    "INSERT INTO ingestion.extracted_field "
                    "(extraction_run_id, field_name, value, evidence, provenance, source_raw_artifact_id, "
                    " validation_status, warnings, llm_confidence, ocr_confidence, combined_confidence, "
                    " confidence_band, source) "
                    "VALUES (:rid, :name, CAST(:val AS jsonb), CAST(:ev AS jsonb), CAST(:prov AS jsonb), "
                    " :src, :vs, CAST(:warn AS jsonb), :lc, :oc, :cc, :band, :source)"
                ),
                {
                    "rid": run_id,
                    "name": f.field_name,
                    "val": json.dumps(f.value) if has_value else None,
                    "ev": json.dumps(list(f.evidence)) if f.evidence else None,
                    "prov": json.dumps(f.provenance) if f.provenance else None,
                    "src": f.source_raw_artifact_id,
                    "vs": f.validation_status,
                    "warn": json.dumps(list(f.warnings)),
                    "lc": f.llm_confidence,
                    "oc": f.ocr_confidence,
                    "cc": f.combined_confidence,
                    "band": f.confidence_band,
                    "source": f.source,
                },
            )

    def _persist_skipped_garbage(
        self,
        conn,
        ingestion_id,
        reconciled,
        ocr_artifact_id,
        corr,
        trace,
        *,
        rule_set_version: str,
    ) -> None:
        """Persist an OCR-quality-gated run: the LLM was SKIPPED (illegible image), so
        the run outcome is needs_review and the ingestion status is the distinct
        `ocr_skipped_garbage`. GS1 fields (if any) are still written; there is no LLM
        provenance. Append-only, with the same same-txn audit + event as the normal
        path — only the LLM call (the cost) is avoided."""
        set_audit_context(
            conn,
            actor_id=SYSTEM_ACTOR,
            action="ingestion.ocr_skipped_garbage",
            correlation_id=corr,
            trace_id=trace,
        )
        attempt_no = conn.execute(
            text(
                "SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM ingestion.extraction_run WHERE ingestion_id = :id"
            ),
            {"id": ingestion_id},
        ).scalar_one()
        # No LLM ran: outcome is needs_review (a human must see the unreadable label);
        # extractor/prompt versions mark the skip; llm_model records the CONFIGURED
        # model for provenance (it was NOT called — see ocr_skipped_garbage_total).
        # ocr_raw_ref points at the OCR artifact we DID produce.
        run_id = conn.execute(
            text(
                "INSERT INTO ingestion.extraction_run "
                "(ingestion_id, attempt_no, outcome, extractor_version, prompt_version, ocr_provider, "
                " llm_model, ocr_raw_ref, rule_set_version, correlation_id, trace_id) "
                "VALUES (:iid, :att, 'needs_review', 'ocr-skipped', 'ocr-skipped', :ocrp, "
                " :llm, :ocr_ref, :rsv, :corr, :trace) RETURNING id"
            ),
            {
                "iid": ingestion_id,
                "att": attempt_no,
                "ocrp": self._ocr.name,
                "llm": self._llm.model,
                "ocr_ref": ocr_artifact_id,
                "rsv": rule_set_version,
                "corr": corr,
                "trace": trace,
            },
        ).scalar_one()

        self._write_fields(conn, run_id, reconciled)

        conn.execute(
            text(
                "UPDATE ingestion.ingestion SET status = 'ocr_skipped_garbage' WHERE id = :id"
            ),
            {"id": ingestion_id},
        )
        _log.info(
            "extraction_persisted",
            extra={
                "ingestion_id": ingestion_id,
                "run_id": str(run_id),
                "outcome": "ocr_skipped_garbage",
                "correlation_id": corr,
                "trace_id": trace,
            },
        )
        # The event carries the RUN outcome (needs_review): downstream (traceability)
        # only registers a batch on 'extracted', so this correctly does not.
        self._emit_completed(
            conn, ingestion_id, str(run_id), "needs_review", corr, trace
        )

    def _persist_failed(
        self,
        conn,
        ingestion_id,
        corr,
        trace,
        *,
        error: str,
        rule_set_version: str,
    ) -> None:
        set_audit_context(
            conn,
            actor_id=SYSTEM_ACTOR,
            action="ingestion.extraction_failed",
            correlation_id=corr,
            trace_id=trace,
        )
        attempt_no = conn.execute(
            text(
                "SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM ingestion.extraction_run WHERE ingestion_id = :id"
            ),
            {"id": ingestion_id},
        ).scalar_one()
        run_id = conn.execute(
            text(
                "INSERT INTO ingestion.extraction_run "
                "(ingestion_id, attempt_no, outcome, extractor_version, prompt_version, ocr_provider, "
                " llm_model, ocr_raw_ref, rule_set_version, correlation_id, trace_id) "
                "VALUES (:iid, :att, 'extraction_failed', 'unknown', 'unknown', :ocrp, :llm, NULL, :rsv, :corr, :trace) "
                "RETURNING id"
            ),
            {
                "iid": ingestion_id,
                "att": attempt_no,
                "ocrp": self._ocr.name,
                "llm": self._llm.model,
                "rsv": rule_set_version,
                "corr": corr,
                "trace": trace,
            },
        ).scalar_one()
        conn.execute(
            text(
                "UPDATE ingestion.ingestion SET status = 'extraction_failed' WHERE id = :id"
            ),
            {"id": ingestion_id},
        )
        _log.error(
            "extraction_failed",
            extra={
                "ingestion_id": ingestion_id,
                "run_id": str(run_id),
                "error_code": "PROVIDER_EXHAUSTED",
                "error": error,
                "correlation_id": corr,
                "trace_id": trace,
            },
        )
        self._emit_completed(
            conn, ingestion_id, str(run_id), "extraction_failed", corr, trace
        )

    def _emit_completed(self, conn, ingestion_id, run_id, outcome, corr, trace) -> None:
        # event-chaining: the traceability context consumes this (same relay, same
        # transactional-outbox guarantees). Decoupled — no synchronous call.
        conn.execute(
            text(
                "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                "VALUES ('extraction.completed', CAST(:p AS jsonb), :corr, :trace)"
            ),
            {
                "p": json.dumps(
                    {"ingestion_id": ingestion_id, "run_id": run_id, "outcome": outcome}
                ),
                "corr": corr,
                "trace": trace,
            },
        )
