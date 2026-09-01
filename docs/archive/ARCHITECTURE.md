# LabelScan — Target Architecture

> **Archived:** Historical architecture target, not current development guidance. See the
> [archive index](README.md) and [enterprise architecture](../ENTERPRISE-ARCHITECTURE.md).

> Archivé le 20 août 2026 : cible historique, remplacée par `ENTERPRISE-ARCHITECTURE.md` et les ADR.

**Status:** Historical target/design record. The current runtime and production trust
boundaries are documented in
[`../security/SECURITY-ARCHITECTURE.md`](../security/SECURITY-ARCHITECTURE.md).
**Date:** 2026-08-03 (runtime reference added; original design dated 2026-06-18)
**Author:** Software Architect
**Scope:** `LabelScan/` only. Sibling projects (FishTrac, TRACEO, TRACEO1) are out of scope.
**System:** HACCP-oriented seafood traceability for large-scale retail fishmongery.

---

## 0. Reading guide & non-negotiables

This document covers domain discovery, bounded contexts, the target modular-monolith +
hexagonal architecture, C4 diagrams, dependency rules, domain events, aggregate boundaries,
ADRs, and a phased migration strategy. The ADRs live as individual files under
[`adr/`](../architecture/adr/) and are summarised in [Section 8](#8-architecture-decision-records-summary).

Architecture-shaping hard constraints (from the brief). Every section below is checked against
these:

1. Do not hallucinate regulatory data; do not invent missing label fields. Unknown ⇒ `null`.
2. Every extracted field carries a **confidence score** and provenance.
3. **Raw** label data is stored **before** any normalization.
4. All business-critical changes are **auditable**; historical traceability data is **immutable**.
5. The **domain layer** must not depend on frameworks, DB, HTTP, OCR or LLM providers.
6. OCR and LLM providers must be **replaceable** via ports & adapters.
7. Prefer maintainable, **reversible** decisions over optimal-but-rigid ones; name trade-offs.
8. `correlation_id` and `trace_id` everywhere.

A note on regulatory scope: the *source* of the required label fields for fishery products is
the EU consumer-information regime for fishery and aquaculture products (commonly associated
with Regulation (EU) No 1379/2013 and the general food-information rules). This document
references that regime only at a high level to justify which fields exist; it does **not**
encode article numbers, thresholds, or legal text. Regulatory specifics belong in a versioned
**rule set** owned by the Compliance context (see §2.6), never hard-coded in the domain.

---

## 1. Current architecture risks (prioritized)

Risk = (impact on the hard constraints) × (likelihood / blast radius). P1 = blocks a
non-negotiable constraint; P2 = serious correctness/operability; P3 = quality/hygiene.
IDs `D*`/`A*` reference `AUDIT.md`; re-confirmed against the live source files.

| # | Pri | Finding (ref) | Why it matters here | Confirmed in | Status |
|---|-----|---------------|---------------------|--------------|--------|
| R1 | **P1** | **No raw store; raw OCR discarded** (D3) | `ocr.ts:74-77` keeps only `fullTextAnnotation.text`; bounding boxes + confidence are dropped. Violates constraint #3 and #2 at the source | `src/services/ocr.ts` | **RESOLVED** — backend raw_artifact stores everything; legacy path still discards (opt-in only) |
| R2 | **P1** | **History is mutable & destructive** (D4) | `deleteArticle` physically deletes record + photo; `saveArticle` does a non-atomic whole-array rewrite | `src/services/storage.ts:37-83` | **RESOLVED** (backend) — append-only with deny_mutation trigger; mobile still uses AsyncStorage |
| R3 | **P1** | **No audit log** (D5) | Nothing records who/what/when | absent | **RESOLVED** — audit.audit_log with same-txn co-commit |
| R4 | **P1** | **No confidence scores** (D2) | Vision per-symbol/word confidence computed and thrown away | `src/services/ocr.ts:74` | **RESOLVED** — per-field combined_confidence + confidence_band |
| R5 | **P1** | **OCR provider hardwired; no ports** (A1) | `extractTextFromImage` imported directly by CameraScreen | `CameraScreen.tsx`, `ocr.ts` | **PARTIALLY RESOLVED** — backend uses OcrPort/LlmExtractorPort; legacy on-device path still hardwired |
| R6 | **P1** | **No structured seafood fields** (D1) | `Article` is `{id, photoUri, ocrText, barcodeValue?, capturedAt}` — one opaque string | `src/types/Article.ts` | **RESOLVED** — 15 structured extracted_field rows + Article type with fields[] |
| R7 | **P1** | **Secret in client bundle** (A3) | `EXPO_PUBLIC_GOOGLE_VISION_KEY` ships in JS | `src/services/ocr.ts:6-7,25,62` | **PARTIALLY RESOLVED** — backend path uses no client key; legacy path still does (opt-in) |
| R8 | **P2** | **Untrusted device clock** (D9) | `capturedAt: new Date().toISOString()` is client time | `CameraScreen.tsx` | **RESOLVED** — server-stamped `server_received_at`; `client_captured_at` stored as claimed only |
| R9 | **P2** | **Silent data loss on failure** (A4) | On error, capture discarded — no durable queue, no retry | `CameraScreen.tsx:153-160` | **PARTIALLY RESOLVED** — mobile outbox module exists but not yet drained in background |
| R10 | **P2** | **No required-field validation** (D6) | Empty OCR text saves fine | `src/screens/ReviewScreen.tsx` | **RESOLVED** — evaluate() gate + required-field checks |
| R11 | **P2** | **Barcode unvalidated, no product identity** (D8) | `barcodeValue` stored raw, no GTIN/EAN checksum | `CameraScreen.tsx:150` | **RESOLVED** — GS1 parser + GTIN checksum validation |
| R12 | **P2** | **No persistence tier / APIs / multi-user** (A2) | Single-device AsyncStorage | `src/services/storage.ts` | **RESOLVED** — PostgreSQL backend with JWT auth |
| R13 | **P3** | **Crop geometry wrong on most devices** (D7) | Screen-px→photo-px mapping ignores cover-crop aspect mismatch | `CameraScreen.tsx:127-135` | **RESOLVED** — backend gets full image; no client-side crop |
| R14 | **P3** | **Non-portable export** (A6) | JSON/CSV embed device-local `photoUri` | `export.ts:36,47` | **PARTIALLY RESOLVED** — export still uses local URIs |
| R15 | **P3** | **No tests / CI** (A5) | Single initial commit, no test infra | repo | **PARTIALLY RESOLVED** — jest + ruff + pytest exist; coverage partial |
| R16 | **P3** | **Doc/version drift** (A7) | Expo version instructions and app manifest previously drifted | `AGENTS.md`, `package.json`, `app.json` | **RESOLVED** — all pin Expo SDK 54; versioned SDK 54 documentation is authoritative |

**Added beyond the audit (now all resolved):**

- **R17 (P2) — No idempotency on capture.** **RESOLVED** — Idempotency-Key + content-addressed raw store.
- **R18 (P3) — Barcode↔OCR region coupling is fragile.** **RESOLVED** — full image uploaded; server-side extraction.
- **R19 (P2) — No separation of "raw fact" vs "interpretation".** **RESOLVED** — raw_artifact (append-only) + extraction_run (new run on correction).

**Top-5 originally to fix first (drives Phase 0–2):** R1, R2/R3 (immutability+audit), R4, R5, R7 — **all now resolved or partially resolved**.

---

## 2. Proposed bounded contexts

Derived from a lightweight event-storming pass over the brief. Six contexts. The **core
domain** (where the business differentiates and complexity is real) is **Label Ingestion &
Extraction** and **HACCP Controls & Alerting**; the rest are supporting or generic.

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                    LabelScan platform                      │
                    │                                                            │
   capture/upload   │   ┌────────────────────┐ events  ┌────────────────────┐   │
  ┌────────────┐    │   │ (1) Label Ingestion│ ───────▶│ (3) Traceability   │   │
  │  Ingestion │───▶│   │   & Extraction     │         │     Registry       │   │
  │   Client   │    │   │   (CORE)           │ ──┐      │   (supporting)     │   │
  │ (mobile)   │    │   └─────────┬──────────┘   │      └─────────┬──────────┘   │
  └────────────┘    │             │ events       │ events         │ events       │
                    │             ▼              ▼                ▼              │
                    │   ┌────────────────────┐  ┌──────────────────────────┐    │
                    │   │ (2) Compliance &   │  │ (4) HACCP Controls &      │    │
                    │   │   Catalog          │◀─│     Alerting (CORE)       │    │
                    │   │   (supporting)     │  └────────────┬──────────────┘    │
                    │   └────────────────────┘               │ events           │
                    │                                         ▼                  │
                    │   ┌────────────────────┐    ┌──────────────────────────┐  │
                    │   │ (5) Audit & History│◀───│ (6) Identity & Access     │  │
                    │   │   (cross-cutting)  │    │     (generic)             │  │
                    │   └────────────────────┘    └──────────────────────────┘  │
                    └──────────────────────────────────────────────────────────┘
```

Context map relationships (DDD terms): **U** = upstream (publishes the contract), **D** =
downstream (conforms or translates), **ACL** = anti-corruption layer.

| From → To | Relationship | Notes |
|-----------|-------------|-------|
| Ingestion (U) → Traceability (D) | Published events + ACL | Traceability consumes `LabelExtractionCompleted`; translates extraction DTOs into its own model. |
| Ingestion (U) → HACCP (D) | Published events | HACCP reacts to extracted use-by date / storage temperature. |
| Compliance (U) → Ingestion (D) | Customer/Supplier (shared kernel-lite) | Compliance owns the **required-field rule set** & species reference; Ingestion validates against a *versioned snapshot* (no live coupling). |
| Ingestion (D) → OCR/LLM providers (external, U) | **ACL via ports** | Google Vision / future providers wrapped behind `OcrPort`, `LlmExtractorPort`. This is the headline replaceability seam. |
| HACCP (U) → Traceability (D) | Published events | Alerts reference batches/lots by ID. |
| All (U) → Audit (D) | Conformist (append-only sink) | Every context emits audit entries through a shared `AuditLogPort`. |
| Identity (U) → All (D) | Generic upstream | Provides actor identity for audit + authorization. |

### 2.1 Label Ingestion & Extraction (CORE)
**Responsibility:** Accept a capture (image + optional barcode + client metadata), store the
**raw** artifact immutably and before normalization, run OCR then LLM-based field extraction
behind ports, produce **structured seafood fields each with a confidence score and provenance**,
and never invent missing fields.
**Ubiquitous language:** Capture, Ingestion, RawArtifact, OcrResult, ExtractionRun,
ExtractedField, Confidence, Provenance, ExtractionStatus (`raw_stored` → `ocr_done` →
`extracted` → `needs_review` → `confirmed`).
**Why core:** This is where the product's unique value and most of the constraint risk live
(#1–#6). Gets the richest modeling.

### 2.2 Compliance & Catalog (supporting)
**Responsibility:** Own the **required-field rule set** for seafood labels (which fields are
mandatory, derived from the EU fishery-product info regime — referenced, not encoded), the
controlled vocabularies (species / scientific name list, FAO catch-area codes, gear types,
production methods wild/farmed), and GTIN/product-identity rules.
**Ubiquitous language:** RequiredFieldRuleSet (versioned), Species, ScientificName, FaoArea,
GearType, ProductionMethod, Gtin, ComplianceVerdict.
**Why supporting (mostly reference-data + a thin policy):** rules change rarely and are largely
table-driven; full DDD is overkill (see ADR-0006).

### 2.3 Traceability Registry (supporting)
**Responsibility:** The audit-ready, queryable record of products, batches/lots, suppliers, and
the chain linking a physical lot back to its source. Lookups by lot / product / supplier.
**Ubiquitous language:** Product, Batch (a.k.a. Lot), Supplier, ApprovalNumber (CE/health mark),
TraceabilityLink, ProvenanceChain.

### 2.4 HACCP Controls & Alerting (CORE)
**Responsibility:** Apply hygiene/traceability **controls** — expiry-date monitoring,
storage-temperature monitoring, required-field completeness — and raise **Alerts** with
severity and lifecycle.
**Ubiquitous language:** Control, ControlPlan, TemperatureLog, ExpiryWindow, Threshold (from a
versioned plan), Alert (open → acknowledged → resolved), Severity.
**Why core:** the HACCP logic is the regulated, differentiating behaviour; invariants and
lifecycle justify tactical DDD.

### 2.5 Audit & History (cross-cutting / supporting)
**Responsibility:** Single append-only, immutable record of every business-critical change
across contexts, carrying actor, action, before/after reference, `correlation_id`, `trace_id`,
trusted server timestamp.
**Ubiquitous language:** AuditEntry, Actor, Action, OccurredAt (server), CorrelationId, TraceId.

### 2.6 Identity & Access (generic)
**Responsibility:** Authenticate users/devices, supply actor identity to audit, authorize
actions. Generic — buy/adopt rather than build deeply; thin layered module.

---

## 3. Recommended target architecture

**Style:** **Modular monolith first** (single deployable, multiple internally-isolated
modules), **hexagonal (ports & adapters)** applied where domain rules need isolation — the
two core contexts and the ingestion seam — and **simpler layered modules** where they do not
(Compliance reference data, Identity). See ADR-0001, ADR-0002, ADR-0006.

**Why:** small team, boundaries still being discovered, strong consistency needs for
ingestion+audit. A modular monolith gives module boundaries (so a future service extraction is
cheap) without the operational tax of microservices. Reversible: if one context (e.g. HACCP
alerting) later needs independent scaling, its module — already behind ports and events — can be
extracted along an existing seam.

### 3.1 Where the immutable raw store and audit log live

- **Immutable raw ingestion store** lives **inside the Ingestion context**, written by the
  application layer the moment a capture arrives, **before** OCR/LLM run (constraint #3). Two
  parts: (a) the binary image in **object storage** (S3-compatible / filesystem in dev),
  referenced by a content-addressable key + checksum; (b) the **raw OCR/provider JSON**
  (bounding boxes, per-token confidence) in a PostgreSQL append-only table. Raw rows are never
  updated or deleted — enforced by DB grants + triggers (ADR-0003).
- **Audit log** is its own context (§2.5), a single append-only PostgreSQL table written
  through `AuditLogPort` by every context. Append-only table now; event-sourcing deferred
  (ADR-0004).

### 3.2 Historical proposed backend module layout

> The package is now implemented under `server/src/labelscan/`, with current app,
> contexts and platform boundaries shown in the security architecture document. The tree
> below is retained as the original design rationale, not as an operational source of truth.

```
server/
├─ pyproject.toml                  # FastAPI, Pydantic, SQLAlchemy/psycopg, alembic
├─ app/
│  ├─ main.py                      # FastAPI app assembly + DI wiring ONLY (composition root)
│  ├─ shared_kernel/               # framework-free cross-context primitives
│  │  ├─ ids.py                    # typed IDs (IngestionId, BatchId, ...)
│  │  ├─ confidence.py             # Confidence value object (0.0–1.0 + band)
│  │  ├─ correlation.py            # CorrelationId / TraceId value objects
│  │  └─ events.py                 # DomainEvent base, event metadata
│  │
│  ├─ contexts/
│  │  ├─ ingestion/                # CORE — hexagonal
│  │  │  ├─ domain/                # ◀── NO framework/DB/HTTP/provider imports
│  │  │  │  ├─ model/              # Ingestion aggregate, ExtractionRun, ExtractedField (VO)
│  │  │  │  ├─ events.py           # RawArtifactStored, LabelExtractionCompleted, ...
│  │  │  │  └─ ports/              # OcrPort, LlmExtractorPort, RawArtifactRepository,
│  │  │  │                        #   IngestionRepository, ObjectStore, Clock, AuditLogPort
│  │  │  ├─ application/           # use cases: SubmitCapture, RunExtraction, ConfirmExtraction
│  │  │  ├─ adapters/
│  │  │  │  ├─ inbound/http/       # FastAPI routers + Pydantic DTOs (transport only)
│  │  │  │  └─ outbound/
│  │  │  │     ├─ ocr_google_vision.py   # implements OcrPort  (ACL to Vision)
│  │  │  │     ├─ llm_extractor_*.py     # implements LlmExtractorPort (ACL to LLM)
│  │  │  │     ├─ repo_postgres.py       # implements repositories
│  │  │  │     └─ object_store_*.py      # S3 / local fs
│  │  │  └─ wiring.py             # binds ports→adapters for this context
│  │  │
│  │  ├─ haccp/                    # CORE — hexagonal (same shape)
│  │  ├─ traceability/             # supporting — layered + repositories
│  │  ├─ compliance/              # supporting — layered, reference-data heavy
│  │  ├─ audit/                    # cross-cutting — thin: AuditLogPort + append-only repo
│  │  └─ identity/                 # generic — layered
│  │
│  ├─ platform/                    # framework-bound infra shared by contexts
│  │  ├─ db.py                     # engine/session, NOT imported by any domain/
│  │  ├─ messaging.py              # in-process event bus (Phase 0–4), pluggable later
│  │  ├─ observability.py          # correlation/trace middleware, structured logging
│  │  └─ config.py                 # settings (env), secrets access
│  └─ migrations/                  # alembic
└─ tests/                          # unit (domain, no IO) + integration (adapters) + contract
```

Key points:
- Each context exposes **inbound ports** (use cases) and **outbound ports** (interfaces it
  needs). Adapters are the only things that touch FastAPI, SQLAlchemy, HTTP, Vision, or an LLM.
- Cross-context calls go through **published domain events on an in-process bus** (Phase 0–4),
  consumed via each context's ACL. The bus is a port; replacing it with a real broker later is
  an adapter swap (reversible). See §6.
- `app/main.py` is the **composition root**: the only place that knows concrete adapters.

### 3.3 Ports defined at Phase 0 (the replaceability seams)

| Port | Direction | Purpose | Default adapter |
|------|-----------|---------|-----------------|
| `OcrPort` | outbound | image → raw OCR result (text + tokens + per-token confidence + geometry) | Google Vision (ACL) |
| `LlmExtractorPort` | outbound | OCR result (+image ref) → structured fields, each with confidence & provenance; unknown ⇒ `null` | LLM provider (ACL) |
| `RawArtifactRepository` | outbound | append-only persist of raw image ref + raw provider JSON | Postgres + object store |
| `IngestionRepository` | outbound | load/save the Ingestion aggregate | Postgres |
| `ObjectStore` | outbound | store/fetch binary by content-addressed key | S3 / local fs |
| `Clock` | outbound | trusted server time (fixes R8) | system UTC clock |
| `AuditLogPort` | outbound | append immutable audit entries | Postgres append-only |
| `EventBus` | outbound | publish domain events | in-process bus |
| `SubmitCapture` / `RunExtraction` / `ConfirmExtraction` | inbound | ingestion use cases | called by HTTP adapter |

---

## 4. C4-style diagrams (text)

### L1 — System Context

```
        ┌──────────────┐                          ┌─────────────────────────┐
        │  Fishmonger  │  captures label photo     │  Quality / HACCP Manager│
        │  / Operator  │  + barcode                │  reviews alerts,        │
        │  (mobile)    │                           │  traceability lookups   │
        └──────┬───────┘                           └────────────┬────────────┘
               │ HTTPS (image, barcode, idempotency-key)        │ HTTPS
               ▼                                                 ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │                    LabelScan platform (this system)                │
        │  Ingests labels, extracts seafood fields w/ confidence, enforces   │
        │  HACCP controls, keeps an immutable audit-ready traceability record │
        └───────┬───────────────────────┬──────────────────────┬───────────┘
                │ image:annotate (HTTPS) │ extract (HTTPS)       │ authn
                ▼                        ▼                      ▼
        ┌───────────────┐      ┌──────────────────┐   ┌──────────────────┐
        │ OCR provider  │      │  LLM provider     │   │ Identity provider│
        │ (Google Vision│      │ (field extraction)│   │ (IdP / SSO)      │
        │  — replaceable)│     │  — replaceable    │   │  — generic       │
        └───────────────┘      └──────────────────┘   └──────────────────┘
```

### L2 — Containers

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                            LabelScan platform                                │
 │                                                                              │
 │  ┌────────────────────────┐         ┌──────────────────────────────────┐    │
 │  │ Mobile Ingestion Client │  HTTPS  │  Backend API (FastAPI)           │    │
 │  │ Expo / React Native     │────────▶│  modular monolith, single deploy │    │
 │  │ (capture, durable queue,│  REST   │  contexts: ingestion, haccp,     │    │
 │  │  no API keys)           │         │  traceability, compliance,       │    │
 │  └────────────────────────┘         │  audit, identity                 │    │
 │                                      └───┬───────────┬──────────┬───────┘    │
 │                                          │           │          │            │
 │                          ┌───────────────▼──┐  ┌─────▼──────┐  ┌▼──────────┐ │
 │                          │ PostgreSQL        │  │ Object     │  │ In-proc    ││
 │                          │ - raw_artifact*   │  │ store      │  │ event bus  ││
 │                          │ - ingestion       │  │ (images,   │  │ (port;     ││
 │                          │ - extraction_field│  │  content-  │  │  broker    ││
 │                          │ - batch/supplier  │  │  addressed)│  │  later)    ││
 │                          │ - alert           │  └────────────┘  └───────────┘│
 │                          │ - audit_log (append-only)                         │
 │                          │  * append-only, no UPDATE/DELETE grants           │
 │                          └───────────────────────────────────────────────────│
 └────────────────────────────────────────────────────────────────────────────┘
        (Phase 5 the existing Expo app becomes the Mobile Ingestion Client above)
```

### L3 — Components of the core Ingestion & Extraction context

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  contexts/ingestion                                                            │
 │                                                                                │
 │  INBOUND ADAPTER (FastAPI)                                                     │
 │  ┌──────────────────────────────┐                                             │
 │  │ HTTP Router + Pydantic DTOs   │  POST /ingestions  (image, barcode, key)    │
 │  │ + correlation/trace middleware│  POST /ingestions/{id}/extract              │
 │  └──────────────┬────────────────┘  POST /ingestions/{id}/confirm             │
 │                 │ calls inbound port (use case)                                │
 │                 ▼                                                              │
 │  APPLICATION (use cases — orchestration, transactions, no business rules leak) │
 │  ┌──────────────────────────────────────────────────────────────────────┐    │
 │  │ SubmitCapture ─▶ 1) Clock.now()  2) ObjectStore.put(image)            │    │
 │  │                  3) RawArtifactRepository.append(rawRef)  [BEFORE OCR] │    │
 │  │                  4) IngestionRepository.save(Ingestion=raw_stored)     │    │
 │  │                  5) AuditLogPort.append  6) EventBus.publish(RawStored) │    │
 │  │ RunExtraction ─▶ OcrPort.run ▶ RawArtifactRepository.append(ocrRaw)    │    │
 │  │                  ▶ LlmExtractorPort.extract ▶ build ExtractedFields    │    │
 │  │                  ▶ Ingestion.applyExtraction(...) ▶ save ▶ publish     │    │
 │  │ ConfirmExtraction ─▶ validate required fields ▶ confirm ▶ audit ▶ event│    │
 │  └───────┬───────────────────────────────────┬───────────────┬──────────┘    │
 │          │ uses outbound ports (interfaces)   │               │               │
 │          ▼                                    ▼               ▼               │
 │  DOMAIN (framework-free)              OUTBOUND PORTS    OUTBOUND ADAPTERS      │
 │  ┌────────────────────────┐          ┌─────────────┐   ┌────────────────────┐ │
 │  │ Ingestion (agg root)   │          │ OcrPort     │◀──│ GoogleVisionOcr(ACL)│ │
 │  │  - status invariants   │          │ LlmExtractor│◀──│ LlmExtractor (ACL)  │ │
 │  │  - holds ExtractionRun  │          │ RawArtifact │◀──│ PostgresRawRepo     │ │
 │  │ ExtractedField (VO):    │          │  Repository │   │  (append-only)      │ │
 │  │  value? + Confidence +  │          │ Ingestion   │◀──│ PostgresIngestRepo  │ │
 │  │  Provenance + sourceRef │          │  Repository │   │ S3/LocalObjectStore │ │
 │  │ Confidence (VO 0..1)    │          │ ObjectStore │   │ SystemClock         │ │
 │  │ DomainEvents            │          │ Clock,Audit │   │ PostgresAuditLog    │ │
 │  └────────────────────────┘          │ EventBus    │   │ InProcessEventBus   │ │
 │                                       └─────────────┘   └────────────────────┘ │
 │  Dependency direction: adapters ─▶ application ─▶ domain.  domain depends on    │
 │  NOTHING outward (ports are interfaces defined inside domain).                  │
 └──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Dependency rules

### 5.1 The dependency-direction law

> **Dependencies point inward. The domain is the center and depends on nothing.**
> `adapters → application → domain`. Never the reverse. `shared_kernel` is innermost and may be
> imported by anyone but imports nothing framework-bound.

### 5.2 Import allow-list

| Layer / package | MAY import | MUST NOT import |
|-----------------|-----------|------------------|
| `contexts/*/domain/**` | `shared_kernel`, stdlib, pure libs | FastAPI, Pydantic*, SQLAlchemy, `psycopg`, `requests`/`httpx`, Google Vision SDK, any LLM SDK, `platform/**`, other contexts' internals |
| `contexts/*/application/**` | own `domain`, own `domain/ports`, `shared_kernel` | concrete adapters, FastAPI, DB drivers, provider SDKs |
| `contexts/*/adapters/**` | own `application`, own `domain` (to implement ports), `platform/**`, frameworks/SDKs | another context's `domain`/`application` (cross-context only via events/published contracts) |
| `platform/**` | frameworks, drivers, stdlib | any `contexts/*/domain` |
| `shared_kernel/**` | stdlib only | everything framework-bound |
| `app/main.py` (composition root) | everything (it wires) | — |

\* Pydantic is allowed **only** in adapters/DTOs at the boundary, never in `domain/`. The domain
uses plain Python dataclasses / value objects so it stays framework-free (constraint #5). This
is a deliberate trade-off: a little mapping code at the edge buys provider/framework
independence.

### 5.3 Cross-context rule
A context never imports another context's `domain`/`application`. Integration is via **published
domain events** through `EventBus`, consumed behind an **ACL** that maps the event payload into
the consumer's own model. Calling another context's repository directly is an architectural
smell (must be an ADR'd exception). Bypassing use cases by calling repositories from HTTP
routers is likewise a smell.

### 5.4 Enforcement (suggested, lightweight, reversible)
- **`import-linter`** contracts in CI encoding §5.2 as layered/forbidden contracts
  (e.g. `domain` is an independent leaf forbidden from importing `platform`, frameworks, SDKs).
  Cheap, declarative, fails the build on violation.
- **`ruff`** banned-imports rule per package (e.g. forbid `fastapi`, `sqlalchemy`, `httpx` under
  `**/domain/**`).
- **Architecture test** (pytest) that walks the AST of `domain/` and asserts no forbidden module
  is imported — a safety net independent of config drift.
- **CODEOWNERS** per context to keep boundary changes intentional.
- Trade-off: these add CI friction; the alternative (convention only) reliably erodes. For a
  compliance system the friction is worth it, and any rule is one config line to relax
  (reversible).

---

## 6. Domain events

Conventions: every event carries envelope metadata `{event_id, occurred_at (server/Clock),
correlation_id, trace_id, actor, schema_version}`. "Crosses boundary?" = consumed by a context
other than the producer (i.e. it is a published contract, versioned).

| Event | Trigger | Payload (beyond envelope) | Producer → Consumer(s) | Crosses? |
|-------|---------|---------------------------|------------------------|----------|
| `CaptureSubmitted` | `SubmitCapture` accepted | `ingestion_id, image_ref, checksum, barcode_raw?, client_meta, idempotency_key` | Ingestion → Ingestion | No |
| `RawArtifactStored` | raw image ref + (later) raw OCR JSON appended **before** normalization | `ingestion_id, artifact_kind(image|ocr_json), storage_ref, checksum` | Ingestion → Audit | Yes (audit) |
| `OcrCompleted` | `OcrPort` returns | `ingestion_id, ocr_raw_ref, token_count, mean_token_confidence` | Ingestion → Ingestion | No |
| `LabelExtractionCompleted` | LLM extraction produced structured fields | `ingestion_id, fields:[{name,value?,confidence,provenance,source_ref}], extractor_version, overall_status` | Ingestion → Traceability, HACCP, Audit | **Yes** |
| `ExtractionFlaggedForReview` | any required field `null` or confidence < threshold | `ingestion_id, low_confidence_fields[], missing_required_fields[]` | Ingestion → HACCP/UI, Audit | Yes |
| `ExtractionConfirmed` | human confirms in review | `ingestion_id, confirmed_by, overrides:[{field,old,new}]` | Ingestion → Traceability, Audit | Yes |
| `BatchRegistered` | extraction confirmed yields a new lot | `batch_id, gtin?, lot_code, supplier_id?, species, fao_area?, use_by?, source_ingestion_id` | Traceability → HACCP, Audit | Yes |
| `TemperatureLogged` | storage temperature reading recorded | `batch_id?, location, temp_c, measured_at, source` | HACCP → HACCP, Audit | Yes (audit) |
| `ExpiryThresholdBreached` | use-by within/over plan window | `batch_id, use_by, breached_window` | HACCP → Alerting/UI, Audit | Yes |
| `TemperatureThresholdBreached` | temp outside plan threshold | `batch_id?, location, temp_c, threshold` | HACCP → Alerting/UI, Audit | Yes |
| `AlertRaised` / `AlertAcknowledged` / `AlertResolved` | alert lifecycle transitions | `alert_id, batch_id?, severity, state, actor` | HACCP → Audit, UI | Yes |
| `AuditEntryAppended` | any context writes audit | `entry_id, action, subject_ref, before_ref?, after_ref?` | Audit → (sink) | No (terminal) |

Notes:
- **No event mutates another context's data directly** — consumers react and update their own
  model (eventual consistency across contexts; strong consistency within an aggregate). Trade-off
  in ADR-0001.
- Events are the same whether the bus is in-process (now) or a broker (later) — the migration is
  an adapter swap, keeping the decision reversible.

---

## 7. Aggregate boundaries

Principles applied: an aggregate is the **transactional consistency boundary**; reference other
aggregates **by ID**, embed only what the root's invariants must protect; keep aggregates small.

### 7.1 `Ingestion` (root) — context: Ingestion & Extraction
- **Invariants:**
  - Raw artifact reference must exist before status can advance past `raw_stored` (enforces
    constraint #3).
  - Status transitions are monotonic: `raw_stored → ocr_done → extracted → (needs_review) →
    confirmed`; no backward edits to confirmed extraction values (immutability of the confirmed
    fact; corrections create a new `ExtractionRun`, not an overwrite — addresses R19).
  - Every `ExtractedField` with a non-null value **must** carry a `Confidence` and `Provenance`
    (constraint #2). Missing field ⇒ value `null`, never fabricated (constraint #1).
- **Embedded (within the boundary):** current `ExtractionRun` and its `ExtractedField` value
  objects; `Confidence`, `Provenance` value objects. These change together and have no identity
  of their own.
- **Referenced by ID:** raw image (object-store key), raw OCR JSON (raw_artifact id), resulting
  `Batch` (batch_id), actor (from Identity). The big binary and the immutable raw rows are
  **outside** the aggregate, referenced — keeps the aggregate small and the raw store append-only
  independently.
- **Transactional boundary:** one DB transaction per use case mutating one `Ingestion`. The
  *append* of a raw artifact is its own append-only write (never updated), committed before
  extraction.

### 7.2 `RawArtifact` (root, append-only) — context: Ingestion & Extraction
- **Invariants:** write-once; never updated or deleted (DB grants + trigger, ADR-0003); checksum
  matches stored bytes; carries `correlation_id`/`trace_id` and server `occurred_at`.
- **Referenced by ID** from `Ingestion`. Deliberately a separate aggregate so immutability is
  enforced at the storage level independent of the mutable `Ingestion` lifecycle.

### 7.3 `Batch` / `Lot` (root) — context: Traceability Registry
- **Invariants:** must reference a `Supplier` by ID (or be explicitly `unknown_supplier`); GTIN,
  if present, passes checksum (fixes R11); `lot_code` unique per supplier+product; links back to
  `source_ingestion_id` for provenance.
- **Referenced by ID:** `Supplier`, `Product`, `source_ingestion_id`.
- **Transactional boundary:** one `Batch` per transaction.

### 7.4 `Supplier` (root) — context: Traceability Registry
- **Invariants:** approval/health-mark number, if present, well-formed; identity stable.
- Referenced by ID from `Batch`.

### 7.5 `ControlPlan` (root) — context: HACCP
- **Invariants:** versioned; thresholds (temperature ranges, expiry windows) immutable once a
  version is active (audit reproducibility — an alert must be explainable by the plan version in
  force at the time).

### 7.6 `Alert` (root) — context: HACCP
- **Invariants:** references a `Batch` by ID (and the `ControlPlan` version that triggered it);
  lifecycle `open → acknowledged → resolved` is monotonic; severity set at creation; every
  transition produces an audit entry.
- **Referenced by ID:** `Batch`, `ControlPlan` version.

### 7.7 `AuditEntry` (root, append-only) — context: Audit & History
- **Invariants:** write-once immutable; mandatory `actor`, `action`, `occurred_at` (server
  Clock), `correlation_id`, `trace_id`; `before_ref`/`after_ref` point to immutable snapshots,
  not live rows.
- Its own transactional unit; one append per business change.

`TemperatureLog` is modeled as an **append-only entity/record** within the HACCP context
(immutable readings) rather than a full aggregate root — it has no lifecycle of its own; it is a
stream of facts referenced by `Batch`/location.

---

## 8. Architecture Decision Records (summary)

Full ADRs in [`adr/`](../architecture/adr/). Each uses the template: Status / Context / Decision /
Consequences / Alternatives considered / Trade-offs / Reversibility.

| ADR | Decision | One-line rationale |
|-----|----------|--------------------|
| [0001](../architecture/adr/0001-modular-monolith-vs-microservices.md) | **Modular monolith first**, not microservices | Boundaries still emerging + strong consistency for ingestion/audit; keep ops cost low, extract along seams later. |
| [0002](../architecture/adr/0002-hexagonal-ports-adapters-ocr-llm.md) | **Hexagonal ports & adapters** for OCR/LLM (and persistence) | Constraint #6: providers must be replaceable; isolate the domain from Vision/LLM SDKs (ACL at the edge). |
| [0003](../architecture/adr/0003-raw-before-normalized-immutable-store.md) | **Raw-before-normalized immutable ingestion store** | Constraint #3 + #4: capture the literal label fact append-only before any interpretation; recoverable/reprocessable. |
| [0004](../architecture/adr/0004-immutable-audit-append-only-vs-event-sourcing.md) | **Append-only audit table now**, event-sourcing deferred | Meets auditability/immutability (#4) with far less complexity; ES is reversible-forward if needed. |
| [0005](../architecture/adr/0005-confidence-scores-in-the-model.md) | **Confidence + provenance live on each `ExtractedField` value object** | Constraint #2: confidence is intrinsic to a field, not a side table; unknown ⇒ `null`, no fabrication (#1). |
| [0006](../architecture/adr/0006-ddd-tactical-vs-layered-per-context.md) | **Tactical DDD only in core contexts**, layered elsewhere | Avoid architecture astronautics; rich modeling where invariants are real (Ingestion, HACCP), CRUD/layered for reference data + identity. |
| [0007](../architecture/adr/0007-python-fastapi-backend.md) | **Python / FastAPI + Pydantic at boundaries, PostgreSQL** | Decided with user; strong OCR/LLM ecosystem; accepted trade-off: no type-sharing with the TS mobile app. |

---

## 9. Migration strategy (phased, strangler-style, no big-bang)

Mapped to the user's phases 0–5. Each phase is independently shippable and individually
reversible. The existing Expo app keeps working throughout; it is *strangled* into a thin client
only at the end. "Reversibility" notes the rollback for each step.

### Phase 0 — Foundations (no behaviour change for users)
- **Add** `server/` modular monolith skeleton, PostgreSQL, framework-free `domain/` packages,
  ports (`OcrPort`, `LlmExtractorPort`, `RawArtifactRepository`, `IngestionRepository`,
  `ObjectStore`, `Clock`, `AuditLogPort`, `EventBus`), `import-linter` + architecture tests in
  CI. No endpoints serving users yet.
- **Stays:** the mobile app (unchanged, still local-only).
- **Reversibility:** pure addition; deleting `server/` returns to today. Fixes none yet but
  unblocks everything.

### Phase 1 — Immutable ingestion (server-side raw store) — addresses R1, R2, R3, R7, R8, R17
- **Add** `POST /ingestions`: stores the **full** image to object store + raw record append-only,
  server-stamped time (`Clock`), `correlation_id`/`trace_id`, idempotency key; writes an audit
  entry; raw stored **before** any OCR. DB grants/triggers make raw + audit append-only.
- **Strangler step:** mobile app gains a *secondary* path — after a successful local save it also
  POSTs the capture to `/ingestions` (dual-write, behind a feature flag). Local flow still works.
- **Changes:** add a backend; mobile gets an upload call. **Retires:** nothing yet.
- **Reversibility:** feature flag off ⇒ app reverts to local-only; backend idle. Raw store is
  additive.

### Phase 2 — Structured extraction with confidence — addresses R4, R5, R6, R13, R19
- **Add** `POST /ingestions/{id}/extract`: `OcrPort` → append raw OCR JSON → `LlmExtractorPort`
  → `ExtractedField`s with confidence + provenance; unknown ⇒ `null`. Vision wrapped behind the
  port (ACL); the bundled client key (R7) is now fully unnecessary server-paths. Crop is no
  longer load-bearing (server gets the full image), de-risking R13.
- **Changes:** OCR moves server-side behind a port; review can show per-field confidence.
- **Reversibility:** extractor is a port — swap back to "text only" by returning a single field;
  re-extraction creates a new `ExtractionRun`, never overwriting raw (safe to re-run).

### Phase 3 — Domain model & validation — addresses R6, R10, R11
- **Add** Traceability (`Product`, `Batch/Lot`, `Supplier`) + Compliance rule set + GTIN
  checksum + required-field validation at the boundary; `ExtractionConfirmed` → `BatchRegistered`.
- **Changes:** confirmed ingestions now produce real traceability records.
- **Reversibility:** new contexts are additive; validation can run in warn-only mode first.

### Phase 4 — Traceability & HACCP alerting APIs — addresses R12 fully
- **Add** lookup-by lot/product/supplier APIs; HACCP `ControlPlan`, expiry + temperature
  monitoring, `Alert` lifecycle; alerting events.
- **Reversibility:** read APIs are side-effect-free; alerting can be enabled per control.

### Phase 5 — Mobile app → thin ingestion client — addresses R7 fully, R9, R14
- **Change:** the Expo app stops writing to AsyncStorage as the source of truth; it captures →
  enqueues to a **durable offline queue** → POSTs to `/ingestions` (with idempotency). Drops the
  bundled Vision key entirely (R7). History/list/export now read from backend APIs (portable
  export replaces R14's device-local `photoUri`).
- **Retires:** `src/services/ocr.ts` (client OCR), `src/services/storage.ts` as system of record,
  device-local export of `photoUri`. The capture UI (`CameraScreen`, `ReviewScreen`, overlays)
  is **kept** and repurposed.
- **Reversibility:** keep AsyncStorage as a local cache/outbox so a backend outage degrades to
  offline-queued capture rather than data loss (also finally fixes R9).

### What stays / changes / retires (summary)

| Item | Phase | Fate |
|------|-------|------|
| Expo capture UI (camera, review, overlays) | 5 | **Stays** (repurposed as thin client) |
| `src/services/ocr.ts` (client Vision call + key) | 2/5 | **Retires** (moves server-side behind `OcrPort`) |
| `src/services/storage.ts` (AsyncStorage as system of record) | 5 | **Changes** to local cache/outbox only |
| `src/services/export.ts` (device-local export) | 5 | **Changes** to backend-driven portable export |
| Fixed-band crop geometry (`CameraScreen` R13) | 2 | **Retires** as load-bearing (server gets full image) |
| `Article` opaque type | 3 | **Superseded** by structured domain model |
| `server/` backend, raw store, audit log, ports | 0–4 | **New** |

---

## Appendix A — constraint → where-addressed traceability

| Constraint | Addressed by |
|-----------|--------------|
| #1 no hallucination / no invented fields | §2.1, §7.1 invariants, ADR-0005 (unknown ⇒ `null`) |
| #2 confidence per field | §7.1, ADR-0005, event `LabelExtractionCompleted` |
| #3 raw before normalization | §3.1, §7.2, ADR-0003, Phase 1 |
| #4 auditable + immutable history | §2.5, §7.7, ADR-0003/0004 |
| #5 framework-free domain | §3.2, §5, ADR-0002/0006 |
| #6 replaceable OCR/LLM | §3.3 ports, ADR-0002 |
| #7 reversible, trade-offs named | every ADR's Trade-offs + Reversibility sections |
| #8 correlation_id / trace_id everywhere | §6 envelope, §7.7, `platform/observability.py` |
</content>
</invoke>
