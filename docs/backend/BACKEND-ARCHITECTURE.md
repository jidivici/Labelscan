# LabelScan — Backend Architecture

> **Audience:** backend / platform engineers and integrators.
> **Scope:** the Python/FastAPI backend (`server/`) — runtime topology, module
> architecture, request & extraction flows, data model, security, observability,
> invariants, and the operational runbook.
> **Status:** reflects the code as of 2026-08-04 (multi-trade portals, rotating
> sessions, role-specific IAM, hybrid GS1+LLM extraction, DLQ+backoff, structured
> logging). For the *gap/risk* view see
> `AUDIT-TECHNIQUE-COMPLET.md`; this document is the *reference* architecture.
>
> Companion files: [`API-CONTRACTS.md`](./API-CONTRACTS.md) (OpenAPI fragments + the full
> error-code catalog) and [`openapi.v1.yaml`](./openapi.v1.yaml) (machine-readable skeleton —
> paths + components only, not an implementation). Keep all three in sync.

A note on regulatory scope (unchanged from ARCHITECTURE.md §0): each profession
profile owns its versioned field rules. The seafood profile draws its required
fields from the EU consumer-information regime for fishery and aquaculture
products. This document encodes **no** article numbers, thresholds, or legal
text; those live in the Compliance context's versioned
**RequiredFieldRuleSet**, never hard-coded.

---

## Table of contents

1. [What this system is](#1-what-this-system-is)
2. [Runtime topology](#2-runtime-topology--three-processes-all-required)
3. [Module architecture](#3-module-architecture-modular-monolith--hexagonal)
4. [Flow A — Ingestion (synchronous, returns 202)](#4-flow-a--ingestion-synchronous-returns-202)
5. [Flow B — Extraction (asynchronous, in the worker)](#5-flow-b--extraction-asynchronous-in-the-worker)
6. [Flow C — Read / polling, and Auth](#6-flow-c--read--polling-and-auth)
7. [Data model & integrity](#7-data-model--integrity)
8. [API endpoint list](#8-api-endpoint-list)
9. [Standard error response format](#9-standard-error-response-format)
10. [Authentication and authorization strategy](#10-authentication-and-authorization-strategy)
11. [Idempotency strategy](#11-idempotency-strategy)
12. [Validation strategy](#12-validation-strategy)
13. [Timeout and retry strategy](#13-timeout-and-retry-strategy)
14. [Observability plan](#14-observability-plan)
15. [Migration strategy](#15-migration-strategy)
16. [Security risks and mitigations](#16-security-risks-and-mitigations)
17. [Known gaps / roadmap](#17-known-gaps--roadmap)
18. [Trade-offs (consolidated)](#18-trade-offs-consolidated)

---

## 1. What this system is

LabelScan ingests photos of fresh-food product labels for poissonnerie,
boucherie, and charcuterie–traiteur and turns them into **audited, immutable
HACCP traceability records**. The three design obsessions, in order:

1. **No data loss** on ingestion (raw-before-ack + transactional outbox).
2. **No fabrication / zero hallucination** on critical fields (barcode-exact GS1
   data wins; the LLM is grounded in OCR text; everything is human-reviewable).
3. **Tamper-evidence** (append-only tables + same-transaction audit, enforced by
   the database, not by trusting application code).

It is a **modular monolith** with a **hexagonal core** (framework-free domain),
split into two runnable processes over one PostgreSQL database.

---

## 2. Runtime topology — THREE processes (all required)

```
                 Authorization: Bearer <JWT>
   ┌─────────────┐   HTTPS    ┌──────────────────────────┐
   │ Mobile app  │ ─────────▶ │  API server (FastAPI)    │   create_app() / uvicorn
   │ (Expo/RN)   │ ◀───────── │  POST /v1/ingestions →202│   entrypoint: alembic upgrade
   └─────────────┘   poll     │  GET  /v1/ingestions/{id}│              + uvicorn --factory
        │ GET status          │  POST /v1/auth/login     │
        ▼ (until terminal)    └───────────┬──────────────┘
                                          │ writes: raw artifact + ingestion row
                                          │ + outbox row  (ONE transaction)
                                          ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │                          PostgreSQL 16                                  │
   │  ingestion.* · traceability.* · haccp.* · audit.* · identity.* ·        │
   │  platform.outbox / processed_event / idempotency_key                   │
   └───────────────▲───────────────────────────────────────────────────────┘
                   │ claim (FOR UPDATE SKIP LOCKED) → process → mark published
                   │
   ┌───────────────┴──────────┐  external (behind ports)  ┌──────────────────┐
   │  Outbox WORKER (relay)    │ ────────────────────────▶ │ Google Vision OCR │
   │  python -m labelscan.app  │ ────────────────────────▶ │ Anthropic Claude  │
   │       .worker_runtime     │                           └──────────────────┘
   │  ExtractionConsumer +      │  reads/writes object store ┌──────────────────┐
   │  Registration/Alerting     │ ─────────────────────────▶│ Filesystem raw    │
   └────────────────────────────┘                           │ store (images/…)  │
                                                             └──────────────────┘
```

| Process | Module | Responsibility | If it is down… |
|---|---|---|---|
| **API server** | `app.http_app:create_app` (uvicorn `--factory`) | Auth, validation, **store-raw-and-enqueue**, read models. **Never calls OCR/LLM.** | No ingest/read; mobile can't submit. |
| **Outbox worker** | `app.worker_runtime` (`poll_forever`) | The **only** consumer of `platform.outbox`. Runs OCR→LLM→gate→reconcile→persist, then traceability + alerting. | ⚠️ **Ingestions stay `raw_stored` forever; the mobile polls until a 30 s timeout** — the exact "processing… then nothing" symptom. **The worker MUST run.** |
| **PostgreSQL 16** | — | Source of truth + integrity enforcement (triggers, append-only, audit). | Total outage. |

> **Operational rule #1:** `db`, `server`, **and `worker`** must all be up.
> `docker compose up -d` starts all three; starting only `db server` silently
> disables extraction (see §15 runbook).

---

## 3. Module architecture (modular monolith + hexagonal)

```
server/src/labelscan/
├── contexts/                 # bounded contexts — independent, integrate via events/IDs
│   ├── ingestion/            #   capture + extraction (the core)
│   │   ├── domain/           #     PURE: gate (evaluate), gs1 parser, reconciliation, dataclasses
│   │   ├── application/      #     use cases + ports (Protocols)
│   │   └── adapters/         #     http routers, SQL repo, Google Vision, Claude, extraction consumer
│   ├── traceability/         #   product/supplier/batch chain + store arrivals
│   ├── haccp/                #   control plans + alerts lifecycle
│   ├── identity/             #   auth + org/store/portal access, roles, sessions and IAM APIs
│   ├── compliance/ · audit/  #   (thin / placeholder)
├── platform/                 # framework/infra, no business logic
│   ├── db/ (engine, audit_context)  http/ (security=JWT gate, errors, middleware, jwt codec, deps)
│   ├── outbox/ (worker, message, backoff)    observability.py (structured JSON logging)
└── app/                      # composition root: http_app, worker_runtime, *_wiring
```

**Dependency law (enforced in CI by `import-linter` / G-ARCH, 5 contracts, 0 broken):**
- per context: `adapters → application → domain` (deps point inward);
- bounded contexts **never import each other** (only events/IDs);
- **domain imports nothing** framework/DB/provider/`platform`/`app`;
- **`ingestion` cannot import `platform.outbox`** — a producer can never call the
  worker directly (the decoupling is mechanical, not conventional);
- application layer uses its own domain + ports only.

This is the project's structural differentiator: the architecture **stays**
hexagonal because the build fails otherwise.

---

## 4. Flow A — Ingestion (synchronous, returns 202)

```
mobile ──POST /v1/ingestions (image, barcode_raw, Idempotency-Key, Bearer)──▶ server
  router (adapters/http/router.py): require_scope("ingestion:write") → Principal (from JWT claim)
    validate: Idempotency-Key present? media ∈ {jpeg,png,webp,heic}? ≤10MB? non-empty?
  SubmitIngestion use case (application):
    1. raw-before-ack: write image bytes to the object store (fsync + atomic rename), content-addressed
    2. ONE DB transaction (audit context set first):
         INSERT ingestion.ingestion(status='raw_stored', barcode_raw, image_ref, checksum, corr, trace)
         INSERT platform.outbox(event_type='ingestion.raw_stored', payload={ingestion_id}, corr, trace)
    3. COMMIT → return 202 Accepted {ingestion_id, status:'raw_stored', replayed}
```

**Guarantees:** the 202 is returned **only after commit**, and the business row +
its outbox row are written **atomically** — so an accepted capture is never lost,
and is guaranteed to be picked up by the worker. **Idempotency** is two-layered:
the HTTP `Idempotency-Key` header (required) and a content-addressed key
`sha256(principal:route:content)` with `INSERT … ON CONFLICT DO NOTHING`.

---

## 5. Flow B — Extraction (asynchronous, in the worker)

The worker claims one unpublished outbox row per transaction with
`FOR UPDATE SKIP LOCKED` (safe for multiple workers), runs the registered
consumer, then records `processed_event` + marks the row published — **all in one
transaction**, so a crash before commit rolls back and the row is retried (no loss,
no partial side-effect; consumers are idempotent on `(consumer, event_id)`).

**Dead-letter queue with exponential backoff** (implemented — migration 0009):
failed events are retried with equal-jitter exponential backoff up to a configurable
`LABELSCAN_OUTBOX_MAX_RETRIES` (default 3). Exhausted events move to `status='dead_letter'`
with `last_error` captured, alertable and replayable via `requeueDeadLetter()`.

```
event ingestion.raw_stored ──▶ ExtractionConsumer (adapters/extraction_consumer.py)
  1. load image + ingestion.barcode_raw + image artifact id
  2. parse_gs1(barcode_raw)                 # DETERMINISTIC, exact — domain/gs1.py
  3. OCR  (Google Vision, port)  ── deduped by stored raw_artifact(ocr_json)
  4. LLM  (Claude Haiku 4.5, port)   ── deduped by stored raw_artifact(llm_output)
            prompt is focused on free-text fields when GS1 already has lot/DLC/…
  5. evaluate(...)               # PURE gate: no fabrication (evidence must be verbatim
                                #   in OCR text), required/low-confidence/inconsistency checks
  6. reconcile(gate_fields, gs1) # GS1 (confidence 1.0) OVERWRITES the LLM on lot/DLC/weight/GTIN;
                                #   any barcode↔print conflict is recorded as a warning
  7. adjusted_outcome(...)       # Option Y: GS1-satisfied required fields no longer force review,
                                #   BUT a lot/DLC conflict DOES force needs_review
  8. persist: extraction_run (append-only) + extracted_field rows (source 'llm'|'gs1')
             + UPDATE ingestion.status  + enqueue 'extraction.completed'   (worker tx)
        │
        ▼ event-chaining (same outbox, same guarantees)
  extraction.completed ──▶ RegistrationConsumer (traceability): builds product/supplier/batch chain
  batch.registered/flagged ──▶ AlertingConsumer (haccp): raises alerts
```

**Terminal states** the mobile waits for: `extracted`, `needs_review`
(review-ready) or `extraction_failed` (terminal failure after the bounded provider
retry, `max_provider_attempts=3`). External providers are **never called twice** for
the same ingestion (the stored OCR/LLM artifacts are the dedup guard on retry).

### Hybrid extraction = "zero hallucination" on critical fields

- **GS1 is parsed from the NATIVE-scanned barcode** (`ingestion.barcode_raw`, not
  OCR) → mathematically exact → confidence `1.0` → it **wins** on `batch_number`
  (AI 10), `expiry_date` (AI 17, DLC; AI 15 DDM as warned fallback), `weight`
  (AI 310x), `gtin` (AI 01), `packaging_date` (AI 13). GS1 fields **bypass** the
  OCR-grounding gate (they're grounded in the symbology). Stored with
  `source='gs1'` on the `extracted_field` row (migration 0008).
- The **LLM only handles free text** (species, designation, origin…) and stays
  fully subject to the unchanged non-fabrication gate.
- A **barcode↔print mismatch** on lot/DLC stores the exact GS1 value **and** forces
  `needs_review` so a human sees the labelling-integrity anomaly.

### Default LLM model: `claude-haiku-4-5`

The default adapter behind `LlmExtractorPort` is **Claude Haiku 4.5** (`claude-haiku-4-5`),
configurable via `LABELSCAN_LLM_MODEL`. This is a cost/speed optimization enabled by the
hybrid GS1+LLM architecture: GS1 handles the critical exact fields (lot, DLC, weight, GTIN)
with confidence 1.0, so the LLM only needs to extract free-text fields where Haiku's
capability is sufficient. Escalation to a more capable model (Sonnet, Opus) is a
configuration change behind the port.

---

## 6. Flow C — Read / polling, and Auth

**Read:** `GET /v1/ingestions/{id}` (scope `ingestion:read`) returns the ingestion
status + all extraction runs (append-only; latest flagged `is_latest`) + fields
(value/confidence/validation_status/provenance) + audit metadata.
`GET /v1/extraction-runs/{id}` returns one run with its fields. The mobile polls
the ingestion until a terminal status or a bounded 30 s / 20-attempt budget.

**Auth (identity context):** browser login is
`POST /v1/o/{organization_slug}/auth/login` (`/v1/auth/login` remains the default
organization alias). It accepts only `super_admin`, `admin`, and `manager`.
`POST /v1/mobile/auth/login` accepts only an active `manager` assigned to
exactly one active portal and store. Both issue a short-lived
**HS256 JWT** carrying the actor, organization, scopes, role, store ids, portal
ids, primary portal, trade code, client type, and server session family id.
Every scoped endpoint depends on `require_scope(scope)` →
`resolve_principal(request)`, which verifies signature, expiry, session, and
claims. The legacy identity-header seam is off by default. The audit actor is
taken from the signed claim and re-authorized against persisted IAM state for
privileged administration.

Refresh sessions are opaque and rotating. Browser refresh is cookie-based;
mobile refresh is an explicit token for secure device storage. The persisted
`client_type` prevents a browser refresh from being used on the mobile route or
vice versa. Role, portal, password, credential-reset, account, and portal-active
changes revoke affected sessions.

The role-specific IAM API replaces all generic user reads and mutations: a
super-admin manages admins and retains every admin power; an admin manages its
stores, professions, managers and store portals. Managers have no
identity-administration capability.
Accounts are created active with a direct password. Users change their own password
only after supplying the current password. Runtime deletion is always a reversible
soft state transition.

`GET /v1/arrivals` belongs to the traceability context. It projects immutable
registered batches into a searchable arrivals feed. Super-admin is
organization-wide; admins are restricted to portals of stores they own and
managers to their active portal and derived store. Organization, store, portal,
profession/profile version, and capture actor are snapshotted on ingestion and
copied into the immutable traceability chain, preserving historical ownership
across later reassignment.
The future evolution is RS256/JWKS + OIDC; `require_scope()` keeps that swap
isolated from business routes.

---

## 7. Data model & integrity

- **7 schemas** (`ingestion, traceability, haccp, audit, identity, compliance,
  platform`); least-privilege runtime role `labelscan_app`.
- **Append-only + immutability:** `platform.deny_mutation()` (RAISE on
  UPDATE/DELETE/TRUNCATE) on the append-only tables (`audit_log`, `raw_artifact`,
  `temperature_log`, `extraction_run`, `extracted_field`, …), RANGE-partitioned by
  month.
- **Unbypassable audit:** an `AFTER INSERT` SECURITY-DEFINER trigger writes exactly
  one `audit.audit_log` row in the **same transaction**, reading the actor/action/
  correlation/trace from transaction-local settings; it **RAISEs if the context is
  missing** → you cannot write a business row without recording who did it and why.
- **Storage invariants on `extracted_field`:** `ck_evidence_iff_value` (evidence iff
  value) and `ck_value_requires_provenance` (a non-null value cites its source) —
  honoured by construction by the reconciliation layer for both LLM and GS1 fields.
- **`extracted_field.source`** ∈ `{llm, gs1, human}` — `gs1` added by migration 0008
  for GS1-reconciled fields (confidence 1.0, bypass evidence gate).
- **`extracted_field.field_name`** includes `gtin` (migration 0008) — set by GS1
  parser from AI 01, not by the LLM.
- **Migrations:** Alembic `0001 → 0026`, with guarded downgrade behavior (CI runs
  migration proofs).
  - `0007` adds `identity.app_user` (credential store for JWT auth);
  - `0008` extends `extracted_field` CHECKs (`source += 'gs1'`, `field_name += 'gtin'`);
  - `0009` adds DLQ + exponential backoff to `platform.outbox` (`attempts`, `next_retry_at`,
    `last_error`, `status` columns).
  - `0014` adds identity RBAC metadata and audited user administration;
  - `0015` historically reduced the role model to `admin` and `operator`;
  - `0016` historically added the audited store directory and mandatory
    operator-to-store association. That value remains readable for migration
    compatibility but is no longer assignable.
  - `0017` snapshots the submitting store on ingestions and immutable batches for arrivals.
  - `0024` adds rotating, revocable refresh-session families.
  - `0025` adds the four IAM roles, the three professions, business portals,
    user-portal assignments, client-type sessions, and ownership snapshots.
  - `0026` removes the obsolete account-activation table and lookup function.

---

## 8. API endpoint list

Conventions for every endpoint below:

- **Versioning:** all paths under `/v1`. Breaking changes ⇒ `/v2` with a deprecation window (§15).
- **Headers (all requests):** `X-Correlation-Id` (client may supply; server generates if absent
  and always echoes it). `Authorization: Bearer <token>` except where noted. Responses also carry
  a server-generated `traceparent` (W3C) so traces stitch across the pipeline.
- **Idempotency:** business writes marked below require `Idempotency-Key` (§11).
  IAM active-state `PUT`/`PATCH` operations are state-idempotent and soft; GETs
  are inherently idempotent.
- **Auth scope:** OAuth2-style scopes (`<resource>:<action>`) decide capability;
  the organization/store/portal access context independently bounds data (see §10).
- **Pagination:** list endpoints use cursor pagination (`?limit=&cursor=`), returning
  `{ items, next_cursor }`. Filtering/sorting via explicit query params only.

### IMPLEMENTED endpoints

| Method | Path | Purpose | Auth scope | Idempotent? |
|--------|------|---------|-----------|-------------|
| POST | `/v1/o/{organization_slug}/auth/login` | Browser login for manager/admin/super-admin; rotating cookie session. | none | No |
| POST | `/v1/mobile/auth/login` | Mobile login for a manager with exactly one active portal; explicit refresh token. | none | No |
| POST | `/v1/auth/refresh`, `/v1/mobile/auth/refresh` | Rotate a same-client-type refresh session. | refresh credential | Rotation-safe |
| GET | `/v1/me` | Current user, scopes, authorized stores, and detailed portals. | authenticated | Yes (safe) |
| POST | `/v1/me/password` | Change own password and revoke own sessions. | authenticated | No |
| GET | `/v1/professions` | Three versioned profiles: `poissonnerie`, `boucherie`, `charcuterie_traiteur`. | `catalog:read` | Yes (safe) |
| GET, POST | `/v1/admins` | Super-admin lists or creates active admins. | `identity:admins:manage` | GET only |
| DELETE | `/v1/admins/{user_id}` | Super-admin soft-deactivates an admin. | `identity:admins:manage` | State-idempotent |
| GET, POST | `/v1/managers` | Admin/super-admin lists or creates managers. | `identity:managers:manage` | GET only |
| PATCH | `/v1/managers/{user_id}` | Toggle manager activity. | `identity:managers:manage` | State-idempotent |
| PATCH | `/v1/managers/{user_id}/portals` | Replace active assignments without deleting history. | `identity:managers:manage` | State-idempotent |
| POST | `/v1/stores` | Create a uniquely coded store. | `identity:admin` | No |
| GET | `/v1/stores` | List/filter the store directory. | `identity:admin` | Yes (safe) |
| PATCH | `/v1/stores/{code}` | Rename, activate, or safely disable a store. | `identity:admin` | State-idempotent |
| GET | `/v1/stores/{store_id}/portals` | List portals visible in the current access context. | authenticated | Yes (safe) |
| PUT | `/v1/stores/{store_id}/portals` | Admin/super-admin soft-activates a portal; disabling revokes affected sessions. | `identity:portals:manage` | State-idempotent |
| GET | `/v1/arrivals` | Filter/sort arrivals by authorized stores, portal, profession, state, completeness, supplier, lot, GTIN, actor, dates, expiry, and extracted fields. | `catalog:read` | Yes (safe) |
| GET | `/v1/arrivals/{batch_id}` | Detailed portal-scoped arrival projection. | `catalog:read` | Yes (safe) |
| GET | `/v1/arrivals/{batch_id}/image` | Read the store-scoped persisted source photo. | `catalog:read` | Yes (safe) |
| POST | `/v1/ingestions` | Submit capture (multipart: image + barcode_raw + client_captured_at). Stores raw + enqueues extraction. Returns 202. | `ingestion:write` | **Yes — requires `Idempotency-Key`** |
| GET | `/v1/ingestions/{id}` | Ingestion status + extraction run summaries + audit. | `ingestion:read` | Yes (safe) |
| GET | `/v1/extraction-runs/{id}` | Extraction run with per-field details (value/confidence/validation_status/band) + audit. | `ingestion:read` | Yes (safe) |
| GET | `/v1/batches/{id}` | Batch with supplier/product + linked alerts + audit. | `traceability:read` | Yes (safe) |
| GET | `/v1/alerts` | Filterable paginated alert list + latest audit. | `haccp:read` | Yes (safe) |
| POST | `/v1/alerts/{id}/acknowledge` | Transition open → acknowledged. | `alert:ack` | **Yes — requires `Idempotency-Key`** |
| POST | `/v1/alerts/{id}/resolve` | Transition open/acknowledged → resolved. | `alert:resolve` | **Yes — requires `Idempotency-Key`** |
| GET | `/v1/health/live` | Liveness probe. | none | Yes (safe) |
| GET | `/v1/health/ready` | Readiness (DB + object store). | none | Yes (safe) |
| GET | `/v1/version` | Build version + rule-set version. | none | Yes (safe) |

### NOT YET IMPLEMENTED endpoints (design reference)

| Method | Path | Purpose | Auth scope |
|--------|------|---------|-----------|
| GET | `/v1/ingestions` | List ingestions (filter by status, date, actor, barcode). | `ingestion:read` |
| GET | `/v1/ingestions/{id}/image` | Fetch raw image (signed URL redirect). | `ingestion:read` |
| POST | `/v1/ingestions/{id}/extract` | Manual re-extraction (new ExtractionRun). | `extraction:run` |
| GET | `/v1/ingestions/{id}/extraction` | Current extraction status + per-field details. | `ingestion:read` |
| GET | `/v1/ingestions/{id}/extraction/runs` | History of all extraction runs. | `ingestion:read` |
| GET | `/v1/ingestions/{id}/ocr` | Raw OCR result reference + summary. | `ingestion:read` |
| PATCH | `/v1/ingestions/{id}/fields/{field_name}` | Human override of a single extracted field. | `extraction:review` |
| POST | `/v1/ingestions/{id}/confirm` | Confirm extraction after review. | `extraction:confirm` |
| POST | `/v1/ingestions/{id}/reject` | Reject ingestion. | `extraction:confirm` |
| POST | `/v1/batches` | Create batch/lot (manual). | `batch:write` |
| GET | `/v1/batches` | List/search batches. | `traceability:read` |
| POST | `/v1/suppliers` | Create supplier. | `supplier:write` |
| GET | `/v1/suppliers` | List/search suppliers. | `traceability:read` |
| GET | `/v1/suppliers/{id}` | Get supplier. | `traceability:read` |
| PATCH | `/v1/suppliers/{id}` | Update supplier (If-Match ETag). | `supplier:write` |
| DELETE | `/v1/suppliers/{id}` | Soft deactivate supplier. | `supplier:admin` |
| GET | `/v1/trace` | Unified traceability lookup. | `traceability:read` |
| GET | `/v1/trace/by-lot/{lot_code}` | Lookup by lot. | `traceability:read` |
| GET | `/v1/trace/by-batch/{batch_id}` | Full provenance chain. | `traceability:read` |
| POST | `/v1/temperature-logs` | Append temperature reading. | `temperature:write` |
| GET | `/v1/temperature-logs` | List temperature readings. | `haccp:read` |
| GET | `/v1/alerts/{id}` | Get one alert. | `haccp:read` |
| GET | `/v1/audit` | Query append-only audit log. | `audit:read` |
| GET | `/v1/audit/{entry_id}` | Get one audit entry. | `audit:read` |

---

## 9. Standard error response format

### 9.1 Envelope (RFC 9457 `application/problem+json`, extended)

Every non-2xx response uses one shape. Content type `application/problem+json`.

```json
{
  "type": "https://errors.labelscan/REQUIRED_FIELD_MISSING",
  "title": "A required label field is missing or unverified",
  "status": 422,
  "detail": "Field 'use_by' is required by rule-set v7 but was not extracted with sufficient confidence.",
  "error_code": "REQUIRED_FIELD_MISSING",
  "correlation_id": "corr_01J...",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "timestamp": "2026-06-14T09:12:05Z",
  "retriable": false,
  "errors": [
    { "field": "use_by", "code": "REQUIRED_FIELD_MISSING", "message": "required by rule-set v7" }
  ]
}
```

### 9.2 Stable error-code catalog

Codes are **append-only and never renumbered/repurposed** (same discipline as the audit log).

| `error_code` | HTTP | Meaning | Retriable? |
|--------------|------|---------|-----------|
| `VALIDATION_ERROR` | 400 | Malformed request. | No |
| `UNAUTHENTICATED` | 401 | Missing/invalid/expired token. | No |
| `FORBIDDEN` | 403 | Authenticated but lacks scope/role. | No |
| `NOT_FOUND` | 404 | Resource is absent or outside the caller's data perimeter (IDOR-safe). | No |
| `METHOD_NOT_ALLOWED` | 405 | e.g. attempting to write the audit log. | No |
| `STORE_NOT_FOUND` | 400 | Referenced store code does not exist. | No |
| `STORE_REQUIRED` | 400 | The account has no attributable store assignment. | No |
| `USER_ALREADY_EXISTS` | 409 | Username is already assigned. | No |
| `STORE_ALREADY_EXISTS` | 409 | Store code is already assigned. | No |
| `STORE_INACTIVE` | 409 | Disabled store cannot receive an assignment. | No |
| `STORE_IN_USE` | 409 | Store still has active users or active portal assignments. | No |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Key reused with different payload. | No |
| `RESOURCE_CONFLICT` | 409 | Generic state conflict. | No |
| `ALERT_INVALID_TRANSITION` | 409 | Alert lifecycle transition not allowed. | No |
| `INGESTION_INVALID_STATE` | 409 | Action not valid for ingestion's current status. | No |
| `EXTRACTION_NOT_READY` | 409 | Extraction not yet run/complete. | Yes (poll) |
| `PRECONDITION_FAILED` | 412 | If-Match ETag mismatch. | Yes |
| `PAYLOAD_TOO_LARGE` | 413 | Image/body exceeds limit. | No |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Image not an accepted type. | No |
| `REQUIRED_FIELD_MISSING` | 422 | Rule-set-required field is null/low-confidence. | No |
| `LOW_CONFIDENCE_FIELD` | 422 | Field below confirm threshold. | No |
| `GTIN_CHECKSUM_INVALID` | 422 | Barcode/GTIN fails check-digit validation. | No |
| `LOT_CODE_DUPLICATE` | 422 | Lot code already exists for supplier+product. | No |
| `BUSINESS_RULE_VIOLATION` | 422 | Generic domain-invariant breach. | No |
| `RATE_LIMITED` | 429 | Too many requests. | Yes |
| `INTERNAL_ERROR` | 500 | Unexpected server fault. | Yes |
| `DEPENDENCY_UNAVAILABLE` | 503 | DB/object-store/provider down. | Yes |
| `EXTRACTION_PROVIDER_ERROR` | 502 | OCR/LLM provider error. | Yes |
| `GATEWAY_TIMEOUT` | 504 | Upstream provider exceeded timeout budget. | Yes |

---

## 10. Authentication and authorization strategy

### 10.1 Current implementation

| Aspect | Current | Design target |
|--------|---------|---------------|
| **Token format** | HS256 JWT (symmetric, secret ≥32 bytes) | RS256 JWT (asymmetric, JWKS rotation) |
| **Signing secret** | `LABELSCAN_JWT_SECRET` env var | IdP JWKS endpoint |
| **Session** | Short-lived access JWT plus opaque rotating refresh family; replay revokes the family | IdP-backed refresh/session policy |
| **Roles** | `super_admin`, `admin`, `manager` | Enterprise IdP group mapping |
| **Browser login** | Organization route; manager/admin/super-admin only; refresh in strict cookie | OIDC login at IdP |
| **Mobile login** | Single-portal manager only; refresh returned for SecureStore | Managed-device policy where required |
| **Header auth** | Off by default (`LABELSCAN_ALLOW_HEADER_AUTH=0`) | Removed |

All three roles receive only their domain capabilities. Data visibility is a
separate access context:

| Role | Data perimeter | IAM capability delta |
|---|---|---|
| `super_admin` | Every store/portal in one organization | `identity:admins:manage`, `identity:managers:manage`, `identity:portals:manage`, `identity:read` |
| `admin` | Portals of stores it owns | `identity:managers:manage`, `identity:portals:manage`, `identity:read` |
| `manager` | Its single assigned portal and derived store | `identity:read` |

Every data query is constrained by `organization_id`; non-organization-wide
roles add `business_portal_id` (or store fallback for attributable legacy rows).
The same scope is applied to list, detail, and image routes. A resource absent
or outside the caller's data perimeter returns the same `404 NOT_FOUND`, which
prevents IDOR enumeration. `403 FORBIDDEN` means the authenticated actor lacks
the action/role or explicitly requests a portal outside its assignments.

### 10.2 Optional future IdP roles

The database still accepts the historical `operator` value so immutable history
and old migrations remain interpretable. Production JWT validation rejects it,
and no current route can assign it or issue it a new browser/mobile session.

The following names are design inputs for a future enterprise IdP mapping, not
current application roles:

| Role | Intended persona | Scopes granted |
|------|-------------------|----------------|
| `scanner-device` | Kiosk/handheld capture device | `ingestion:write` only |
| `fishmonger` | Counter staff | `ingestion:write`, `ingestion:read`, `extraction:review`, `temperature:write`, `haccp:read`, `traceability:read` |
| `supervisor` | Shift/quality lead | all `fishmonger` + `extraction:confirm`, `extraction:run`, `batch:write`, `supplier:write`, `alert:ack`, `alert:resolve` |
| `auditor` | Compliance/QA | read-only: `ingestion:read`, `traceability:read`, `haccp:read`, `audit:read` |
| `admin` | Platform owner | `supplier:admin` + all of `supervisor` |

---

## 11. Idempotency strategy

Two-layer idempotency, as designed:

1. **HTTP edge:** client-supplied `Idempotency-Key` header on all unsafe endpoints.
   Scoped to `(principal, route, key)`. Same key + same content → replay original
   response with `Idempotency-Replayed: true`. Same key + different content →
   `409 IDEMPOTENCY_KEY_CONFLICT`. Key TTL: 24 h (swept on expiry).
2. **Event bus:** per-consumer `event_id` dedup in `platform.processed_event`.
   At-least-once delivery + idempotent consumers = effectively-once processing.

Content-addressed raw store (`sha256` checksum) prevents double-append of the
same image even across retries.

---

## 12. Validation strategy

Three layers, each rejecting at the cheapest possible point:

### 12.1 Boundary validation (Pydantic, inbound adapters only)

Pydantic models in `contexts/*/adapters/http/` — never in `domain/`.
Rejects malformed shapes, wrong types, out-of-range scalars, unknown image media
types, oversize bodies → `400`/`415`/`413`/`422` before any use case runs.

### 12.2 The LLM-output validation gate (the critical one)

**[IMPLEMENTED]** in `ingestion/domain/extraction.py` (`evaluate()`):

1. **No-fabrication invariant.** Every non-null `value` must carry `evidence`
   that is a verbatim substring of the stored raw OCR text. Values that cannot
   be tied back → coerced to `null` with `validation_status='invalid'`.
2. **Cross-field consistency.** e.g. expiry_date ≥ packaging_date.
3. **Controlled vocabulary.** `production_method` ∈ {wild_caught, farmed};
   out-of-vocab values kept but flagged for review.
4. **Confidence thresholds.** `combined_confidence < review_below` on a required
   field → `needs_review`. Bands: low (<0.70), medium (≥0.70), high (≥0.90).
5. **Required-field gate.** Missing required fields force `needs_review`.

### 12.3 GS1 reconciliation

**[IMPLEMENTED]** in `ingestion/domain/reconciliation.py` (`reconcile()`):

- GS1 values (from `parse_gs1(barcode_raw)`) **override** LLM values on conflict
  for lot/DLC/weight/GTIN/packaging_date — GS1 confidence is 1.0.
- A barcode↔print mismatch on lot/DLC forces `needs_review` even if GS1 resolves
  the value — the human must see the labelling integrity anomaly.
- GS1-satisfied required fields clear review flags (`adjusted_outcome()` — Option Y).

### 12.4 Required-field validation at confirm

**[NOT YET IMPLEMENTED]** — the `POST /confirm` endpoint does not exist yet.
When built, it will re-run the rule-set check: if any rule-set-required field is
still null or below threshold, confirm is blocked with `REQUIRED_FIELD_MISSING`.

---

## 13. Timeout and retry strategy

### 13.1 Per-dependency policy

| Dependency | Timeout | Retries | Backoff | Notes |
|------------|---------|---------|---------|-------|
| **OCR provider** (Google Vision) | 30 s | up to 3 | bounded retry in ExtractionConsumer | Async worker only. Failure ⇒ `ocr_failed`. |
| **LLM extractor** (Claude) | 120 s | up to 3 | bounded retry in ExtractionConsumer | Async worker. Failure ⇒ `extraction_failed`. |
| **PostgreSQL** | statement_timeout | transient only | short exponential | Business writes are transactional. |
| **Object store** (filesystem) | N/A (local) | up to 3 on failure | exponential + jitter | Content-addressed → idempotent retry. |
| **JWT verification** | local (no network) | N/A | N/A | HS256 secret loaded at boot. |

### 13.2 Outbox DLQ with exponential backoff

**[IMPLEMENTED]** (migration 0009, `platform/outbox/worker.py` + `backoff.py`):

- Failed outbox events retry with **equal-jitter exponential backoff**
  (`calculate_backoff()`, `backoff_delay_seconds()`).
- `attempts` counter increments per attempt; `next_retry_at` set to now + backoff delay.
- After `LABELSCAN_OUTBOX_MAX_RETRIES` (default 3), the event moves to
  `status='dead_letter'` with `last_error` captured.
- Dead-letter events are alertable and can be replayed via `requeueDeadLetter()`.
- Non-retryable error codes (from `ERROR_CATALOG`) skip retries and go directly to DLQ.

---

## 14. Observability plan

### 14.1 Structured logging **[IMPLEMENTED]**

`platform/observability.py` emits one JSON line per event on stdout
(`LABELSCAN_LOG_LEVEL`, default INFO). Fields are **allow-listed** (no secret
ever logged). The 500 handler logs the real traceback; the worker logs dispatch +
failures; extraction logs outcome + LLM refusal/failure.

### 14.2 Correlation/trace **[IMPLEMENTED]**

`CorrelationMiddleware` sets `correlation_id`/`trace_id` on every request; they
flow into the command, DB columns, the audit trigger, the outbox envelope,
problem+json error bodies, **and the logs**.

### 14.3 Metrics + SLO instrumentation **[NOT YET IMPLEMENTED]**

Prometheus/OTel metrics and SLO instrumentation are not yet present. This is the
biggest observability gap. The design targets:

- **RED per route:** Rate, Errors (by `error_code`), Duration (histogram).
- **USE per resource:** DB pool, object-store throughput, worker queue depth + age.
- **Domain metrics:** extraction success rate, mean per-field confidence,
  % `needs_review`, alert counts, time-to-acknowledge.

### 14.4 SLO targets (initial, not yet instrumented)

| SLO | Target |
|-----|--------|
| Ingestion submit availability | 99.9% |
| Ingestion submit latency | p95 < 1.5 s |
| Extraction success rate | ≥ 95% within 5 min |
| Extraction freshness | p95 submit→available < 60 s |
| Read APIs | p95 < 200 ms |

---

## 15. Migration strategy

### 15.1 Introducing the backend behind the existing app (strangler)

The mobile client submits the cropped label image to `POST /v1/ingestions`, then
polls the extraction result. OCR and LLM processing are server-only; there is no
client-side provider key or alternate on-device OCR path.

### 15.2 Zero-downtime schema evolution (expand-and-contract)

Every schema change ships in three migrations:

1. **Expand:** add new nullable columns/tables/indexes (backward-compatible).
2. **Migrate/backfill:** backfill new columns; dual-write keeps them in sync.
3. **Contract:** drop old columns/code in a later release.

Constraints:
- **Raw + audit tables are append-only** — migrations may add columns but never
  UPDATE/DELETE. Backfills require the audited `labelscan_maint` role.
- **Per-context schemas** keep migrations scoped.

### 15.3 Migration chain (Alembic)

| Migration | Description |
|-----------|-------------|
| 0001 | Schemas + least-privilege `labelscan_app` role |
| 0002 | Audit immutability foundations (audit_log, deny_mutation trigger) |
| 0003 | Harden security definer + raw_artifact table (append-only, partitioned) |
| 0004 | Ingestion table (mutable, audited-on-insert) |
| 0005 | Extraction (extraction_run + extracted_field) |
| 0006 | Traceability + HACCP (supplier, product, batch, control_plan, temperature_log, alert) |
| 0007 | Identity: app_user (credential store for JWT auth) |
| 0008 | GS1 provenance: `source += 'gs1'`, `field_name += 'gtin'` |
| 0009 | Outbox DLQ + backoff: attempts, next_retry_at, last_error, status columns |
| 0024 | Opaque rotating refresh sessions, replay detection, and family revocation |
| 0025 | Multi-trade professions/portals, IAM assignments, client-type sessions, and ownership snapshots |
| 0026 | Removal of obsolete account-activation storage and lookup function |

### 15.4 Reversibility of each backend phase

| Phase | Backend addition | Status | Rollback |
|-------|-----------------|--------|----------|
| 0 Foundations | `server/` skeleton, schemas, ports, CI arch-tests | **IMPLEMENTED** | delete `server/`; no client impact |
| 1 Immutable ingestion | POST /ingestions, raw store, audit, idempotency | **IMPLEMENTED** | feature-flag off; backend idle |
| 2 Extraction | OCR/LLM behind ports, async worker, gate, GS1 reconciliation | **IMPLEMENTED** | extractor is a port; re-extract is additive |
| 3 Domain + validation | batches/suppliers/compliance (auto from events) | **IMPLEMENTED** | new contexts additive |
| 4 Traceability + HACCP | lookup + alerting endpoints | **PARTIALLY IMPLEMENTED** | read APIs side-effect-free; alerting enabled per control |
| 5 Thin client | app drops local source-of-truth; durable queue | **PARTIALLY IMPLEMENTED** | keep AsyncStorage as cache/outbox |

---

## 16. Security risks and mitigations

| # | Threat | Mitigation | Status |
|---|--------|------------|--------|
| S1 | Bundled Vision API key leak (A3/R7) | Provider calls server-side; client uses JWT. Legacy path still uses client key (opt-in). | **Partially mitigated** |
| S2 | Image & PII handling | TLS in transit; object store at rest; signed URLs planned. | **Partially implemented** |
| S3 | Prompt injection into the LLM | No-fabrication gate; evidence must be verbatim in OCR; LLM has no tools/side effects. | **Implemented** |
| S4 | Injection (SQL/command) | Parameterized queries; Pydantic boundary validation. | **Implemented** |
| S5 | Broken authn/authz | HS256 JWT verified per request; fail-closed scope checks. RS256/OIDC is future target. | **Implemented (HS256)** |
| S6 | Secrets management | Keys in `.env` (no secret manager yet — **last GO blocker R2**). | **Open** |
| S7 | Transport security | TLS 1.2+ everywhere. | **Implemented** |
| S8 | Audit-log tamper-resistance | DB grants + deny_mutation trigger; no API write path to audit; same-txn co-commit. | **Implemented** |
| S9 | Multi-tenant isolation | `site_id` columns dormant. | **Dormant hook** |
| S10 | DoS / cost abuse | Body-size limit; per-principal rate limits not yet implemented. | **Partially implemented** |
| S11 | Untrusted device clock | All timestamps server-stamped. | **Implemented** |
| S12 | Replay / duplicate submission | Idempotency keys + content-addressed raw store. | **Implemented** |

---

## 17. Known gaps / roadmap

| Area | Gap | Priority | Status |
|---|---|---|---|
| Secrets | API keys in `server/.env` (no secret manager) — **last GO blocker (R2)** | High | Open |
| Observability | Structured logging done; **metrics + SLO** instrumentation missing | High | Open |
| Rate limiting | No per-principal rate limits at the edge | High | Open |
| Auth | Local RBAC delivered; need RS256/JWKS + enterprise OIDC/SSO | Medium | Partial |
| Mobile offline | Durable outbox on device is **not drained** (single foreground attempt) | Medium | Open |
| Ops | DB backup/PITR; partition-rolling job; multi-stage non-root Dockerfile | Medium | Open |
| Contract | `value` flattened to `string` vs polymorphic jsonb; confidence `min()` vs versioned composite | Medium | Owner decision |
| HITL review | PATCH /fields, POST /confirm, POST /reject endpoints not yet built | Medium | Not built |
| Image serving | GET /ingestions/{id}/image (signed URL) not yet built | Medium | Not built |
| Temperature API | TemperatureRecorder exists but no HTTP route exposes it | Low | Not built |
| Compliance context | Schema + tables exist but no code (rule sets not yet authored) | Low | Placeholder |

**Closed since the v1 audit:** real JWT auth (was a stub), hybrid GS1+LLM
extraction (zero hallucination on lot/DLC), DLQ with exponential backoff (was
retried forever), structured logging, outbox worker heartbeat + compose healthcheck.

---

## 18. Trade-offs (consolidated)

| Decision | Gained | Given up | Reversibility |
|----------|--------|----------|---------------|
| **Modular monolith (ADR-0001)** | Low ops cost, single-transaction raw+audit, refactorable boundaries | Independent per-context scaling now | High — extract along seams |
| **Async, queue-backed extraction** | Ingestion survives provider outages; capture never blocked | Job infra; eventual extraction; outbox + idempotent consumers | High |
| **HS256 JWT now (RS256 later)** | Local RBAC without IdP dependency | Symmetric secret (must be shared); no JWKS rotation or SSO | Medium — swap to RS256 is an adapter change |
| **Claude Haiku 4.5 as default LLM** | Low cost; fast; GS1 handles critical exact fields | Less capable on hard cases; bounded retry may not recover | High — model is config behind port |
| **Hybrid GS1+LLM extraction** | Zero hallucination on lot/DLC/weight/GTIN; GS1 confidence = 1.0 | GS1 parser only handles HACCP-relevant AIs; barcode-dependent | Medium — falls back to LLM-only if no barcode |
| **DLQ + exponential backoff** | Poison events no longer retried forever; alertable dead-letter | More state in outbox table; `requeueDeadLetter()` is manual | High |
| **Idempotency keys on all unsafe writes** | Safe client retries; no duplicate ingestions | Client must generate keys; key table + sweeping | High |
| **LLM-output gate: evidence-to-raw + thresholds** | "Never trust the LLM" enforced structurally; no fabrication | Some valid-but-novel values flagged for review | High — thresholds are versioned data |
| **problem+json + stable error_code catalog** | Clients branch on stable codes; consistent errors | Catalog discipline (append-only) | High |
| **Expand-and-contract migrations** | Zero-downtime schema evolution | Three-step migrations; dual-write windows | High |
| **Append-only raw + audit with DB-enforced immutability** | DB-level integrity guarantee; provable "didn't invent / didn't tamper" | Storage cost; can't edit, only supersede | Medium (intentionally hard to reverse) |

---

## Appendix — backend coverage of the architecture's hard constraints

| Constraint (ARCHITECTURE §0) | Backend section that carries it |
|------------------------------|---------------------------------|
| #1 no fabrication, unknown ⇒ null | §12.2 (provenance-to-raw gate), §12.3 (GS1 reconciliation) |
| #2 confidence per field | §12.2/12.3 (thresholds, composite), references ADR-0005 |
| #3 raw before normalized | §4 (raw stored on submit before enqueue) |
| #4 auditable + immutable | §7 (append-only, deny_mutation trigger, same-txn audit) |
| #5 framework-free domain | §3 (Pydantic only in adapters, import-linter enforced) |
| #6 replaceable OCR/LLM | §3 (ports), §5 (OcrPort, LlmExtractorPort) |
| #7 reversible, trade-offs named | §18, §15.4 |
| #8 correlation_id/trace_id everywhere | §14.2 (middleware + outbox envelope + logs) |
