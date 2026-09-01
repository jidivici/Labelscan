# LabelScan — Architecture Synthesis

> **Archived:** Historical design synthesis, not current development guidance. See the
> [archive index](README.md) and [enterprise architecture](../ENTERPRISE-ARCHITECTURE.md).

> Archivé le 20 août 2026 : synthèse de conception partiellement implémentée, supplantée par les références thématiques.

**Status:** Partially implemented (Phases 0–4 shipped; Phase 5 in progress). This document
remains the coherent reference for the full design; implementation deltas are noted inline.
**Date:** 2026-06-18 (updated from 2026-06-14 consolidation)
**Author:** Software Architect (Synthesis)
**Scope:** `LabelScan/` only. Sibling projects (FishTrac, TRACEO, TRACEO1) out of scope.
**System:** HACCP-oriented seafood traceability for large-scale retail fishmongery.

> This document **merges** every Phase-1 deliverable into one coherent reference, lists every
> contradiction found across them, resolves each reconcilable conflict by choosing between the
> **existing** options (with a stated trade-off), and **STOPs / flags as a BLOCKER** anything that
> cannot be resolved by consolidation alone. It introduces **no** new fields, endpoints, tables,
> events, or features. Where a synthesis-level alignment is required, it is recorded as a
> **documented change list against the source-of-truth artifact**, never as new SQL/code, and any
> case that needs a genuine human decision is escalated in §8.

---

## 1. Synthesis method & sources

### 1.1 What was merged (the complete input set, all read in full)

| Cluster | Files |
|---------|-------|
| Architecture | `docs/architecture/ARCHITECTURE.md`; ADRs `0001`–`0007` + `adr/README.md` |
| Backend | `docs/backend/BACKEND-ARCHITECTURE.md`, `docs/backend/API-CONTRACTS.md`, `docs/backend/openapi.v1.yaml` |
| Extraction | `docs/extraction/PROMPT-CONTRACT.md`, `docs/extraction/schema/extraction.v1.schema.json`, the 3 `docs/extraction/test-cases/*` (a/b/c) |
| Pipeline | `docs/pipeline/PIPELINE-ARCHITECTURE.md`, `docs/pipeline/shared-state.schema.json`, `docs/pipeline/eval-suite.md` |
| AI pipeline | `docs/ai-pipeline/AI-PIPELINE.md`, `docs/ai-pipeline/model-and-cost-notes.md` |
| Database | `docs/database/DATABASE.md`, `docs/database/schema.sql`, `docs/database/migrations/0001_*`, `0002_*` |
| Operations | `docs/operations/SRE-RELIABILITY.md` |
| Audit | `AUDIT.md`; plan in `CLAUDE.md` |

### 1.2 Precedence / authority rule (applied whenever two documents disagree)

The merge applies **the source-of-truth doctrine each artifact already declares for itself**, ordered by topic. Justification: each downstream author explicitly wrote "builds on and does not contradict" the upstream, and named a single owning artifact per concern. The synthesis honours that ownership rather than averaging.

| Topic | Authoritative source | Why |
|-------|---------------------|-----|
| Bounded contexts, aggregates, domain events, dependency law, phases | **`ARCHITECTURE.md` §2/§6/§7/§5/§9** + ADRs | The root design; every other doc references it as locked. |
| ADR-level decisions (monolith, ports, raw-before-normalized, append-only audit, confidence-on-field, DDD-per-context, stack) | the **ADR file** for that decision | ADRs are the decision system-of-record. |
| **LLM output contract** (the JSON the model emits: field set, per-field object, validation_status, evidence) | **`extraction/schema/extraction.v1.schema.json`** (+ PROMPT-CONTRACT) | The schema is the machine-checked contract; PROMPT-CONTRACT §3/§5 and the gate enforce exactly it. |
| **Persisted data model** (tables, columns, enums, stored field set, immutability DDL) | **`database/schema.sql`** (DATABASE.md is its prose) | The DB is the system of record; it reconciled the heterogeneous shapes into typed columns. |
| **Composite confidence** (llm/ocr/combined/band semantics) | **`ai-pipeline/AI-PIPELINE.md` §4** (DB stores it) | The AI Engineer owns how the three signals combine; DB persists the result. |
| **API surface, error codes, idempotency, auth, validation gate, SLO seeds** | **`backend/BACKEND-ARCHITECTURE.md`** + `API-CONTRACTS.md`; `openapi.v1.yaml` is the skeleton | Backend layer owns transport; the YAML is explicitly "skeleton, keep in sync." |
| **Pipeline topology, stage list, envelope, HITL gates, fallbacks** | **`pipeline/PIPELINE-ARCHITECTURE.md`** + `shared-state.schema.json` | The Multi-Agent Architect owns the flow inside the Ingestion context. |
| **Default models/providers** (concrete) | **`ai-pipeline/model-and-cost-notes.md`** (the single place allowed to name them) | All other docs are deliberately provider-agnostic; only this one names models. |
| **SLOs/reliability/observability extensions, retention** | **`operations/SRE-RELIABILITY.md`** (extends BACKEND §10) | SRE is the named owner of the operability extension. |

**Tie-break rule for representation conflicts:** where the **stored/contract** form (DB or extraction.v1) disagrees with an **illustrative** form (an OpenAPI example, an ADR sketch), the stored/contract form wins and the illustrative form is recorded as an alignment delta — because the DB and the JSON schema are what the running system and CI actually validate against, whereas examples are documentation.

---

## 2. Contradiction register

Severity: **BLOCKER** = needs a genuine human decision or is a true contradiction → see §8. **Reconcilable** = resolved here by choosing between existing options with a trade-off (no new option invented). Every row cites file:section.

| ID | Topic | Doc A says (file:§) | Doc B says (file:§) | Severity | Resolution (trade-off) / STOP |
|----|-------|---------------------|---------------------|----------|-------------------------------|
| **C1** | **Field count 15 vs 16** | `DATABASE.md` §"note on field count" + `schema.sql` §1d CHECK → **15 substantive fields**; label-level `raw_warnings` stored on `extraction_run.raw_warnings` | `extraction.v1.schema.json` `fields.required` → **16 keys** (15 + a per-field `raw_warnings` stub); `model-and-cost-notes.md` §6 says "16 fields"; all 3 test-cases carry the 16th `raw_warnings` stub | **Reconcilable** | **Authoritative count = 15 substantive label fields.** The 16th key (`raw_warnings`-as-a-field) is an artefact of the JSON schema keeping a symmetric closed set; PROMPT-CONTRACT §3 itself instructs the model to emit it as a permanent `null/missing` stub and to put real anomalies in the **top-level** `raw_warnings` array. DATABASE already resolved this correctly: persist 15 `extracted_field` rows, store label anomalies on `extraction_run.raw_warnings`. No field is invented. **Trade-off:** we keep the schema's 16-key closed set (LLM output stability, `additionalProperties:false`) but never persist the 16th as a field row — a one-line CHECK already encodes this. **Delta:** see §4.1 note; the "16" in `model-and-cost-notes.md §6` should read "15 substantive fields (+ a null `raw_warnings` stub key)". |
| **C2** | **Per-field object shape (evidence vs provenance)** | `extraction.v1.schema.json` + `PROMPT-CONTRACT.md` §3 + `schema.sql` extracted_field + test-cases → `value/confidence/evidence/validation_status/warnings` | `ADR-0005` + `openapi.v1.yaml` `ExtractedField`/`Provenance` + `API-CONTRACTS.md` §4.2 → `value/confidence/provenance` (provenance = `{source, extractor_version, source_ref}`); no `evidence`/`validation_status`/`warnings` | **Reconcilable** | These describe **two layers of the same field**, not a contradiction. **(a) Producer/stored shape** (LLM emits, DB stores) = the 5-key extraction.v1 object — authoritative per precedence. **(b) API read-model** = the backend's projection: `evidence` is the raw substrings, `provenance.source_ref` points into the raw OCR (same fact, named differently). `validation_status` + `warnings` exist in DB and should be **surfaced** in the API view, not dropped. **Resolution:** treat extraction.v1/DB as canonical; the OpenAPI `ExtractedField` is an under-specified projection. **Delta (alignment, not new feature):** the API `ExtractedField`/`ExtractionView` should expose `validation_status` and per-field `warnings` and rename `provenance.source_ref`↔`evidence` consistently so the read-model is a faithful projection of the stored row. **Trade-off:** a little extra mapping at the edge; buys "what the API returns = what was stored." |
| **C3** | **Confidence: single scalar vs three-part composite** | `openapi.v1.yaml` `Confidence {score, band}`; `extraction.v1` per-field `confidence` = single 0–1 number | `AI-PIPELINE.md` §4 + `schema.sql` extracted_field → `llm_confidence`, `ocr_confidence`, `combined_confidence`, `confidence_band` | **Reconcilable** | Not a conflict: the model self-reports **one** number (a hint, never trusted — PROMPT-CONTRACT SC9); the backend gate **derives** the composite (`combined` bounded by OCR floor, capped by validation) and the `band`. DB stores all four; the API `Confidence.score` = `combined_confidence`, `Confidence.band` = `confidence_band`. **Resolution:** keep all four in DB (authoritative), expose `{score=combined, band}` in the API as already drafted. **Trade-off:** API hides the component signals; acceptable (they are queryable in DB for "why"). No change required beyond documenting `score == combined_confidence`. |
| **C4** | **API `FieldName` enum vs the real field names** | `openapi.v1.yaml` `FieldName` enum + `API-CONTRACTS.md` §3 PATCH enum = `species, scientific_name, production_method, fao_area, gear_type, lot, gtin, use_by, storage_temp` (9 names) | `extraction.v1.schema.json` + `schema.sql` extracted_field CHECK = `product_name, commercial_designation, scientific_name, batch_number, supplier_name, origin_country, FAO_area, production_method, fishing_gear_or_farming_method, expiry_date, packaging_date, storage_temperature, allergens, weight, price` (15 names) | **Reconcilable** | The OpenAPI/API-CONTRACTS field list is an **earlier, abbreviated, mismatched** enum (`lot`≠`batch_number`, `gtin`/`gear_type` not in the extraction set, `storage_temp`≠`storage_temperature`, `fao_area`≠`FAO_area`, `species`≠`scientific_name`). **Authoritative names = extraction.v1/DB** (the contract CI validates, the columns that exist). **Resolution:** the API `FieldName` enum must be **aligned to the 15 extraction.v1 names** for `PATCH /fields/{field_name}`, `missing_required_fields`, `low_confidence_fields`. **This is a delta, not a new field** (the fields already exist; only the enum text was wrong). **Trade-off:** the abbreviated names read nicer, but divergent names break the no-fabrication evidence chain and the override→column mapping; correctness wins. **Note:** `gtin`/`gear_type` are **not** extraction fields — `gtin` lives on `batch`/`product` (set from `barcode_raw`, GS1-checked), gear info maps to `fishing_gear_or_farming_method`; the override enum must drop `gtin`/`gear_type`/`lot` and use the canonical names. |
| **C5** | **`Provenance.source` enum includes `ocr`/`barcode`; DB `extracted_field.source` is only `llm`/`human`** | `openapi.v1.yaml` `Provenance.source` enum = `[ocr, llm, barcode, human]`; ADR-0005 same | `schema.sql` extracted_field `source` CHECK = `('llm','human')` | **Reconcilable** → **RESOLVED in code:** DB `source` column now ∈ `{llm, gs1, human}` (migration 0008). `gs1` added for GS1 barcode-derived fields (confidence 1.0, bypass evidence gate). `ocr`/`barcode` remain provenance origins, never value-writers. **Delta:** §4.2 — narrow API `Provenance.source` to `{llm, gs1, human}` or document `ocr`/`barcode` as never-emitted. |
| **C6** | **Ingestion status enum — short vs full set** | `ARCHITECTURE.md` §2.1/§7.1 = `raw_stored → ocr_done → extracted → needs_review → confirmed` (+`rejected` implied) | `schema.sql` ingestion CHECK = 12 states incl. `ocr_running, ocr_failed, ocr_skipped_garbage, extraction_running, extraction_failed, halted_missing_context`; `shared-state.schema.json` status enum = identical 12; `openapi.v1.yaml` `IngestionStatus` = 8 (`raw_stored, ocr_done, extracted, needs_review, confirmed, rejected, ocr_failed, extraction_failed`) | **Reconcilable** | ARCHITECTURE states the **lifecycle happy path** (it says "→", a path, not the closed enum); the DB + pipeline envelope hold the **full operational state machine**. These are subset/superset, not contradictory. **Authoritative enum = `schema.sql` + `shared-state.schema.json` (12 states)** — identical between them. The OpenAPI `IngestionStatus` (8) is a public subset that omits internal/transient states (`ocr_running`, `extraction_running`, `ocr_skipped_garbage`, `halted_missing_context`); acceptable as a public projection but should map the hidden ones to the nearest public state or be extended. **Trade-off:** a smaller public enum is simpler for clients but can surface a status the client can't name; **Delta:** §4.3 — extend `IngestionStatus` to the 12 (or document the projection mapping). |
| **C7** | **`production_method` value vocabulary** | `extraction.v1.schema.json` productionMethodField + `schema.sql` batch CHECK = `wild_caught`/`farmed` | `openapi.v1.yaml` `BatchCreate.production_method` enum = `[wild, farmed]`; `ARCHITECTURE.md` §2.2 prose "wild/farmed" | **Reconcilable** | Authoritative tokens = `wild_caught`/`farmed` (extraction.v1 + DB CHECK). `wild` in the OpenAPI `BatchCreate` is an abbreviation drift. **Resolution:** align OpenAPI `BatchCreate.production_method` to `[wild_caught, farmed]`. **Trade-off:** none — `wild` was never stored. **Delta:** §4.2. |
| **C8** | **Audit hash-chaining: present or deferred?** | `ADR-0004` = DB grants + trigger; **hash-chaining NOT specified** (rejects app-level audit only) | `DATABASE.md` §3.4 + `schema.sql` audit_log `prev_hash`/`entry_hash` + `BACKEND §12 S8` + `SRE RB-4` describe **optional hash-chaining** | **Reconcilable** | Every doc that mentions chaining calls it **optional / tamper-evidence add-on**, and DATABASE §3.4 flags the external anchor as "a policy decision, not fabricated here." ADR-0004's mechanism (grants+trigger) is the **floor**; hash-chaining is an **additive option** on top, consistent with "append-only audit." **Resolution:** append-only + grants + trigger is mandatory (all docs agree); hash-chaining + external anchoring is an **optional hardening**, owner = Compliance/Security. **Trade-off:** chaining serialises appends (DATABASE §3.4) — mitigated by per-partition chains. No contradiction; the columns exist but are nullable (`prev_hash` nullable). |
| **C9** | **OCR mean-confidence column name** | `BACKEND/ARCHITECTURE` event `OcrCompleted.mean_token_confidence`; `shared-state.schema.json` ocrResult `mean_token_confidence` | `schema.sql` stores `extraction_run.mean_token_confidence` (run-level), not on a separate ocr row | **Reconcilable** | Same value, persisted on `extraction_run` (the OCR result is one input to the run). No conflict; the raw OCR JSON (with per-token confidence) lives in `raw_artifact.raw_json`. Documented mapping only. |
| **C10** | **`gear_type` / `fishing_gear` naming** | `openapi.v1.yaml` `BatchCreate.gear_type`, `FieldName` `gear_type` | `extraction.v1`/`schema.sql` use `fishing_gear_or_farming_method`; `batch` table has **no** gear column | **Reconcilable** | Gear maps to extraction field `fishing_gear_or_farming_method`. The `batch` table does **not** project a gear column (DATABASE chose to project only `use_by, packaging_date, production_method, gtin, species_scientific, fao_area_code`). **Resolution:** `gear_type` in `BatchCreate` has no backing column → either drop it from `BatchCreate` or add a projection; since "no new columns," **drop `gear_type` from the API `BatchCreate`/`FieldName`** and keep gear only as an extraction field surfaced via the extraction view. **Trade-off:** gear is not directly queryable on `batch` (it is on the extraction run); acceptable — HACCP does not scan by gear. **Delta:** §4.2. |
| **C11** | **`BatchCreate` carries `scientific_name`/`species` but DB `batch` stores `species_scientific` only** | `openapi.v1.yaml` `BatchCreate` has `species` (required) + `scientific_name` | `schema.sql` batch has `species_scientific` (denormalized snapshot) + `product.name`; `product.species_id`→`compliance.species` | **Reconcilable** | The API's `species`/`scientific_name` map to `batch.species_scientific` + `product`/`compliance.species`. Naming/normalization drift, not a missing concept. **Resolution:** document the mapping `BatchCreate.scientific_name → batch.species_scientific`; `species` (common) → `product.name`/`compliance.species.common_name`. **Trade-off:** none load-bearing. **Delta:** §4.2. |
| **C12** | **Default LLM model named vs "provider-agnostic"** | `ADR-0002` names **no** model ("the chosen LLM"); ARCHITECTURE/BACKEND/PROMPT-CONTRACT/PIPELINE deliberately name none | `AI-PIPELINE.md` §1.4 + `model-and-cost-notes.md` = **`claude-opus-4-8`** default behind `LlmExtractorPort` | **Reconcilable** → **RESOLVED in code:** The implemented default is `claude-haiku-4-5` (configurable via `LABELSCAN_LLM_MODEL`). The hybrid GS1+LLM extraction means GS1 handles critical exact fields (lot/DLC/weight/GTIN) with confidence 1.0, so Haiku's capability is sufficient for free-text extraction. The original `claude-opus-4-8` recommendation was the pre-GS1 design; the code chose Haiku as a cost/speed optimization enabled by the GS1 shift. **Resolution:** `claude-haiku-4-5` is the current default adapter; `claude-opus-4-8` remains the escalation tier. Both are swappable behind the port (ADR-0002). |
| **C13** | **Single-pass vision vs two-stage OCR→LLM** | `ADR-0002` = two ports (OcrPort + LlmExtractorPort) i.e. two-stage | `AI-PIPELINE.md` §1.3 + `model-and-cost-notes.md` §5 = **two-stage by default**; single-pass = option behind the ports for repair tier only | **Reconcilable** | Both agree: **two-stage is the default**; single-pass vision is an explicitly-bounded option that still runs OCR to keep the raw anchor + evidence gate. Stated once, not contradicted. |
| **C14** | **`gtin` as an overridable extracted field** | `API-CONTRACTS.md`/`openapi` `FieldName` includes `gtin` and `lot` | `extraction.v1` has no `gtin` field; `barcode_raw` is walled off from `evidence` (PROMPT-CONTRACT §4); GTIN handled in backend gate (BACKEND §8.4), stored on `batch`/`product` | **Reconcilable** | `gtin` is **not** an LLM-extracted field; it comes from the scanned `barcode_raw`, is GS1-checked, and lives on `batch`/`product`. Including it in the `PATCH /fields/{field_name}` enum is wrong (there is no `gtin` extracted_field row). **Resolution:** remove `gtin` and `lot` from the override `FieldName` enum (lot = `batch_number` in extraction). GTIN correction is done via `POST/PATCH` on the batch, not the field-override endpoint. **Trade-off:** none; aligns the override surface with the actual stored field rows. **Delta:** §4.2. |
| **C15** | **SLO numbers BACKEND vs SRE** | `BACKEND §10.4` (ingestion avail 99.9%, submit p95<1.5s/p99<3s, extraction ≥95% in 5min, freshness p95<60s, reads p95<200ms/p99<500ms) | `SRE §1` identical numbers **plus** unbudgeted data-integrity SLO (100% raw durability + audit completeness) + MWMBR alerting | **Reconcilable** | SRE explicitly "extends BACKEND §10.4" with identical seeds (SRE Appendix consistency map confirms). **Authoritative = SRE §1** (it is the superset and the named owner); BACKEND §10.4 is the seed. No numeric conflict. |
| **C16** | **Confidence thresholds location** | `PROMPT-CONTRACT` SC9 (model self-report is a hint) | `AI-PIPELINE §4.2` + `PIPELINE §6/§8` + `BACKEND §8.2.3` = single review band on **combined** confidence, required-field rule from Compliance snapshot | **Reconcilable** | Consistent: model number is a hint; the **gate-owned `Confidence` VO band** on the combined score gates auto-accept vs review; the rule-set decides which fields are required. No hard-coded floats anywhere. Authoritative = AI-PIPELINE §4 (combination) + BACKEND §8.2.3 (band) + Compliance rule-set (which fields). |
| **C17** | **Expand-and-contract migration described in 3 docs** | `BACKEND §11.2`, `DATABASE §6`, `SRE §7.2` | (all three) | **Reconcilable / CONSISTENT** | All three agree: expand → backfill → contract; never contract in the same release as expand (SRE §7.2); append-only tables backfilled only by the audited `labelscan_maint` role; per-context schemas keep migrations scoped. The two migration files (`0001` expand, `0002` concurrent index) match the pattern. No conflict. |
| **C18** | **Phase ordering 0–5** | `ARCHITECTURE §9` | `AUDIT.md §4`, `BACKEND §11.4` (phase table) | **Reconcilable / CONSISTENT** | Phases 0–5 identical across ARCHITECTURE §9, AUDIT §4, BACKEND §11.4 (Foundations → Immutable ingestion → Extraction+confidence → Domain+validation → Traceability+HACCP → Thin client). No conflict. |
| **C19** | **Idempotency model (HTTP key + event_id + content-addressed raw)** | `BACKEND §7` | `DATABASE §3.3/§1.5` (`idempotency_key`, `processed_event`, content-addressed `raw_artifact`), `SRE §9` (chaos: no double append), `PIPELINE §0/§6` | **Reconcilable / CONSISTENT** | Two-layer idempotency (HTTP `Idempotency-Key` + per-consumer `event_id` dedup) + content-addressed raw store described identically in all four. Tables (`platform.idempotency_key`, `platform.processed_event`, unique `(ingestion_id, artifact_kind, checksum_sha256)`) back it. No conflict. |
| **C20** | **Immutability enforcement (REVOKE + trigger + new-run-on-correction)** | `ADR-0003/0004` | `DATABASE §3` + `schema.sql` (`deny_mutation` trigger, REVOKE, `is_superseded`, `superseded_by_field_id`), `SRE RB-4`, `ARCHITECTURE §7.1/§7.2` | **Reconcilable / CONSISTENT** | All agree: REVOKE UPDATE/DELETE + `BEFORE UPDATE OR DELETE` trigger; corrections create a **new `ExtractionRun`** (`is_superseded`), human override inserts a **new `extracted_field`** row (`source='human'`, original retained). No conflict. |
| **C21** | **Domain events set** | `ARCHITECTURE §6` (12 events incl. `RawArtifactStored`, `LabelExtractionCompleted`, `ExtractionFlaggedForReview`, `ExtractionConfirmed`, `BatchRegistered`, alert lifecycle, `AuditEntryAppended`) | `PIPELINE §2/§4`, `AI-PIPELINE §4.5`, `BACKEND §2.3`, `SRE` reference the same names; `schema.sql` `platform.outbox.event_type` stores them | **Reconcilable / CONSISTENT** | Every event referenced downstream exists in ARCHITECTURE §6. `LabelExtractionCompleted` / `ExtractionFlaggedForReview` / `RawArtifactStored` / audit events are used consistently. **One naming nuance:** ARCHITECTURE §6 names `OcrCompleted`; pipeline uses an internal `ocr` stage result (not a cross-context event) — not a contradiction (internal vs published). Authoritative event list = ARCHITECTURE §6. |
| **C22** | **Alert lifecycle / type / severity vocab** | `ARCHITECTURE §7.6` (`open→acknowledged→resolved`) | `schema.sql` alert CHECK (`state∈{open,acknowledged,resolved}`, `alert_type∈{expiry,temperature,required_field}`, `severity∈{low,medium,high,critical}`), `openapi` Alert enums identical, `API-CONTRACTS §4.8` identical | **Reconcilable / CONSISTENT** | Alert state/type/severity identical across ARCHITECTURE, DB, OpenAPI, API-CONTRACTS. No conflict. |
| **C23** | **`raw_warnings` stub inside `fields` is semantically odd** | `extraction.v1.schema.json` + test-cases keep `raw_warnings` as a 16th per-field key (always null stub) | `DATABASE.md`/`schema.sql` deliberately omit it from `extracted_field` and use `extraction_run.raw_warnings` for the top-level array | **Reconcilable (with a noted smell)** | Resolved by C1: the 16th key is a contract artefact, never a persisted field. **Minor smell flagged, not a blocker:** a future schema MAJOR could drop the in-`fields` `raw_warnings` key (PROMPT-CONTRACT §1 says shape changes are MAJOR). For Phase 1, keep as-is (changing it is a new design decision, out of scope for consolidation). |

**Tally:** 23 seams examined. **0 BLOCKERs from contradictions.** 14 reconcilable representation/naming conflicts resolved by aligning to the stored/contract source of truth (C1–C14, mostly the API read-model drifting from extraction.v1/DB). 9 confirmed CONSISTENT (C15–C23). The only items reaching §8 are the **pre-existing NEEDS-VERIFICATION / NEEDS-CONFIRMATION flags** carried up from the source docs (regulatory/policy decisions), plus the one explicitly-flagged "if 16 must mean 16 rows" confirmation — none of which the synthesis may decide.

---

## 3. Unified logical architecture diagram (one canonical C4-ish view)

Reconciles ARCHITECTURE §4 (L2/L3) with BACKEND §2 and PIPELINE §2 into a single picture: one modular monolith, sync ingestion path, async outbox+worker extraction, OCR/LLM ports with default adapters, raw store (object storage + DB metadata), schema-per-context PostgreSQL, append-only audit, HITL review, traceability/alerting reads, observability plane.

```
                         HUMANS / DEVICES
   ┌────────────┐  POST /v1/ingestions (image+meta+Idempotency-Key)   ┌──────────────────────┐
   │ Scanner /  │  [hostile external content]                          │ Supervisor / Auditor │
   │ Fishmonger │──────────────┐                            review/lookup│ (review, trace, audit)│
   └────────────┘              │                            ┌───────────└──────────────────────┘
                               ▼ HTTPS, per-device JWT       ▼ HTTPS, role JWT
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ LabelScan modular monolith (FastAPI, single deploy) — composition root app/main.py          │
 │                                                                                              │
 │  MIDDLEWARE: correlation/trace → authn(JWT/JWKS) → body-limit → idempotency → router → error │
 │                                                                                              │
 │  ───────────────── SYNC INGESTION PATH (no model on the request path) ─────────────────     │
 │  ingestion.adapters.inbound.http → SubmitCapture use case:                                   │
 │    1 Clock.now  2 ObjectStore.put(image)  3 RawArtifactRepository.append(image ref) [BEFORE] │
 │    4 IngestionRepository.save(status=raw_stored)  5 AuditLogPort.append                       │
 │    6 outbox row (SAME DB txn) → enqueue RunExtraction        ── 202 Accepted (raw_stored) ──▶ │
 │                                            │ (transactional outbox; event_id dedup)          │
 │  ═══════════════════════════════ ASYNC HOP (trace ctx on envelope) ═════════════════════     │
 │  app/worker.py  =  RunExtraction ORCHESTRATOR (owns the envelope/task ledger)                 │
 │    [1] Preprocess → [2] OCR ─OcrPort─▶ [Google Vision*]  (append raw OCR JSON to RAW STORE)   │
 │                       [3] OCR-quality gate → proceed | skip_garbage→review | review           │
 │    [4] LLM ─LlmExtractorPort─▶ [claude-haiku-4-5*]  (extraction.v1; unknown⇒null; ≤2 repair)  │
 │    [5] Schema + NO-FABRICATION gate (evidence = exact substring of raw OCR)  ◀ TRUST BOUNDARY │
 │    [6] HACCP/business validation (confidence band, rule-set snapshot, vocab, GTIN)            │
 │       ├ auto-ok → [8] store ExtractionRun(status=extracted) → publish LabelExtractionCompleted│
 │       └ flagged → [7] HITL review (status=needs_review) → publish ExtractionFlaggedForReview   │
 │            reviewer PATCH /fields + POST /confirm ⇒ NEW ExtractionRun + audit (no overwrite)  │
 │                                                                                              │
 │  CONTEXTS (schema-per-context; cross-context = events + by-ID refs only, NO cross-schema FK): │
 │   ingestion(CORE,hex) · compliance(layered) · traceability(layered) · haccp(CORE,hex)         │
 │   · audit(thin append-only) · identity(generic)                                              │
 │   cross-context effects travel ONLY as domain events on the in-process EventBus (port).       │
 │                                                                                              │
 │   [9] HACCP consumes events → expiry/temperature/required-field → Alert (open→ack→resolved)   │
 │   READ PATHS: GET /v1/trace,/batches,/alerts,/audit,/temperature-logs (auditor read-only)     │
 │   [10] AUDIT: every business step appends via AuditLogPort (append-only, same txn)            │
 └───────────────┬───────────────────────┬───────────────────────┬──────────────┬──────────────┘
                 ▼                        ▼                        ▼              ▼
   ┌───────────────────────┐  ┌────────────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │ OBJECT STORE          │  │ PostgreSQL 16      │  │ EXTERNAL PROVIDERS│  │ OBSERVABILITY     │
   │ raw images (content-  │  │ schema-per-context: │  │ Google Vision(OCR)│  │ plane             │
   │ addressed key+sha256, │  │ ingestion/compliance│  │ claude-haiku-4-5  │  │ JSON logs+codes,  │
   │ SSE, signed-URL reads)│  │ /traceability/haccp │  │ (LLM)             │  │ OTel traces across│
   └───────────────────────┘  │ /audit/identity/    │  │ — behind ports,   │  │ async hop, RED/USE│
                              │ platform            │  │ keys server-side  │  │ + domain metrics, │
   APPEND-ONLY (REVOKE       │ outbox/idempotency/ │  │ only (no client    │  │ MWMBR SLO alerts, │
   UPDATE/DELETE + trigger): │ processed_event     │  │ key — fixes A3/R7) │  │ durability-audit  │
   raw_artifact, audit_log,  │ partitioned append- │  └──────────────────┘  │ job, dead-man's   │
   temperature_log           │ only tables         │   * = default adapter   │ switches          │
                              └────────────────────┘                         └──────────────────┘
```

**Diagram reconciliation note:** ARCHITECTURE §4 L2 drew "in-proc event bus" but not the outbox; BACKEND §2.3 added the **transactional outbox**; PIPELINE §2 added the **async hop + OCR-quality branch + HITL branch**; AI-PIPELINE §1.1 named the **default adapters**. This single view folds all four in without contradiction (the bus is still a port; the outbox is how the bus is made crash-safe; default adapters sit behind the two provider ports only).

---

## 4. Unified data model (final schema reference)

**Source of truth: `docs/database/schema.sql`** (prose in `DATABASE.md`). The synthesis records below the reconciled field set, per-field shape, enums, and the aggregate↔table↔context map, plus a **documented change list** (alignment deltas — NOT new SQL) that the source docs already imply.

### 4.1 Authoritative entity / table list (aggregate ↔ table ↔ context)

| ARCHITECTURE §7 aggregate / entity | `schema.sql` table | Schema (context) | Notes |
|------------------------------------|--------------------|------------------|-------|
| `Ingestion` (root) | `ingestion.ingestion` | ingestion (1, CORE) | status state machine (§4.3) |
| `RawArtifact` (root, append-only) | `ingestion.raw_artifact` | ingestion | partitioned by `occurred_at`; image in object store, OCR JSON here |
| `ExtractionRun` (in `Ingestion`) | `ingestion.extraction_run` | ingestion | `is_superseded`; carries label-level `raw_warnings`, `mean_token_confidence`, `schema_version`, `extractor_version`, `rule_set_version` |
| `ExtractedField` (VO, in run) | `ingestion.extracted_field` | ingestion | **15 substantive fields** (§4.1 below); override chain via `superseded_by_field_id` |
| `RequiredFieldRuleSet` (versioned) | `compliance.required_field_rule_set` | compliance (2) | which of the 15 are mandatory + thresholds (data) |
| Species / FaoArea vocab | `compliance.species`, `compliance.fao_area` | compliance | controlled vocab |
| `Product` | `traceability.product` | traceability (3) | `gtin` (GS1-checked in app), `species_id`→compliance |
| `Batch`/`Lot` (root) | `traceability.batch` | traceability | projects `use_by, packaging_date, production_method, gtin, species_scientific, fao_area_code`; `source_ingestion_id` (by-ID) |
| `Supplier` (root) | `traceability.supplier` | traceability | soft-deactivate; `version` for ETag |
| `ControlPlan` (root, versioned) | `haccp.control_plan` | haccp (4, CORE) | thresholds immutable once active |
| `TemperatureLog` (append-only entity) | `haccp.temperature_log` | haccp | partitioned by `recorded_at` |
| `Alert` (root) | `haccp.alert` | haccp | `open→ack→resolved`; type/severity enums |
| `AuditEntry` (root, append-only) | `audit.audit_log` | audit (5) | partitioned; optional hash chain |
| Actor | `identity.actor` | identity (6) | IdP `sub`; roles snapshot |
| (infra) idempotency / dedup / outbox | `platform.idempotency_key`, `platform.processed_event`, `platform.outbox` | platform | two-layer idempotency + transactional outbox |

**Coverage check:** every ARCHITECTURE §7 aggregate has exactly one backing table and vice-versa. `Compliance` reference tables and `platform` infra have no aggregate (correct — they are supporting/cross-cutting). **No orphan table; no aggregate without a table.**

**The reconciled 15 substantive extracted fields** (C1, authoritative from `schema.sql` extracted_field CHECK = extraction.v1 minus the `raw_warnings` stub):
`product_name, commercial_designation, scientific_name, batch_number, supplier_name, origin_country, FAO_area, production_method, fishing_gear_or_farming_method, expiry_date, packaging_date, storage_temperature, allergens, weight, price`.
The label-level `raw_warnings` array is stored on `extraction_run.raw_warnings` (NOT as a field row). The extraction.v1 closed set keeps a 16th `raw_warnings` key for output stability; it is never persisted as an `extracted_field` (see §8 carried flag if "16 stored rows" is ever mandated).

### 4.2 Final per-field object shape (stored vs API projection — C2/C3/C5)

**Stored (authoritative, `extracted_field` + extraction.v1):** per field —
`value` (jsonb, polymorphic per extraction.v1 type), `evidence` (jsonb verbatim substrings; NULL iff value NULL — `ck_evidence_iff_value`), `validation_status` (`present|missing|ambiguous|normalized|unnormalizable|invalid`), `warnings` (jsonb), `llm_confidence`, `ocr_confidence`, `combined_confidence` (NOT NULL), `confidence_band` (`low|medium|high`), `source` (`llm|human`), `source_ref` (raw OCR token span).

**API read-model projection** (`ExtractedField`): `name` (one of the 15 canonical names), `value`, `confidence={score: combined_confidence, band: confidence_band}`, `evidence`/`provenance{source_ref}` (same raw-OCR pointer), `validation_status`, `warnings`, `reason∈{not_found,unreadable,unverifiable}`.

**Documented alignment deltas (NOT new SQL/features — they fix illustrative drift to match the stored contract):**
- **D1 (C4/C14):** API `FieldName` enum → the **15 extraction.v1 names**; drop `gtin`, `gear_type`, `lot`, `species`, `storage_temp`, `fao_area` abbreviations. `lot`→`batch_number`, `storage_temp`→`storage_temperature`, `fao_area`→`FAO_area`, gear→`fishing_gear_or_farming_method`, `species`→`scientific_name`.
- **D2 (C2):** API `ExtractedField`/`ExtractionView` should expose `validation_status` and per-field `warnings` (present in DB, missing in OpenAPI), so the read-model is a faithful projection.
- **D3 (C5):** narrow API `Provenance.source` to `{llm, human}` to match `extracted_field.source` CHECK (or document that `ocr`/`barcode` never label a stored value).
- **D4 (C3):** document `Confidence.score == combined_confidence`, `Confidence.band == confidence_band`.
- **D5 (C7):** API `BatchCreate.production_method` enum → `[wild_caught, farmed]` (matches DB CHECK).
- **D6 (C10/C11):** `BatchCreate.gear_type` has no backing column → drop it (or surface gear only via the extraction view). `BatchCreate.scientific_name → batch.species_scientific`; `species` (common) → product/compliance.

### 4.3 Final status / validation_status / alert enums (C6/C22)

- **Ingestion / pipeline status (authoritative = `schema.sql` ingestion CHECK ≡ `shared-state.schema.json` — 12 states):** `raw_stored, ocr_running, ocr_done, ocr_failed, ocr_skipped_garbage, extraction_running, extracted, extraction_failed, needs_review, confirmed, rejected, halted_missing_context`. ARCHITECTURE §2.1 names the happy-path subset; OpenAPI `IngestionStatus` (8) is a public projection — **Delta D7:** extend it to the 12 or document the public→internal mapping.
- **`extraction_run.outcome`:** `extraction_running, extracted, needs_review, extraction_failed, unparseable, off_schema, refused`.
- **`validation_status` (extraction.v1 ≡ `extracted_field` CHECK):** `present, missing, ambiguous, normalized, unnormalizable, invalid` — identical in schema, DB, prompt, test-cases. CONSISTENT.
- **Alert:** `state∈{open,acknowledged,resolved}`, `alert_type∈{expiry,temperature,required_field}`, `severity∈{low,medium,high,critical}` — identical across DB/OpenAPI/API-CONTRACTS/ARCHITECTURE. CONSISTENT.
- **`extracted_field.source`:** `{llm,human}` (authoritative). **`production_method`:** `{wild_caught,farmed}` (authoritative).
- **Security flags (pipeline envelope):** `INJECTION_LANGUAGE_DETECTED, EVIDENCE_NOT_IN_RAW_OCR, OUT_OF_VOCAB_VALUE, PII_SUSPECTED, NON_FOOD_CONTENT_SUSPECTED, OVERSIZE_OR_MALFORMED_INPUT, MULTILINGUAL_UNRESOLVED`.

### 4.4 Cross-context reference rule (CONSISTENT — C4 of the brief's seam list)

Honoured identically in `ARCHITECTURE §5.3/§7` and `DATABASE §1.2` + `schema.sql §2`: **FKs only within a schema; cross-context links are plain indexed `uuid` columns** (`batch.source_ingestion_id`, `temperature_log.batch_id`, `alert.batch_id`, `product.species_id`, all `*_by`→`identity.actor`), each `COMMENT`-documented with its logical target, validated by events/app. No contradiction.

---

## 5. Unified end-to-end pipeline (single canonical flow)

Reconciles PIPELINE §1–§8, AI-PIPELINE §1, BACKEND §3–§9, and ARCHITECTURE §3.2/§6 into one numbered flow. For each step: API/endpoint · event(s) · table(s) · status transition · error codes on failure.

| # | Step | Endpoint / trigger | Event(s) | Table(s) written/read | Status transition | Error codes on failure |
|---|------|--------------------|----------|------------------------|-------------------|------------------------|
| 0 | Capture (client) | mobile capture → durable queue (Phase 5) | — | — (client) | — | client-side (offline queue) |
| 1 | **Submit (sync; raw BEFORE normalization)** | `POST /v1/ingestions` (multipart, `Idempotency-Key`) | `CaptureSubmitted`→`RawArtifactStored` | `raw_artifact`(image ref, append) ; `ingestion`(insert) ; `audit_log` ; `outbox`(enqueue, same txn) ; `idempotency_key` | `→ raw_stored` (HTTP 202) | `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 VALIDATION_ERROR`, `409 IDEMPOTENCY_KEY_CONFLICT`, `429 RATE_LIMITED`, `503 DEPENDENCY_UNAVAILABLE` (object store; client queue retries — R9) |
| 2 | **Preprocess** (worker, optional, non-authoritative) | worker (`RunExtraction`) | — | derived image (never overwrites raw) | `→ ocr_running` | none fatal (no-op fallback to raw image) |
| 3 | **OCR** (`OcrPort` → Google Vision) | worker | (internal `ocr` result; `OcrCompleted` internal) | `raw_artifact`(append OCR JSON) ; `extraction_run`(`mean_token_confidence`) | `ocr_running → ocr_done` / `ocr_failed` | `GATEWAY_TIMEOUT`/`EXTRACTION_PROVIDER_ERROR` (sync trigger); run `ocr_failed`; `DEPENDENCY_UNAVAILABLE` if breaker open; raw image already safe |
| 4 | **OCR-quality gate** (cost saver) | worker | `ExtractionFlaggedForReview` (if garbage/non-food) | envelope `ocr_quality` | `proceed` → continue; `skip_garbage`/`review` → `ocr_skipped_garbage`/`needs_review` | `ExtractionFlaggedForReview` (reason `unreadable`/non-food) |
| 5 | **LLM extraction** (`LlmExtractorPort` → claude-haiku-4-5; unknown⇒null; ≤2 repair) | worker | — | `extraction_run`(`raw_output_ref`,`extractor_version`,`schema_version`) | `→ extraction_running` | run `unparseable/off_schema/refused/extraction_failed`; `ExtractionFlaggedForReview` (`extractor_unparseable`/`extractor_refused`); `GATEWAY_TIMEOUT` on sync trigger; **zero fabricated fields** |
| 6 | **Schema + no-fabrication gate** (TRUST BOUNDARY) | worker | — | (validates; coerces unverifiable → null) | — | `BUSINESS_RULE_VIOLATION`/fail run; security flag `EVIDENCE_NOT_IN_RAW_OCR`/`INJECTION_LANGUAGE_DETECTED` → quarantine → review |
| 7 | **HACCP/business validation** (confidence band + rule-set snapshot + vocab + GTIN) | worker | — | reads `required_field_rule_set` snapshot, `species`/`fao_area` vocab; computes `combined_confidence`/`confidence_band` | — | `REQUIRED_FIELD_MISSING`/`LOW_CONFIDENCE_FIELD` (422 at confirm); `GTIN_CHECKSUM_INVALID` (422); out-of-vocab → review |
| 8 | **Route** | worker (pure function of envelope) | `LabelExtractionCompleted` (auto-ok) OR `ExtractionFlaggedForReview` (flagged) | `extraction_run`+`extracted_field`(15 rows) insert ; `audit_log` | `→ extracted` or `→ needs_review` | (contradiction → review, never auto-confirm) |
| 9 | **HITL review** (branch) | `PATCH /v1/ingestions/{id}/fields/{name}` (`extraction:review`) ; `POST .../confirm` (`extraction:confirm`) ; `POST .../reject` | `ExtractionConfirmed` (on confirm) | new `extracted_field` row (`source=human`, original retained) ; **new `extraction_run`** ; `audit_log` | `needs_review → confirmed`/`rejected` | `409 INGESTION_INVALID_STATE` (already confirmed); `422 REQUIRED_FIELD_MISSING`/`LOW_CONFIDENCE_FIELD` at confirm |
| 10 | **Batch / traceability creation** | from `ExtractionConfirmed` (async) or `POST /v1/batches` (manual) | `BatchRegistered` | `batch`(insert; projects `use_by` etc.; GS1-checked `gtin`) ; `audit_log` | (batch linked to ingestion by ID) | `422 GTIN_CHECKSUM_INVALID`/`LOT_CODE_DUPLICATE`; `409 IDEMPOTENCY_KEY_CONFLICT` |
| 11 | **HACCP monitoring & alerting** | from `BatchRegistered`/scheduled scan ; `POST /v1/temperature-logs` | `ExpiryThresholdBreached`/`TemperatureThresholdBreached` → `AlertRaised` | `temperature_log`(append) ; `alert`(insert) ; `audit_log` | alert `open` | `422` bad temp/measured_at; scan-miss = ops (SRE dead-man's-switch) |
| 12 | **Alert lifecycle** | `POST /v1/alerts/{id}/acknowledge`/`resolve` | `AlertAcknowledged`/`AlertResolved` | `alert`(update state) ; `audit_log` | `open→acknowledged→resolved` | `409 ALERT_INVALID_TRANSITION` |
| ✶ | **Audit (cross-cutting)** | every business step | `AuditEntryAppended` | `audit_log`(append, same txn) | — | audit-write fail = **page** (SRE §3.4), business action fails rather than proceed unaudited |

**Stage-list reconciliation:** PIPELINE numbers stages 1–10 (preprocess..audit), AI-PIPELINE mirrors them, BACKEND describes them as endpoints+worker. The unified table above merges PIPELINE's stage granularity with BACKEND's endpoint/error mapping and DATABASE's table writes — no step exists in one doc and not another; the only naming nuance is internal `ocr`/quality-gate steps (PIPELINE 2–3) collapsed under "OCR" + "OCR-quality gate" here.

---

## 6. Aligned API contracts

Every `/v1` endpoint from `openapi.v1.yaml` / `API-CONTRACTS.md`, aligned to the unified data model (§4) and pipeline (§5). Auth scopes from BACKEND §6; idempotency from BACKEND §7.

| Method + path | Tables touched | Event(s) emitted | Pipeline step (§5) | Auth scope | Idempotent? |
|---------------|----------------|------------------|--------------------|------------|-------------|
| POST `/v1/ingestions` | raw_artifact, ingestion, audit_log, outbox, idempotency_key | CaptureSubmitted, RawArtifactStored | 1 | `ingestion:write` | **Yes (key required)** |
| GET `/v1/ingestions` | ingestion | — | read | `ingestion:read` | safe |
| GET `/v1/ingestions/{id}` | ingestion, extraction_run | — | read | `ingestion:read` | safe |
| GET `/v1/ingestions/{id}/image` | raw_artifact (→ signed URL) | — | read | `ingestion:read` | safe |
| POST `/v1/ingestions/{id}/extract` | extraction_run, outbox | (re-)RunExtraction | 5 (manual re-run → new run) | `extraction:run` | **Yes (key)** |
| GET `/v1/ingestions/{id}/extraction` | extraction_run, extracted_field | — | read | `ingestion:read` | safe |
| GET `/v1/ingestions/{id}/extraction/runs` | extraction_run | — | read | `ingestion:read` | safe |
| GET `/v1/ingestions/{id}/ocr` | raw_artifact (ocr_json), extraction_run | — | read | `ingestion:read` | safe |
| PATCH `/v1/ingestions/{id}/fields/{name}` | extracted_field (new row), extraction_run (new run), audit_log | — | 9 (override) | `extraction:review` | **Yes (key)** |
| POST `/v1/ingestions/{id}/confirm` | ingestion, audit_log, outbox | ExtractionConfirmed | 9 | `extraction:confirm` | **Yes (key)** |
| POST `/v1/ingestions/{id}/reject` | ingestion, audit_log | (rejected) | 9 | `extraction:confirm` | **Yes (key)** |
| POST `/v1/batches` | batch, audit_log | BatchRegistered | 10 | `batch:write` | **Yes (key)** |
| GET `/v1/batches`, `/v1/batches/{id}` | batch (+supplier/product join) | — | read | `traceability:read` | safe |
| POST `/v1/suppliers` | supplier, audit_log | — | (master data) | `supplier:write` | **Yes (key)** |
| GET `/v1/suppliers`, `/v1/suppliers/{id}` | supplier | — | read | `traceability:read` | safe |
| PATCH `/v1/suppliers/{id}` (If-Match) | supplier (version++) | — | master data | `supplier:write` | conditional (ETag) |
| DELETE `/v1/suppliers/{id}` (soft) | supplier (is_active=false) | — | master data | `supplier:admin` | yes |
| GET `/v1/trace`, `/trace/by-lot`, `/trace/by-batch` | batch→supplier→product→ingestion→extraction_run (+alerts) | — | read (DATABASE §4.1) | `traceability:read` | safe |
| POST `/v1/temperature-logs` | temperature_log (append), audit_log | TemperatureLogged → (maybe) TemperatureThresholdBreached | 11 | `temperature:write` | **Yes (key)** |
| GET `/v1/temperature-logs` | temperature_log | — | read | `haccp:read` | safe |
| GET `/v1/alerts`, `/v1/alerts/{id}` | alert | — | read | `haccp:read` | safe |
| POST `/v1/alerts/{id}/acknowledge` | alert, audit_log | AlertAcknowledged | 12 | `alert:ack` | **Yes (key)** |
| POST `/v1/alerts/{id}/resolve` | alert, audit_log | AlertResolved | 12 | `alert:resolve` | **Yes (key)** |
| GET `/v1/audit`, `/v1/audit/{entry_id}` | audit_log | — | ✶ (read-only; no write path → 405) | `audit:read` | safe |
| GET `/v1/health/live`,`/ready`,`/version` | (probes) | — | ops | none | safe |

**Endpoint/table/stage gaps flagged:**
- **No endpoint with no backing table/stage.** Every endpoint maps to at least one table + one pipeline step.
- **No table/stage with no endpoint** *except by design:* `compliance.required_field_rule_set`, `compliance.species`, `compliance.fao_area` have no public CRUD endpoint (BACKEND §2.1 marks `/v1/catalog/*` as *optional/internal* — served to the validation gate). `platform.*` (idempotency/outbox/processed_event) are internal infra (correctly no endpoint). `control_plan` has no endpoint (HACCP thresholds are versioned data; no management API was specified — **noted, not a contradiction**: alerts are system-raised; plan authoring was left to a later phase).
- **Alignment deltas D1–D7 (§4.2/§4.3)** apply to the field/enum names used by `PATCH /fields/{name}`, `ExtractedField`, `BatchCreate`, `IngestionStatus`, `Provenance.source` — these make the API contract a faithful projection of the unified data model. They are **name/enum alignments to existing fields**, not new endpoints or fields.

---

## 7. HACCP compliance validation across the full flow

Each hard constraint (ARCHITECTURE §0 + the brief) verified END-TO-END with citations. Status: **MET** / **PARTIAL** / **GAP**.

| # | Constraint | Satisfied where (file:§) | Status |
|---|------------|--------------------------|--------|
| a | **Raw stored BEFORE normalization** | ARCHITECTURE §3.1/§7.2, ADR-0003; BACKEND §4.1/§7.4; PIPELINE §2 step 1; AI-PIPELINE §1.1/§2.2; schema.sql `raw_artifact` append-only+partitioned; SRE SLO-3a (raw durability 100%, page on breach) | **MET** |
| b | **Every extracted field has confidence + evidence** | ADR-0005; extraction.v1 (`confidence`+`evidence`, evidence null iff value null); schema.sql `ck_evidence_iff_value` + `combined_confidence NOT NULL` + `confidence_band`; AI-PIPELINE §4; BACKEND §4.2 | **MET** |
| c | **No hallucinated/invented fields (evidence-substring gate)** | PROMPT-CONTRACT rules 1–2 + SC3 (hard gate 100%); BACKEND §8.2.2; PIPELINE §5 (coerce-to-null); AI-PIPELINE §3.4/§5; schema.sql `ck_evidence_iff_value`; SRE §5.2 `evidence_gate_reject_total` hallucination detector | **MET** |
| d | **No fabricated regulatory data** | ARCHITECTURE §0 (regime referenced, not encoded; rules in Compliance versioned set); PROMPT-CONTRACT §6 (fictional codes; flag rather than map FAO/approval/GTIN); AI-PIPELINE §8.4; DATABASE §7 (retention NEEDS VERIFICATION, not fabricated) | **MET** (regulatory specifics correctly deferred — see §8 carried flags) |
| e | **Required-field validation** | BACKEND §8.2.4/§8.3 (rule-set snapshot at confirm); PIPELINE §6/§8 (blocking review on missing required); schema.sql `required_field_rule_set`; AI-PIPELINE §4.2; error `REQUIRED_FIELD_MISSING` | **MET** (which fields are required = Compliance rule-set, versioned data — correctly not hard-coded) |
| f | **Historical data immutable** | ADR-0003/0004; DATABASE §3 + schema.sql (REVOKE UPDATE/DELETE + `deny_mutation` trigger on raw_artifact/audit_log/temperature_log; `is_superseded`; new-run-on-correction); ARCHITECTURE §7.1/§7.2; SRE RB-4 | **MET** |
| g | **All business-critical changes audited** | ARCHITECTURE §2.5/§7.7, ADR-0004; BACKEND §4.9/§12 S8 (no write path, 405; same-txn); DATABASE §3 (append-only, hash-chain option); SRE SLO-3b (audit completeness 100%, page on miss); PIPELINE §3 stage 10 | **MET** |
| h | **Traceability by batch/lot end-to-end** | ARCHITECTURE §2.3/§7.3; BACKEND §3.F/§4.6; DATABASE §4.1 (lot→supplier→product→ingestion→run chain, covering index); `GET /v1/trace*`; batch.`source_ingestion_id` by-ID provenance | **MET** |
| i | **Expiry & temperature monitoring + alerting** | ARCHITECTURE §2.4/§7.5/§7.6; BACKEND §3.G/§3.H/§4.7/§4.8; DATABASE §4.3–§4.5 (expiry/temp scans); schema.sql `control_plan`/`temperature_log`/`alert`; SRE §4.1 (domain alerts) + dead-man's-switch on scans | **MET** (control-plan *authoring* API not specified — see §6 note; monitoring/alerting machinery fully present) |
| j | **Domain layer framework/DB/provider-independent (dependency rule)** | ARCHITECTURE §5 (import allow-list, import-linter, arch tests), ADR-0002/0006; BACKEND §2.2/§2.5 (Pydantic only in adapters); PIPELINE §framing/§3 (only stages 2&4 cross to providers); AI-PIPELINE §1/§3.1 (ports unchanged) | **MET** |
| k | **correlation_id / trace_id end-to-end** | ARCHITECTURE §6 (envelope), §7.7; BACKEND §3 headers/§5 envelope/§10 (middleware+OTel across async hop); PIPELINE §5 (ids immutable in-run)/§9; shared-state.schema.json `ids` required; schema.sql `correlation_id`/`trace_id` NOT NULL on raw_artifact/ingestion/extraction_run/temperature_log/alert/audit_log/outbox; SRE §3.3 | **MET** |

**Matrix result: 11/11 MET. No GAP, no PARTIAL that blocks.** Two non-blocking notes carried forward: (i) HACCP **control-plan authoring** has no management endpoint (alerts are system-raised; plan CRUD deferred — not a constraint violation, but flagged for the implementation phase); (d/i/retention) regulatory specifics (required-field set, retention window, FAO/approval validity) are **correctly** held as versioned data / NEEDS-VERIFICATION rather than fabricated — these are the carried policy flags in §8.

---

## 8. Open BLOCKERS (STOP list)

**No new contradiction-driven BLOCKER was produced by the synthesis.** Every cross-document inconsistency in §2 was resolvable by aligning illustrative/API drift to the stored/contract source of truth, choosing between **existing** options with a stated trade-off — no third option was invented, and no true contradiction (mutually exclusive locked decisions) was found.

What remains are **pre-existing flags carried up verbatim from the source documents** — each is a genuine human/owner decision the synthesis is explicitly forbidden to make (regulatory, policy, or "confirm intent" items). These must be answered before/during implementation but **do not block the design's internal consistency**.

| # | Carried flag (source) | Exact decision required | Options (from the source; no new option invented) | Owner |
|---|------------------------|-------------------------|---------------------------------------------------|-------|
| **B1** | **"16 vs 15 — if 16 must mean 16 stored rows"** (`DATABASE.md` §note on field count, flagged "needs confirmation") | Confirm that the system persists **15 substantive `extracted_field` rows** (label-level `raw_warnings` on `extraction_run`), as synthesised in C1/§4.1. | (a) **15 rows + run-level `raw_warnings`** (current DB design, recommended); (b) 16 stored rows (a one-line change to the `extracted_field` CHECK) **only if** the brief's "16" is contractually mandated. | Product/Compliance |
| **B2** | **Required-field rule set contents** (ARCHITECTURE §2.2; BACKEND §8.2.4; DATABASE `required_field_rule_set`) — *which* of the 15 fields are mandatory + per-field review thresholds | Author/version the `RequiredFieldRuleSet` (data, not code) from the EU fishery-product info regime. | Versioned rule-set rows; not fabricated here (regime referenced, not encoded). | Compliance |
| **B3** | **Retention window & PII/GDPR-vs-immutability** (DATABASE §7, marked **NEEDS VERIFICATION**) | Set the compliance retention window; choose erasure approach reconciling GDPR with append-only immutability. | (a) redaction-by-reference; (b) crypto-erase (both in DATABASE §7); window = regulatory parameter, not fabricated. | Legal/Compliance |
| **B4** | **Audit hash-chain external anchoring** (DATABASE §3.4, flagged "a policy decision, not fabricated here") | Decide whether to enable hash-chaining and where to anchor chain heads (WORM/notary). | (a) grants+trigger only (mandatory floor); (b) + per-partition hash chain + external anchor (optional hardening). | Security/Compliance |
| **B5** | **Capacity & provider rate limits** (SRE §8, all numbers **ASSUMED**; "verify provider rate limits against account tier") | Replace assumed load/sizing with measured telemetry; confirm `claude-haiku-4-5` (default) RPM/TPM (and `claude-opus-4-8` for the escalation tier) for the account tier before go-live sizing. | Measure 2–4 weeks baseline (SRE §1 calibration note); do not buy nines without data. | SRE |
| **B6** | **API↔contract name alignment deltas D1–D7** (§4.2/§4.3, arising from C2/C4/C5/C6/C7/C10/C14) | Apply the field-name/enum alignments so `openapi.v1.yaml`/`API-CONTRACTS.md` match the authoritative extraction.v1/`schema.sql` names and shapes (the three docs already declare "keep in sync"). | Edit the OpenAPI/API-CONTRACTS enums to the canonical names (no new fields/endpoints). **Mechanical** — listed here only because it touches the published contract; can be done by the backend owner without a design decision. | Backend Architect |

**Bottom line:** the merged design is **internally consistent and implementation-ready** at the architectural level. There are **no unresolved true contradictions and no BLOCKER that requires inventing a new design decision.** The six items above are pre-existing regulatory/policy/measurement/confirmation flags (B1–B5) that the source docs already raised and that the synthesis is forbidden to fabricate, plus one mechanical contract-name alignment task (B6) that follows directly from the §2 resolutions.

---

### Appendix — quick consistency map (what each merged doc owns in the final reference)

| Concern | Owning doc (authoritative in synthesis) |
|---------|------------------------------------------|
| Contexts/aggregates/events/dependency law/phases | ARCHITECTURE.md + ADRs |
| LLM output contract (field set, per-field object, validation_status, evidence) | extraction.v1.schema.json + PROMPT-CONTRACT.md |
| Persisted data model, enums, immutability DDL | database/schema.sql (DATABASE.md prose) |
| Composite confidence (llm/ocr/combined/band) | AI-PIPELINE.md §4 (stored in DB) |
| API surface, errors, idempotency, auth, validation gate | BACKEND-ARCHITECTURE.md + API-CONTRACTS.md (openapi.v1.yaml = skeleton) |
| Pipeline topology/stages/envelope/HITL/fallbacks | PIPELINE-ARCHITECTURE.md + shared-state.schema.json |
| Default models/providers (only place naming them) | ai-pipeline/model-and-cost-notes.md (claude-haiku-4-5 default, claude-opus-4-8 escalation off by default, + Google Vision) |
| SLOs/reliability/observability/retention | SRE-RELIABILITY.md (extends BACKEND §10) |
