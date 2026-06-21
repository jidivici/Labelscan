# LabelScan — Extraction Pipeline Architecture

**Status:** Implemented (ExtractionConsumer orchestrates GS1→OCR→LLM→gate→reconcile→persist;
RegistrationConsumer + AlertingConsumer handle downstream events).
**Date:** 2026-06-18 (updated from 2026-06-14 design)
**Author:** Multi-Agent Systems Architect
**Scope:** `LabelScan/` only. Sibling projects (FishTrac, TRACEO, TRACEO1) out of scope.
**System:** HACCP-oriented seafood traceability for large-scale retail fishmongery.

> **This document builds on, and does not contradict, the locked design. Read first:**
> [`../architecture/ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) (Ingestion context §2.1,
> events §6, aggregates §7, dependency law §5),
> [`../architecture/adr/0002-hexagonal-ports-adapters-ocr-llm.md`](../architecture/adr/0002-hexagonal-ports-adapters-ocr-llm.md),
> [`0003`](../architecture/adr/0003-raw-before-normalized-immutable-store.md),
> [`0004`](../architecture/adr/0004-immutable-audit-append-only-vs-event-sourcing.md),
> [`0005`](../architecture/adr/0005-confidence-scores-in-the-model.md),
> [`../backend/BACKEND-ARCHITECTURE.md`](../backend/BACKEND-ARCHITECTURE.md) (async queue-backed
> extraction §1.1/§9, outbox/bus §2.3, validation gate §8, timeout/retry §9, observability §10,
> error-code catalog §5.2), [`../backend/API-CONTRACTS.md`](../backend/API-CONTRACTS.md), and
> [`../extraction/PROMPT-CONTRACT.md`](../extraction/PROMPT-CONTRACT.md) +
> [`../extraction/schema/extraction.v1.schema.json`](../extraction/schema/extraction.v1.schema.json).

> **Framing — read this before "agent".** The locked decision is a **modular monolith**, not a
> microservice fleet (ADR-0001). Throughout this document **"agent" / "stage" means an in-process
> pipeline component inside the Ingestion & Extraction context** — a use-case step or a port-backed
> adapter call — orchestrated by the `RunExtraction` application use case (the orchestrator) and
> running partly synchronously (the ingestion request) and partly in the **async extraction worker**
> (`app/worker.py`, BACKEND §1.1/§2.2). There is **no inter-service network hop between stages and
> no agent-to-agent negotiation.** The "topology" is a data-flow through one process (plus one
> queue hop). This keeps every recommendation here consistent with the dependency law (§5.2): the
> orchestrator and stages live in `application`/`domain`; provider calls (OCR/LLM) are the only
> things behind ports/adapters; nothing here introduces a new context, port, or event beyond those
> already defined.

**Companion contract artifacts (this doc summarizes them; they are the source of truth):**
- [`shared-state.schema.json`](./shared-state.schema.json) — the pipeline envelope (§5).
- [`eval-suite.md`](./eval-suite.md) — the 25 eval categories + CI gate (§10).

**Provider-agnostic.** No LLM/OCR vendor, model id, or vendor tool-use API appears here. Provider
wiring is the AI Engineer step (PROMPT-CONTRACT §appendix).

---

## 0. Failure-mode-first analysis (done before topology, on purpose)

The rules say: enumerate failure modes before drawing the topology. The topology in §1 is a
*consequence* of these failures, not a diagram drawn first and patched later. The full per-stage
failure table is §6; the headline failure pressures that **shape** the topology are:

1. **Provider calls are slow, rate-limited, and fail.** OCR and the LLM are the two failure-prone,
   latency-heavy steps. If they sit on the ingestion request path, a provider outage loses captures
   (AUDIT R9/A4). **Consequence:** the slow stages must run **off the request path** in an async
   worker, after the raw artifact is already durably stored (BACKEND §1.1) — this dictates the
   async-hop in the topology.
2. **The LLM will hallucinate / be injected.** OCR text is hostile external content; the model may
   invent values or obey embedded instructions. **Consequence:** a **validation gate** must sit
   between the LLM stage and anything that trusts its output — the gate is a first-class stage, not
   a library call buried in the adapter (BACKEND §8.2). This is the trust boundary in the topology.
3. **Garbage in → wasted spend + bad data.** An unreadable photo, if sent to the LLM, costs tokens
   and yields noise. **Consequence:** an **OCR-quality gate** between OCR and the LLM can
   short-circuit garbage (cost saver, §11) — a branch in the topology, not an afterthought.
4. **Any stage can produce missing/low-confidence/ambiguous output.** **Consequence:** a
   **human-review branch** must be reachable from the gate, and the system must always produce
   *something* (a structured `needs_review`), never a silent failure — this is the terminal
   fallback in the topology and §7.
5. **Context can be lost or silently truncated across stages.** A 6–10 stage chain compounds context
   pressure. **Consequence:** a **shared envelope with a required-context guarantee** (§5) — stages
   append, never overwrite; a missing required key halts loudly rather than proceeding on partial
   context.
6. **Retries and re-deliveries duplicate work.** At-least-once delivery + client retries.
   **Consequence:** idempotency at two layers (HTTP key + `event_id`) and content-addressed raw
   writes (BACKEND §7) — so the topology's retry edges are safe.

Every one of these is reflected as an explicit edge or node in §2.

---

## 1. Recommended topology (and why)

**Recommendation: a single-orchestrator HIERARCHICAL pipeline (orchestrator + ordered stages),
with one conditional fan-in-free branch (the OCR-quality gate → LLM vs review) and one async hop
(the transactional outbox + worker). It is the default hierarchical topology, deliberately, and
the deviations are minimal and justified.**

The orchestrator is the existing **`RunExtraction` application use case** inside the Ingestion
context. It owns decomposition, sequencing, the **task ledger** (which stage ran, with what
outcome — realized as the `stage_results` map in the envelope, §5), contradiction/violation
detection (the gate), and synthesis (assembling `ExtractedField`s into the `ExtractionRun`). The
orchestrator **does not execute provider work itself** — OCR and LLM are delegated to port-backed
stages (ADR-0002), exactly as the orchestrator-subagent rule requires.

**Why hierarchical (the default) is correct here, not just a fallback to the default:**

- The set of steps **is** known and largely linear (preprocess → OCR → quality → extract →
  validate → store/alert/audit), with **dependency between steps** (each consumes the prior's
  structured output). That is the textbook case for a **sequential chain under one coordinator** —
  which is the degenerate, lowest-complexity form of hierarchical.
- A coordinating **judgment layer is required** for quality control: the validation gate must
  detect when the LLM output is off-schema, unverifiable, low-confidence, or rule-set-failing, and
  **route** to review. That routing decision is exactly the orchestrator's job (hierarchical),
  not something a flat chain expresses cleanly.
- It is the **most debuggable** topology: one trace, one ledger, one place that decides the next
  step. For a compliance system where "trace a wrong answer back to the stage that caused it" is
  non-negotiable (§9), debuggability outweighs the marginal latency a flatter design might save.

**Why NOT the other patterns (trade-offs named):**

| Pattern | Why rejected here | What we'd gain / give up |
|---------|-------------------|--------------------------|
| **Pure sequential chain (no coordinator)** | Cannot express the quality-gate routing (proceed vs skip-garbage vs review) or contradiction handling without leaking branching into stage code. Context loss compounds across hops with nothing owning the ledger. | Gain: marginal simplicity. Give up: routing, the task ledger, single-point failure handling. The chain *is* the hierarchical happy path, so we keep the coordinator. |
| **Parallel fan-out/fan-in** | The stages are **dependent**, not independent — OCR needs the image, the LLM needs the OCR text, the gate needs the LLM output. There is no independent work to parallelize within one label. Fan-out's value (latency on independent subtasks) does not apply. | Gain: nothing for a single label. Give up: simplicity. (Parallelism belongs at the *fleet* level — many ingestions processed concurrently by worker instances — not *within* one label's pipeline. §11.) |
| **Evaluator-optimizer loop** | We *do* have a bounded re-ask (the LLM repair, ≤2, PROMPT-CONTRACT §7), but it is a **bounded fallback**, not an open optimization loop — the evaluator (the gate) uses hard pass/fail criteria, not a score to maximize, and there is a hard exit at 2. Promoting it to a full loop risks the never-converge failure mode for no quality gain (the gate is binary). | Gain: nothing — the repair is already the useful slice. Give up: a hard exit guarantee if we loosened it. We keep the bounded re-ask, not a loop. |
| **Mesh / peer network** | **Highest complexity, hardest to debug, exponential context growth, deadlock risk.** There is no negotiation or consensus problem here — every step has a clear owner and a clear hand-off. Mesh would violate the "default to hierarchical unless justified" rule with zero offsetting benefit. | Gain: none. Give up: traceability, sanity. Explicitly rejected. |

**Justified deviations from a pure hierarchy (both minimal):**

1. **One async hop.** After the raw artifact is stored synchronously, the rest of the pipeline runs
   in the async worker, dispatched via the transactional outbox (BACKEND §1.1/§2.3). This is *not*
   a topology change (it is still one orchestrator), but the trace crosses a queue boundary; the
   trace context rides the event envelope so the trace stays connected (BACKEND §10.3).
2. **One conditional branch.** The OCR-quality gate routes to {proceed-to-LLM | skip-garbage→review
   | non-food→review}. This is a single decision node owned by the orchestrator, not a sub-network.

---

## 2. Textual topology diagram

```
                              SYNCHRONOUS  (ingestion request path — fast, never blocked by providers)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │  Client (scanner-device / fishmonger)                                                          │
 │        │  POST /v1/ingestions  (image + meta + Idempotency-Key)   [hostile external content]   │
 │        ▼                                                                                        │
 │  ╔════════════════════════════════════════════════════════╗                                   │
 │  ║ SubmitCapture use case (sync)                            ║                                   │
 │  ║  1 Clock.now (trusted server time)                       ║                                   │
 │  ║  2 ObjectStore.put(image)  ─────────────────────────────╫────────────►  ┌───────────────┐   │
 │  ║  3 RawArtifactRepository.append(raw image ref) [BEFORE]  ║   raw image   │  RAW STORE     │   │
 │  ║  4 IngestionRepository.save(status=raw_stored)           ║   raw OCR     │ (append-only,  │   │
 │  ║  5 AuditLogPort.append ─────────────────────────────────╫───────────────│  immutable,    │   │
 │  ║  6 outbox: enqueue RunExtraction(ingestion_id)           ║   audit  ┌────►│  ADR-0003/0004)│   │
 │  ╚═════════════════════════════════╤════════════════════════╝          │   └───────────────┘   │
 │        202 Accepted (status=raw_stored)                                 │                       │
 └─────────────────────────────────────┼──────────────────────────────────┼───────────────────────┘
                                        │ outbox row (same DB txn)         │ audit
                                        ▼                                  │
                         ┌──────────────────────────────┐                 │
                         │ TRANSACTIONAL OUTBOX + BUS    │  at-least-once  │
                         │ (BACKEND §2.3; event_id dedup)│  trace ctx rides│
                         └───────────────┬───────────────┘  the envelope  │
                                         │                                 │
 ════════════════════════════════════════╪══════════════ ASYNC HOP ═══════╪══════════════════════
                                         ▼  (async extraction worker, app/worker.py)              │
   ╔══════════════════════════════════════════════════════════════════════════════════════════╗  │
   ║  RunExtraction  =  THE ORCHESTRATOR  (owns the task ledger = envelope.stage_results)       ║  │
   ║                                                                                            ║  │
   ║   [1] Preprocess ──► [2] OCR (OcrPort*) ──► [3] OCR-quality gate ──► decision:            ║  │
   ║        (sync, opt)        (provider, retry/CB)      │                                       ║  │
   ║                                                     ├── verdict=skip_garbage ─┐            ║  │
   ║                                                     ├── verdict=review ────────┤            ║  │
   ║                                                     └── verdict=proceed         │            ║  │
   ║                                                          ▼                      │            ║  │
   ║   [4] LLM structured extraction (LlmExtractorPort*) ──► [5] Schema + no-fab GATE ──► [6]   ║  │
   ║        (provider, retry/CB, bounded ≤2 repair re-ask)    (structural+evidence)   business  ║  │
   ║                                                                                  validation ║  │
   ║                                                                                   (rule-set ║  │
   ║                                                                                    snapshot)║  │
   ║                                                          ┌───────────────────────────┘      ║  │
   ║                                                          ▼                                   ║  │
   ║                                          decision: required ok & high-conf & not quarantined?║  │
   ║                                              │ yes                         │ no              ║  │
   ║                                              ▼                             ▼                 ║  │
   ║   [8] STORE ExtractionRun (ExtractedFields)        ── HUMAN-REVIEW BRANCH (gate, §8) ──┐    ║  │
   ║       status=extracted                              status=needs_review;               │    ║  │
   ║       publish LabelExtractionCompleted              publish ExtractionFlaggedForReview │    ║  │
   ║              │                                              │                            │    ║  │
   ║              ▼                                              ▼  reviewer (RBAC) corrects   │    ║  │
   ║   [9] ALERTS (downstream HACCP consumes the event)   PATCH /fields  + POST /confirm       │    ║  │
   ║       (expiry/temp/required-field → Alert)           ⇒ NEW ExtractionRun + audit entry    │    ║  │
   ╚══════════════════════════════════════════════════════════════════════════════╪═══════════╝  │
                                                                                    │              │
   [10] AUDIT LOGGING is cross-cutting: EVERY stage above appends via AuditLogPort ─┴──────────────┘
        to the append-only AUDIT SINK (ADR-0004).  Every stage emits a structured log (trace_id).

   * OcrPort / LlmExtractorPort are the ONLY ports crossing to external providers (ADR-0002).
     Everything else is in-process. No stage-to-stage network hop; no agent negotiation (ADR-0001).
```

**Reading the diagram:** the double-walled boxes are application use cases (orchestrators); single
boxes with `*Port` are the only external-provider stages; the RAW STORE and AUDIT SINK are the
append-only immutable stores; the queue symbol is the single async hop. The human-review branch and
the terminal fallback are explicit, reachable nodes — not error handling bolted on.

---

## 3. Agent (stage) responsibility table

"Owner context" is always **Ingestion & Extraction** for stages 1–8 (they are use-case steps inside
that one context, ADR-0001); stages 9–10 are *reactions* in other contexts/the audit sink, reached
only via published events / the `AuditLogPort` (never a direct cross-context call, §5.3). "Can call
LLM?" is least-privilege: **only stage 4** may.

| # | Stage (agent) | Responsibility (single sentence) | Owner context | Sync / async | Least-privilege READ | Least-privilege WRITE | Can call OCR/LLM? |
|---|---------------|----------------------------------|---------------|--------------|----------------------|-----------------------|-------------------|
| — | **Orchestrator** (`RunExtraction`) | Decompose, sequence, hold the task ledger, route at the gates, synthesize the `ExtractionRun`; **never** does provider work | Ingestion | async (worker) | envelope; ingestion aggregate | envelope `stage_results`/`status`; ingestion status; outbox | No (delegates) |
| 1 | **Preprocess** | Optionally normalize the image (orientation/downscale) into a *derived, non-authoritative* artifact for OCR | Ingestion | sync within worker | raw image ref | envelope `preprocess`; a derived image (NEVER overwrites raw, ADR-0003) | No |
| 2 | **OCR extraction** | Turn the image into raw OCR (text + tokens + per-token confidence + geometry) behind `OcrPort` | Ingestion | async (provider) | image ref | append raw OCR JSON to RAW STORE; envelope `ocr` | **OCR only** (via port/ACL) |
| 3 | **OCR-quality assessment** | Score OCR legibility and decide proceed / skip-garbage / review (the cost-saver gate) | Ingestion | sync within worker | envelope `ocr` (text, mean confidence, token count) | envelope `ocr_quality`; may set `status=ocr_skipped_garbage` | No |
| 4 | **LLM structured extraction** | Produce the strict per-field JSON (value/confidence/evidence/...) per `extraction.v1` behind `LlmExtractorPort`; unknown ⇒ null | Ingestion | async (provider) | envelope `ocr.ocr_text` (as **data**), barcode/locale hints | raw LLM output ref; envelope `llm_extract` | **LLM only** (via port/ACL); **no tools/side-effects** (S3) |
| 5 | **Schema + no-fabrication gate** | Validate output is on-schema and every non-null value's evidence is an exact substring of the raw OCR; coerce unverifiable values to null | Ingestion | sync within worker | envelope `llm_extract`; **raw OCR** (the evidence anchor) | envelope `schema_validate`; security flags | No |
| 6 | **HACCP/business validation** | Apply confidence thresholds, the versioned rule-set snapshot, controlled-vocab, and GTIN checksum | Ingestion | sync within worker | envelope; **rule-set snapshot** (Compliance, read-only); controlled vocabularies | envelope `business_validate`; `missing/low_confidence/out_of_vocab` lists | No |
| 7 | **Human review** (branch, not a stage in the auto path) | Let an authorized human correct/confirm/reject flagged extractions | Ingestion (UI + use cases) | human (out of band) | extraction run; raw image/OCR (signed, `ingestion:read`) | override fields (new provenance) ⇒ **new `ExtractionRun`**; confirm/reject; audit | No |
| 8 | **Storage (synthesis)** | Persist the `ExtractionRun` + `ExtractedField`s; advance status; publish `LabelExtractionCompleted` | Ingestion | sync within worker | envelope (assembled fields) | `IngestionRepository` save; outbox event; audit | No |
| 9 | **Alert generation** | React to extraction/batch/temperature facts and raise HACCP `Alert`s | **HACCP** (separate context) | async (event consumer) | published events only (ACL) | own `Alert` aggregate; audit | No |
| 10 | **Audit logging** | Append an immutable audit entry for every business-critical step | **Audit** (cross-cutting) | sync per write | the action + actor + refs | append-only AUDIT SINK (no UPDATE/DELETE) | No |

**Least-privilege notes (tie to BACKEND §6 RBAC + §5 dependency law):**
- Only stages 2 and 4 hold provider credentials, and only via their adapters in the composition
  root — **no provider key ever reaches the client** (S1). The LLM stage has **no tools** and can
  produce only JSON the gate then validates (S3).
- No stage writes another stage's envelope block (context-ownership). No stage in 1–8 calls another
  *context's* repository; cross-context effects are events only (§5.3). The review branch's writes
  require the human RBAC scopes (`extraction:review`/`:confirm`, BACKEND §6.2).
- Audit (stage 10) is write-only-append and has **no API write path** (`405`, BACKEND §4.9).

---

## 4. Agent input/output contracts

Stages compose by **appending to the shared envelope** (§5): stage *N*'s output block becomes part
of stage *N+1*'s read-set. Contracts below are typed sketches; the envelope schema
([`shared-state.schema.json`](./shared-state.schema.json)) and `extraction.v1.schema.json` are the
authoritative shapes. "REQUIRES" lists the required-context keys the orchestrator verifies present
before the stage runs (the no-silent-truncation enforcement, §5).

```
[1] Preprocess
  REQUIRES: provenance_refs.raw_image_ref
  IN:  { raw_image_ref }
  OUT: stage_results.preprocess = { status: ok|degraded|failed, image_ref, applied:[...], warnings:[...] }
  NOT RESPONSIBLE FOR: OCR, overwriting the raw image (forbidden — ADR-0003)

[2] OCR extraction  (OcrPort)
  REQUIRES: preprocess.image_ref (or raw_image_ref if preprocess was a no-op)
  IN:  { image_ref }
  OUT: stage_results.ocr = { status, raw_ocr_ref, ocr_text, token_count, mean_token_confidence }
       side-effect: append raw OCR JSON to RAW STORE (append-only)
  NOT RESPONSIBLE FOR: interpreting text, deciding quality

[3] OCR-quality gate
  REQUIRES: ocr.ocr_text, ocr.mean_token_confidence, ocr.token_count
  IN:  { ocr_text, mean_token_confidence, token_count }
  OUT: stage_results.ocr_quality = { verdict: proceed|skip_garbage|review, score, reasons:[...] }
  NOT RESPONSIBLE FOR: calling the LLM (it only decides whether to)

[4] LLM structured extraction  (LlmExtractorPort)   — runs ONLY if verdict==proceed
  REQUIRES: ocr.ocr_text, ocr.raw_ocr_ref
  IN:  { ocr_text (DATA), barcode_raw?, locale_hint?, ocr_mean_confidence? }   // PROMPT-CONTRACT §4
  OUT: stage_results.llm_extract = { status: ok|unparseable|off_schema|refused|timeout|circuit_open,
                                     extractor_version, schema_version, raw_output_ref }
       payload (validated downstream): the extraction.v1 object (16 fields × {value,confidence,
       evidence,validation_status,warnings} + top-level raw_warnings)
  NOT RESPONSIBLE FOR: trusting its own output, persisting fields, side effects

[5] Schema + no-fabrication gate   (BACKEND §8.2.1–8.2.2)
  REQUIRES: llm_extract.status==ok, ocr.raw_ocr_ref (the evidence anchor)
  IN:  { llm extraction.v1 object, raw OCR text }
  OUT: stage_results.schema_validate = { valid, fields_accepted:[...], fields_coerced_null:[...],
                                         errors:[...] }
       security.flags may gain EVIDENCE_NOT_IN_RAW_OCR / INJECTION_LANGUAGE_DETECTED
  RULE: any non-null value whose evidence is absent / not an exact substring ⇒ coerced to null,
        reason "unverifiable" (never fabricated)

[6] HACCP/business validation   (BACKEND §8.2.3–8.2.5, §8.4)
  REQUIRES: schema_validate.valid==true, business rule-set snapshot
  IN:  { accepted fields + confidences, rule-set snapshot, controlled vocabularies, barcode_raw? }
  OUT: stage_results.business_validate = { rule_set_version, missing_required_fields:[...],
         low_confidence_fields:[...], out_of_vocab_fields:[...], gtin_status }
  RULE: validate against a VERSIONED SNAPSHOT (no live coupling) so a decision is explainable later

[8] Storage / synthesis
  REQUIRES: business_validate present; security.quarantined==false for the auto-confirm path
  IN:  { envelope (assembled ExtractedFields) }
  OUT: persisted ExtractionRun; ingestion status -> extracted | needs_review;
       event LabelExtractionCompleted (fields[]) OR ExtractionFlaggedForReview
       (missing_required_fields[], low_confidence_fields[])
```

**How outputs compose (and the contradiction check):** the orchestrator treats `stage_results` as
an append-only ledger. The two routing decisions are pure functions of it:
- After [3]: `verdict==proceed` → run [4]; else → human-review branch (LLM skipped).
- After [6]: route to `extracted` **iff** `schema_validate.valid && business_validate.missing_required_fields==[] && no required field in low_confidence_fields && !security.quarantined`; otherwise → `needs_review`.
A **contradiction** (e.g. gate says valid but a required field was coerced null) resolves
deterministically toward **review**, never toward auto-confirm — the safe direction.

---

## 5. Shared state object (the pipeline envelope) + the no-silent-truncation guarantee

Authoritative schema: [`shared-state.schema.json`](./shared-state.schema.json)
(`pipeline-envelope/v1`). Summary of the shape:

```
PipelineEnvelope {
  envelope_version: "pipeline-envelope/v1"
  ids: { ingestion_id, correlation_id, trace_id, span_id?, extraction_run_id }   // REQUIRED, never regenerated mid-run
  status: raw_stored | ocr_running | ocr_done | ocr_failed | ocr_skipped_garbage
        | extraction_running | extracted | extraction_failed | needs_review
        | confirmed | rejected | halted_missing_context
  required_context_keys: [ "<envelope path the NEXT stage requires>", ... ]      // the guarantee, as data
  stage_results: { preprocess?, ocr?, ocr_quality?, llm_extract?, schema_validate?, business_validate? }  // append-only
  attempts: { ocr:{count,max=3,circuit_state}, llm_extract:{count,max=2,circuit_state} }
  security: { flags:[...], quarantined, pii_redaction_applied }
  provenance_refs: { raw_image_ref, raw_ocr_ref, audit_entry_refs:[...] }         // by ID, never inline blobs
}
```

**Required vs optional.** `envelope_version`, `ids`, `status`, `required_context_keys`,
`stage_results`, `attempts`, `security`, `provenance_refs` are **required** (always present). Each
`stage_results.*` entry is **optional** (absent = not-yet-run/skipped — that is information, not an
error). Within a stage's result, its own keys are required (e.g. `ocr` must carry
`status/raw_ocr_ref/token_count/mean_token_confidence`).

**The no-silent-truncation guarantee (mechanism, not a slogan):**

1. **Required-context is declared data.** Before invoking stage *N*, the orchestrator sets
   `required_context_keys` to the envelope paths stage *N* declares it needs, then **verifies each
   is present and non-empty**. (E.g. the LLM stage requires `stage_results.ocr.ocr_text` and
   `provenance_refs.raw_ocr_ref`.)
2. **Missing required context = loud halt.** If any required key is absent/empty, the orchestrator
   sets `status=halted_missing_context`, emits log code `PIPE_REQUIRED_CONTEXT_MISSING`, writes an
   audit entry, and routes to the **terminal fallback (review)**. It **never proceeds on partial
   context** and **never** substitutes a default for a missing required field (that would be
   fabrication, constraint #1).
3. **Compression cannot touch required keys.** The envelope is intentionally small (it holds
   *references by ID*, not blobs — raw image/OCR/LLM output live in stores). If a future change adds
   large optional context and compression is needed, compression may rewrite **optional** keys only;
   it is **forbidden** from dropping any key listed in `required_context_keys`. Detection: a
   post-compression assertion that every required key still resolves; failure ⇒ halt (rule 2),
   never silent.
4. **Append-only ledger.** No stage overwrites another stage's `stage_results` entry, so context is
   never *lost* by a later stage clobbering an earlier one.
5. **IDs are immutable in-run.** `correlation_id`/`trace_id` are populated once by the middleware
   and carried unchanged across the async hop on the event envelope (BACKEND §10.3); regenerating
   them mid-pipeline would break the trace and is forbidden.

This makes "silent truncation," a leading cause of production silent failures, **structurally
impossible**: the only way to lose a required field is a halt that is logged, audited, and reviewed.

---

## 6. Failure mode table

Per stage: failure mode, detection, blast radius, severity, mitigation, and the resulting domain
event / error_code (reusing the BACKEND §5.2 catalog and the `ExtractionFlaggedForReview` event,
ARCHITECTURE §6). Severity: **P1** blocks a hard constraint / loses data; **P2** wrong-but-contained
or degraded; **P3** quality/hygiene.

| Stage | Failure mode | Detection | Blast radius | Sev | Mitigation (and fallback ref §7) | Event / error_code |
|-------|--------------|-----------|--------------|-----|----------------------------------|--------------------|
| Submit (sync) | Object store down → image not stored | PUT timeout/5xx | this capture (could lose it — R9) | **P1** | raw PUT on path with tight timeout; on persistent fail return 503 so client durable queue retries (no data loss) | `DEPENDENCY_UNAVAILABLE` (503) |
| Submit (sync) | Duplicate submit / retry | idempotency key + image checksum | none if caught; duplicate ingestion if not | P2 | HTTP idempotency (key) + content-addressed raw; replay returns original | `IDEMPOTENCY_KEY_CONFLICT` (409) on key reuse w/ different payload |
| 1 Preprocess | Bad transform / crash | exception; status=failed | one ingestion | P3 | **no-op fallback**: skip preprocessing, send raw image to OCR (raw is the anchor anyway) | (internal log `PRE_FALLBACK_NOOP`) |
| 2 OCR | Provider timeout / 5xx | timeout, error code | one ingestion (extraction delayed) | P2 | retry ≤3 backoff+jitter; circuit breaker; raw image already stored; re-queue or → review | run `ocr_failed`; `GATEWAY_TIMEOUT`/`EXTRACTION_PROVIDER_ERROR` on sync trigger |
| 2 OCR | Circuit open (provider degraded) | breaker state | many ingestions (backlog) | P2 | worker pauses stage; `GET extraction` reports `provider_degraded`; `/health/ready` reflects it; ingestion still accepted | `DEPENDENCY_UNAVAILABLE` (503) on sync trigger |
| 3 OCR-quality | Garbage OCR sent onward | quality score < threshold | wasted LLM spend + noisy data | P2 | **gate short-circuits**: verdict `skip_garbage` → skip LLM → review (cost saver §11) | `ExtractionFlaggedForReview` (reason unreadable) |
| 3 OCR-quality | Non-food / wrong image | low legible-token ratio + heuristics | one ingestion | P3 | verdict `review`; `NON_FOOD_CONTENT_SUSPECTED` flag; no batch created | `ExtractionFlaggedForReview` |
| 4 LLM | Invalid/partial JSON | gate parse + schema fail | one ingestion | **P1** (would corrupt data if trusted) | bounded repair re-ask ≤2; then run `extraction_failed`, raw retained, **zero** fields | `ExtractionFlaggedForReview` (extractor_unparseable) |
| 4 LLM | Refusal / apology / question | non-JSON output | one ingestion | P2 | treated as invalid JSON; bounded re-ask; persistent → fail loud | `ExtractionFlaggedForReview` (extractor_refused) |
| 4 LLM | **Hallucinated value** | gate evidence-substring check (stage 5) | **P1 if trusted** | **P1** | gate coerces to null, reason `unverifiable`; flag `EVIDENCE_NOT_IN_RAW_OCR` | (coercion deterministic; if required field emptied → review) |
| 4 LLM | **Prompt injection in OCR text** | injection-language heuristic + schema/evidence gate | **P1 if obeyed** | **P1** | OCR is data not instructions (S3); model has no tools; gate validates; flag `INJECTION_LANGUAGE_DETECTED` → quarantine → review | `ExtractionFlaggedForReview`; security event to SIEM |
| 4 LLM | Provider timeout / circuit open | timeout, breaker | one/many ingestions | P2 | retry ≤2; circuit breaker (separate from OCR); raw retained; no fabricated fields | run `extraction_failed`; `GATEWAY_TIMEOUT` on sync trigger |
| 5 Gate | Off-schema slips (schema bug) | schema meta-validation in CI; runtime validate | many if undetected | P2 | strict `additionalProperties:false`; CI malformed-instance battery; runtime reject | `BUSINESS_RULE_VIOLATION` / fail run |
| 6 Business | Required field missing/low-confidence | rule-set snapshot check + confidence band | one ingestion | P2 | route to review; never fabricate; populate flagged lists | `ExtractionFlaggedForReview`; `REQUIRED_FIELD_MISSING`/`LOW_CONFIDENCE_FIELD` (422 at confirm) |
| 6 Business | GTIN checksum invalid | GS1 check-digit | one batch identity | P3 | keep raw barcode (what label said), do NOT promote to validated identity; flag | `GTIN_CHECKSUM_INVALID` (422) |
| 6 Business | Out-of-vocab value | controlled-vocab lookup | one field | P3 | keep value, flag `out_of_vocab`, route to review (don't discard, don't silently accept) | `ExtractionFlaggedForReview` |
| 6 Business | Rule-set snapshot unavailable | snapshot read fails | many ingestions | P2 | use last-known-good snapshot version (pinned); if none → halt + review (never validate with no rules) | `DEPENDENCY_UNAVAILABLE`; `halted_missing_context` |
| Orchestrator | Missing required context (any hop) | required-context check (§5) | one ingestion | **P1** (silent-loss risk) | **loud halt**: `halted_missing_context`, log, audit, → review; never proceed partial | `ExtractionFlaggedForReview`; log `PIPE_REQUIRED_CONTEXT_MISSING` |
| Orchestrator | Worker crash mid-run | job not acked; envelope lost (in-memory) | one ingestion (re-run) | P2 | outbox/queue redelivers (at-least-once); idempotent re-run (raw already stored; new run id); event_id dedup downstream | (re-delivery; no event duplication) |
| 8 Storage | DB write fails / serialization error | exception | one ingestion | P2 | transactional retry on transient; raw + audit are append-only (unique constraint makes retry safe) | `INTERNAL_ERROR` (500, cautiously retriable) |
| 8 Storage | Audit write fails | audit append error | **compliance integrity** | **P1** | **page immediately** (BACKEND §10.5); no business write without its audit row (same txn) → fail the action rather than proceed unaudited | alert + `INTERNAL_ERROR` |
| 9 Alert | Event consumer keeps failing (poison) | retry exhaustion | alerting only (extraction unaffected) | P2 | DLQ with full envelope + last error; alertable, replayable; never silently dropped | (dead-letter; ops alert) |
| 10 Audit | Tamper attempt (UPDATE/DELETE) | DB grants + trigger reject | n/a (blocked) | **P1** if it succeeded | append-only grants + trigger; no API write path (405); optional hash-chain for tamper-evidence | `METHOD_NOT_ALLOWED` (405) |

---

## 7. Fallback chain per agent (stage)

Every stage has an ordered chain; the **terminal fallback is always: fail loud + retain raw +
flag for review + audit, never fabricate.** "Trigger" is what escalates to the next tier.

| Stage | 1 Primary | 2 Narrowed fallback | 3 Degraded | 4 Terminal (human) |
|-------|-----------|----------------------|------------|--------------------|
| **1 Preprocess** | full enhancement (orient/downscale) | trigger: transform error → **pass-through raw image** to OCR | n/a (raw is the anchor) | n/a — preprocessing failure never blocks; worst case OCR runs on raw |
| **2 OCR** | provider via `OcrPort`, primary settings | trigger: timeout/5xx → **retry ≤3** backoff+jitter | trigger: circuit open → **defer/re-queue** the job; report `provider_degraded` | trigger: persistent fail → `ocr_failed`, **retain raw image**, `ExtractionFlaggedForReview`, audit; human re-capture/retry |
| **3 OCR-quality** | composite score → proceed | trigger: borderline score → **bias to review** (conservative) | n/a | trigger: garbage/non-food → **skip LLM**, route to review (cost-saving terminal that still produces a structured `needs_review`) |
| **4 LLM** | provider via `LlmExtractorPort`, deterministic settings | trigger: invalid/partial/off-schema/refusal → **bounded repair re-ask ≤2** (same input, "return the COMPLETE schema-valid object") | trigger: timeout/circuit → **defer/re-queue**; report `provider_degraded` | trigger: re-ask budget exhausted → `extraction_failed`, **zero fabricated fields**, retain raw, `ExtractionFlaggedForReview`, audit |
| **5 Gate** | accept on-schema + evidence-tied | trigger: value evidence not in raw OCR → **coerce that value to null** (deterministic, not a re-call) | n/a | trigger: required field emptied by coercion → review |
| **6 Business** | validate vs current rule-set snapshot | trigger: snapshot unreachable → **pinned last-known-good snapshot version** | trigger: warn-only mode (Phase 3 rollout) → flag but don't block | trigger: no snapshot at all → halt + review (never validate with no rules) |
| **7 Human review** | authorized reviewer corrects/confirms | trigger: reviewer unsure → **escalate role** (fishmonger → supervisor) | trigger: SLA breach → re-queue with raised priority + ops alert | trigger: unrecoverable (e.g. unreadable label) → **reject** with reason; no batch; raw retained, audited |
| **8 Storage** | transactional save + event | trigger: transient (serialization/deadlock) → **retry** | n/a (append-only safe) | trigger: persistent → fail the action (and its audit) loudly; nothing partially committed |
| **9 Alert** | consume event, evaluate control | trigger: consumer error → **retry with backoff** | n/a | trigger: poison → **DLQ**, ops alert, replayable; never dropped |
| **10 Audit** | append in same txn as the business write | n/a (must succeed) | n/a | trigger: audit write fails → **page immediately**, fail the business action rather than proceed unaudited |

**Cross-cutting fallback rules:** (a) re-asks/retries are **idempotent and bounded** — no open
loops; (b) the pipeline **never partial-merges** a successful half of one attempt with another
(manufactures provenance — PROMPT-CONTRACT §7.3); (c) every terminal fallback **keeps the raw image
and raw OCR** (recoverable/reprocessable, ADR-0003) and emits `ExtractionFlaggedForReview` so
nothing is silently dropped; (d) **re-extraction is additive** — a later/better run is a new
`ExtractionRun`, never an overwrite (ADR-0003, R19).

---

## 8. Human-in-the-loop gates

**Calibration principle (avoid both failure modes):** over-escalation breeds rubber-stamping;
under-escalation breeds false confidence. So review is **mandatory only** on the conditions below,
and the review-rate is a tracked metric (BACKEND §10.2: "% ingestions sent to `needs_review`") with
an expected band — drift in either direction is an alert (eval E19).

**Review is REQUIRED when any of:**

| Trigger | Source | Gate type |
|---------|--------|-----------|
| **Missing required field** (rule-set-required field null) | business validation §6 | **blocking** (cannot auto-confirm) |
| **Low confidence on a required field** (below the `Confidence` review band) | confidence threshold §6 | **blocking** |
| **Ambiguous** (date order, place-name FAO, unmappable production method) | LLM `validation_status=ambiguous` + gate | **blocking** for required fields; advisory for optional |
| **Validation failure** (off-schema after repair, GTIN invalid, out-of-vocab) | gate §5 / business §6 | **blocking** for off-schema; advisory flag for GTIN/vocab |
| **Security flag** (`INJECTION_LANGUAGE_DETECTED`, `EVIDENCE_NOT_IN_RAW_OCR`, `NON_FOOD_CONTENT_SUSPECTED`, `PII_SUSPECTED`) | gate / quality stage | **blocking** (quarantined — cannot auto-confirm) |

**Who reviews (RBAC, BACKEND §6.2):**
- **`fishmonger`** — day-to-day review/correct of flagged fields (`extraction:review`,
  `ingestion:read`). Can edit field values; **cannot** confirm (no `extraction:confirm`).
- **`supervisor`** — everything the fishmonger can, **plus confirm** (`extraction:confirm`,
  which creates the traceability batch) and reject. Escalation target when a fishmonger is unsure.
- **`auditor`** — **read-only everywhere**; reviews after the fact, cannot mutate (protects audit
  independence).
- **`admin`** — supervisor + provisioning; admin actions are themselves audited.

**What reviewers CAN / CANNOT change:**
- **CAN:** edit a field's `value` (recorded as **new provenance**, `source: human`, original
  retained — ADR-0005, BACKEND §4.3 `PATCH /fields/{name}`); confirm (supervisor+); reject with a
  reason.
- **CANNOT:** edit the **raw OCR or raw image** (immutable, ADR-0003); edit a **confirmed**
  extraction (status is monotonic — corrections create a **new `ExtractionRun`**, ARCHITECTURE
  §7.1); delete history; write the audit log directly.

**Overrides create a new run + audit entry.** Every human override/confirm produces a **new
`ExtractionRun`** referencing the same immutable raw artifact and writes an audit entry (actor,
action, before/after refs, server time, correlation/trace ids — ARCHITECTURE §7.7). The prior run
is retained; nothing is overwritten.

**SLA / queue behavior:**
- The review queue is a worklist of `needs_review` ingestions, ordered by **severity then age**
  (security-flagged and required-field-missing first).
- **SLA:** define a target time-to-review per severity (e.g. security-flagged < safety-relevant <
  routine — concrete numbers owned by ops, not invented here). **SLA breach** → re-queue at raised
  priority + ops alert (BACKEND §10.5); it never silently ages out.
- **No auto-approve on timeout.** A review that is not actioned stays `needs_review` (fail-safe:
  the safe default for a compliance system is *unconfirmed*, never *auto-confirmed*). The blocking
  gate's "timeout behavior" is therefore explicit: **default to remaining blocked**, escalate, never
  default-approve.
- A confirm is itself idempotent (BACKEND §7) — a double-click does not create two batches.

---

## 9. Trace / logging contract

Realizes constraint #8 and extends BACKEND §10. **Every stage emits one structured log line per
invocation**, sharing the run's `trace_id` + `correlation_id`, as a child span. One trace spans the
whole pipeline including the async hop (the trace context rides the event envelope, BACKEND §10.3).

**Per-stage structured log schema:**

```json
{
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",   // shared across the whole pipeline run
  "correlation_id": "corr_01J...",                  // echoed end to end (constraint #8)
  "span_id": "01J...",                              // this stage's span (child of trace)
  "ingestion_id": "ing_01J...",
  "extraction_run_id": "run_01J...",
  "stage": "llm_extract",                            // preprocess|ocr|ocr_quality|llm_extract|schema_validate|business_validate|store|alert|audit
  "attempt": 1,                                      // bounded (OCR<=3, LLM repair<=2)
  "decision": "proceed",                             // stage outcome/route: proceed|skip_garbage|review|coerced_null|needs_review|extracted|...
  "latency_ms": 1243,
  "llm": { "extractor_version": "...", "input_tokens": 1820, "output_tokens": 412, "cost_usd": 0.0087 },  // ONLY for the LLM stage; omitted/null elsewhere
  "ocr": { "token_count": 142, "mean_token_confidence": 0.88 },                                           // ONLY for OCR stage
  "outcome": "success",                              // success|partial|failed|escalated|skipped
  "error_code": null,                                // from BACKEND §5.2 catalog when failed
  "log_code": "EXT_LLM_OK",                          // stable registry code (append-only, like error codes)
  "security_flags": []                               // any flags raised this stage (codes only, never the offending content)
}
```

- **Stable log codes** (a registry with the same append-only discipline as error codes):
  `ING_RAW_STORED`, `PRE_FALLBACK_NOOP`, `OCR_OK`, `OCR_TIMEOUT`, `OCR_CIRCUIT_OPEN`,
  `OCRQ_SKIP_GARBAGE`, `OCRQ_NONFOOD`, `EXT_LLM_OK`, `EXT_LLM_REJECTED_OFFSCHEMA`,
  `EXT_LLM_UNPARSEABLE`, `EXT_LLM_REFUSED`, `GATE_EVIDENCE_COERCED_NULL`, `GATE_INJECTION_FLAGGED`,
  `BIZ_REQUIRED_MISSING`, `BIZ_LOW_CONF`, `BIZ_GTIN_INVALID`, `PIPE_REQUIRED_CONTEXT_MISSING`,
  `HACCP_ALERT_RAISED`, `AUDIT_WRITE_FAILED`.
- **Per-run consolidated log:** total latency, total cost, stages run/skipped/failed, final status,
  review flags, HITL gate triggered + (later) reviewer decision. (Mirrors BACKEND §10 RED/USE +
  domain metrics: extraction success rate, mean per-field confidence, % `needs_review`,
  required-field-miss rate.)

**What must NEVER be logged (redaction — S2/S6):**
- Provider/API keys, full bearer tokens, DB credentials, signing keys.
- Raw provider payloads / image bytes (reference them by ID only).
- **Full PII** or extracted PII values. The **offending content of a security flag is never logged**
  — only the flag code (e.g. log `INJECTION_LANGUAGE_DETECTED`, not the injection string).
- The redaction layer scrubs log *projections*; the envelope itself holds refs-by-ID, not inline
  PII (`security.pii_redaction_applied` records that scrubbing ran). Auth failures/denials are
  logged as **security events** (not business-audit entries) for the SIEM (BACKEND §6.4).

---

## 10. Eval suite design (≥20 categories) — summary

Full suite: [`eval-suite.md`](./eval-suite.md). **25 categories** (exceeds the 20 minimum). Levels:
**stage** (unit, fakes via ports) → **prompt** (SC1–SC10, PROMPT-CONTRACT §2) → **pipeline**
(integration, deterministic fakes) → **regression** (whole golden set on any change).

**The 25 categories (condensed; each row in `eval-suite.md` has input shape + pass criteria + gate
protected):** E01 happy-path text · E02 happy-path image (raw-before-OCR) · E03 OCR garble preserved
· E04 missing required field · E05 unreadable/all-null (graceful degrade) · E06 date order ambiguity
· E07 partial date · E08 Fahrenheit conversion · E09 weight g/kg edge · E10 currency ambiguity ·
E11 FAO place-name no-number · E12 production-method unmappable · E13 out-of-vocab kept+flagged ·
E14 **prompt injection** · E15 **fabricated evidence** (no-fab gate) · E16 **non-food image** · E17
**multilingual** · E18 low-confidence required field · E19 **confidence calibration** (ECE≤0.10) ·
E20 invalid JSON → bounded repair · E21 off-schema → bounded repair · E22 **OCR timeout → fallback**
· E23 **LLM timeout → fallback** · E24 **idempotent replay** · E25 **additive re-extraction**.

Coverage maps directly onto the brief's required cases: happy path, OCR noise, missing required
fields, ambiguity, prompt-injection/hostile content, non-food image, multilingual, date-format
ambiguity, unit edges, low-confidence calibration, schema-violation/repair, provider-timeout
fallback, idempotent replay.

**CI + deploy gate (from `eval-suite.md` §4):** on any change to a stage/prompt/schema/rule-set/gate
→ run stage unit evals → prompt evals (hard gates SC1/SC3/SC10 must pass; soft gates no-regress ×3
runs) → pipeline integration evals (hard-gate categories **E04, E05, E14, E15, E20, E22, E23, E24**
must pass) → schema meta-validation → contract tests. **Deploy gate:** hard-gate categories 100%
pass, soft categories no-regression-beyond-tolerance vs recorded baseline ×3 runs, every stage has
an exercised fallback eval, observability asserted (trace_id present, no secret/PII leak in log
projections). **Golden set + regression:** ≥20 domain-reviewed input/expected pairs (seeded by
PROMPT-CONTRACT §6), deterministic, recorded baselines, meet-or-exceed to ship. Cross-model porting
re-runs the suite with prompt fixed (a model needing prompt edits = a MINOR version, logged).

---

## 11. Cost and latency trade-offs

| Driver | Where | Cost / latency impact | Trade-off named |
|--------|-------|------------------------|------------------|
| **Object-store PUT on the request path** | Submit (sync) | dominates ingestion p95 (BACKEND SLO p95<1.5s) | We pay sync-write latency to **guarantee raw-before-normalized + no-data-loss** (ADR-0003, R9). Worth it; the alternative loses captures. |
| **Async extraction off the request path** | outbox + worker | adds queue infra + eventual (not instant) extraction (freshness SLO p95<60s) | We give up instant results to **isolate provider latency/outages from capture**. Strongly worth it. |
| **OCR provider call** | stage 2 | hundreds of ms–seconds; per-call \$ | Retries/backoff add latency on failure; bounded ≤3. Cost bounded by per-principal rate limits (BACKEND §9.3). |
| **LLM provider call** | stage 4 | the largest single latency + token \$ cost | Biggest cost center. Mitigated by the OCR-quality gate (below) and caching (below). `evidence` substrings add output tokens (PROMPT-CONTRACT §5.3 trade-off) — accepted for provenance. |
| **OCR-quality gate as a cost saver** | stage 3 | a cheap heuristic that can **skip the LLM entirely** on garbage | **Named saver:** every `skip_garbage`/`review` verdict avoids one LLM call. On a noisy capture stream this is the single biggest spend reducer; cost: a small false-skip risk, mitigated by biasing borderline scores to *review* (not silent drop) and tracking false-skip in evals. |
| **Two-pass repair re-ask (≤2)** | stage 4 fallback | up to 2 extra LLM calls on malformed output | Bounded so worst case is 3× the LLM cost for that ingestion, not unbounded. Trade-off: a little extra spend to rescue a recoverable run vs sending every malformed run to a human (human time is more expensive). Hard cap prevents the never-converge cost blowup. |
| **Caching by content hash** | submit / extraction | identical image (same checksum) need not re-OCR/re-extract | **Named saver:** content-addressed raw store already dedups identical images; idempotency replay returns the original result with **zero** provider calls (E24). Trade-off: cache only on exact-content match (no fuzzy match — fuzzy risks serving a wrong label's data). |
| **Batching** | worker | grouping many ingestions per worker tick | Fleet-level throughput/\$ efficiency (amortizes provider connection overhead, enables provider batch endpoints later). Trade-off: batching adds per-item latency (wait to fill a batch) — bounded by a max-wait so freshness SLO holds. Parallelism lives **across** ingestions (worker concurrency, bulkheaded pools BACKEND §9.3), never **within** one label's dependent chain. |
| **Human review** | branch | human-time cost + latency (out of band) | Most expensive per item. Calibrated gates (§8) keep the review rate in-band — over-escalation wastes human time, under-escalation risks compliance. Tracked as a metric (E19). |

**Budget / SLO interplay (BACKEND §10.4):** a per-run **cost ceiling** and the latency SLOs are
co-enforced — the OCR-quality gate + caching protect the cost ceiling; the async hop + bulkheads +
circuit breakers protect the latency/availability SLOs. A runaway scanner-device is rate-limited
(`429`), bounding both cost and provider-quota drain (S10).

---

## 12. Production readiness checklist

**Correctness**
- [ ] Topology documented with a data-flow diagram (§2); each stage has an input/output contract (§4).
- [ ] No stage receives, or proceeds on, missing required-context — the required-context check halts loudly (§5).
- [ ] Unknown ⇒ `null`, never fabricated, at every stage (constraint #1); evidence ties every non-null value to raw OCR (gate §5).
- [ ] Re-extraction is additive (new `ExtractionRun`); raw is never overwritten (ADR-0003) — asserted by eval E25.
- [ ] Contradiction at the gate resolves toward review, never toward auto-confirm (§4).

**Security / hostile input**
- [ ] OCR text + client meta treated as hostile data, never instructions (S3); LLM stage has no tools/side-effects.
- [ ] Injection-language detection + evidence-substring gate + quarantine → review wired (E14, E15); offending content never logged (§9).
- [ ] Non-food/irrelevant image handled (verdict `review`, no batch) (E16).
- [ ] No provider key on the client; provider creds only in adapters at the composition root (S1, §3).
- [ ] PII redaction on log projections; secrets/tokens/raw payloads/image bytes never logged (§9, S2/S6).

**Observability**
- [ ] Every stage emits a structured log with shared `trace_id` + `correlation_id` (§9).
- [ ] One trace spans the whole pipeline incl. the async hop (trace ctx on the event envelope).
- [ ] Stable log-code registry (append-only) + per-run consolidated log (cost/latency/status/flags).
- [ ] Alerts on: object-store PUT failures, extraction backlog/queue age, provider circuit open, DLQ non-empty, **audit-write failure (page)** (§6, BACKEND §10.5).

**Evals / thresholds**
- [ ] ≥20 (here 25) eval categories with golden input/expected pairs, domain-reviewed (eval-suite.md).
- [ ] Recorded baselines; hard gates (SC1/SC3/SC10 + E04/E05/E14/E15/E20/E22/E23/E24) must pass; soft gates no-regress ×3 runs.
- [ ] Schema meta-validation + malformed-instance battery in CI; deploy gate blocks on failure.
- [ ] Cross-model porting re-runs the suite with the prompt fixed; a model needing prompt edits = a logged MINOR version.

**Fallback coverage**
- [ ] Every stage has an ordered fallback chain ending in fail-loud + retain-raw + flag-for-review + audit (§7).
- [ ] OCR retry ≤3, LLM repair re-ask ≤2 — both hard-bounded; no open loops; circuit breakers per provider.
- [ ] Never partial-merge attempts; never auto-approve on review timeout (fail-safe = remain blocked) (§7, §8).
- [ ] Idempotency at HTTP edge (key) + event bus (event_id) + content-addressed raw — no double side-effects (E24).

**Human-review ops**
- [ ] Review required exactly on the §8 triggers; review-rate tracked with an expected band (E19).
- [ ] RBAC enforced: fishmonger reviews, supervisor confirms, auditor read-only, admin audited (§8, BACKEND §6).
- [ ] Overrides recorded as new provenance ⇒ new `ExtractionRun` + audit entry; raw/OCR immutable to reviewers (§8).
- [ ] Queue ordered by severity-then-age; SLA breach re-queues + alerts; no silent age-out.

**Rollback / reversibility**
- [ ] Business validation can run warn-only first (Phase 3) so a mis-set threshold degrades to extra review, not blocked ops.
- [ ] Provider swap is an adapter change only (ADR-0002); async worker extractable to a service is an adapter swap (ADR-0001).
- [ ] Append-only raw + audit are intentionally hard to reverse (their value); everything around them (retention, thresholds, rule-set) is versioned policy/data, reversible.
- [ ] Worker crash mid-run is recoverable: outbox redelivers, re-run is idempotent (raw already stored, new run id, event_id dedup).

---

## Appendix — consistency with locked decisions

| Locked decision | Honored here by |
|-----------------|-----------------|
| Modular monolith, not microservices (ADR-0001) | §framing + §1: stages are in-process pipeline steps; one orchestrator; no inter-service hop; no mesh |
| Hexagonal; OCR/LLM behind replaceable ports (ADR-0002) | §3: only stages 2 & 4 cross to providers, via `OcrPort`/`LlmExtractorPort`; provider-agnostic throughout |
| Raw-before-normalized, immutable (ADR-0003) | §2 (raw stored sync before async extraction), §5 (refs by ID), §7 (retain raw on every terminal fallback), E25 |
| Append-only audit (ADR-0004) | §3 stage 10, §6 (tamper blocked, audit-fail pages), §9 (audit on every step) |
| Confidence + provenance per field; unknown ⇒ null (ADR-0005) | §4/§5 (evidence-tied), §6 (confidence bands), gate coercion to null |
| Async, queue-backed extraction off the request path (BACKEND §1.1) | §2 the single async hop after the sync raw store |
| Transactional outbox + bus, idempotent consumers (BACKEND §2.3, §7) | §2, §6 (worker crash recovery), E24 |
| LLM never trusted without the validation gate (BACKEND §8) | §1 (gate as a first-class stage = trust boundary), §6, §7 |
| correlation_id + trace_id everywhere (constraint #8) | §5 (immutable in-run ids), §9 (trace contract across the async hop) |
| Bounded ≤2 repair re-ask; new ExtractionRun on re-extraction; ExtractionFlaggedForReview (PROMPT-CONTRACT) | §6, §7 (bounded, no partial-merge), §8 (overrides ⇒ new run + audit) |
| No fabricated regulatory specifics | §6/§8 keep raw FAO/GTIN/approval as-read, flag rather than map; no real codes asserted |
