# LabelScan database

This guide describes the PostgreSQL schema used by the running backend. It
focuses on ownership, integrity, tenancy, and the queries the application
actually performs.

The current logical schema is represented by the SQLAlchemy ORM models in
`server/src/labelscan/platform/db/models.py`. Alembic migrations in
`server/migrations/versions/` remain the executable source of truth for
PostgreSQL-only controls (RLS, triggers, grants, roles, functions and partitions).
Always deploy with `alembic upgrade head`; do not create a parallel SQL history
under `docs/`.

The current Alembic head is `0035_catalog_export_audit`: it follows the
consolidated `0033_trade_profiles_v2` baseline and the sanitized-image revision
`0034_sanitized_image_artifact`.

## Why PostgreSQL is central to the design

The database does more than store rows. It enforces the controls that should not
depend on every application path remembering them:

- organization-level row security;
- tenant-qualified foreign keys and business identities;
- append-only history through mutation-denial triggers;
- same-transaction audit records;
- durable request idempotency;
- transactional outbox delivery;
- uniqueness and shape constraints for extraction data;
- indexed current-arrival reads over immutable source history.

PostgreSQL 16 is the deployed database family. Application code uses SQLAlchemy
with the psycopg 3 driver.

## Schema map

| Schema | Current tables | Responsibility |
|---|---|---|
| `identity` | `organization`, `app_user`, `store`, `profession`, `business_portal`, `user_portal_assignment`, `auth_session` | Tenant directory, credentials, access assignments, and rotating sessions |
| `ingestion` | `ingestion`, `raw_artifact`, `extraction_run`, `extracted_field`, `interim_field`, `request_idempotency` | Capture lifecycle, immutable provider history, fields, and review writes |
| `traceability` | `product`, `supplier`, `batch`, `arrival_projection` | Published traceability chain and fast current-arrival reads |
| `haccp` | `temperature_log`, `control_plan`, `alert` | Internal control data and alert lifecycle |
| `audit` | `audit_log`, `catalog_export_log` | Append-only actor/action and tenant-scoped catalogue-export history |
| `platform` | `idempotency_key`, `outbox`, `processed_event` | Request replay, asynchronous delivery, and consumer deduplication |
| `compliance` | No application tables | Reserved boundary for a future authoritative rule owner |

The old activation-token tables are not part of the current schema. Accounts are
created with direct passwords, and runtime access changes use soft state and
session revocation.

## Main ownership chain

```text
identity.organization
  └── identity.store
       └── identity.business_portal ──> identity.profession
            ├── identity.user_portal_assignment ──> identity.app_user
            └── ingestion.ingestion
                 ├── ingestion.raw_artifact
                 ├── ingestion.interim_field
                 ├── ingestion.extraction_run
                 │    └── ingestion.extracted_field
                 └── traceability.batch
                      ├── traceability.product
                      ├── traceability.supplier
                      ├── traceability.arrival_projection
                      └── haccp.alert
```

An ingestion snapshots `organization_id`, `store_id`, `business_portal_id`,
profession code, profile version, store code, and capture actor. Published batches
and arrival projections carry the same dimensions. Reassigning a manager or
renaming a store therefore does not silently move an old capture into a new
business context.

Some aggregate references are intentionally by ID rather than foreign key. In
particular, partitioned raw artifacts and the event-driven context boundaries do
not all use cross-aggregate referential constraints. The write transaction and
tenant-qualified queries preserve those links. Within aggregates and ownership
boundaries, the migrations use ordinary and composite foreign keys.

## Identity and access data

`identity.organization` is the tenant root. Store codes and live usernames are
unique inside an organization, not globally. A soft-deleted manager can release
its username while its historical row remains available for old labels.

`identity.business_portal` is unique for
`(organization, store, profession)`. Creating a store provisions one row for
each supported profession and activates only the selected portals. Portal and
assignment state is mutable and audited.

The API limits a manager to one portal assignment. That rule is enforced by the
request model and identity service, not by a database constraint that prevents
all possible direct multi-row writes. Database clients outside the application
must preserve the same invariant.

`identity.auth_session` stores hashes of opaque refresh tokens, a token family,
user, organization, client type, expiry, consumption, replacement, and
revocation state. Access-token validation checks that the referenced family is
still active.

## Ingestion and extraction data

### Ingestion lifecycle

`ingestion.ingestion` is the mutable aggregate root. Its status is constrained to
the full compatibility state set:

```text
raw_stored, ocr_running, ocr_done, ocr_failed, ocr_skipped_garbage,
extraction_running, extracted, extraction_failed, needs_review,
confirmed, rejected, halted_missing_context
```

The active worker normally writes only the states documented in
[`API-CONTRACTS.md`](../backend/API-CONTRACTS.md). Keeping compatibility values
in the database does not mean every state has a current transition path.

The runtime role can update only status and the two photo-orientation columns.
All other ingestion facts are snapshots established at submission.

### Raw artifacts

`ingestion.raw_artifact` is partitioned by server occurrence time and stores
metadata for `image`, `ocr_json`, and `llm_output` objects. Images and normalized
OCR/model artifact JSON live in the private object store; PostgreSQL stores the
content-addressed reference and SHA-256. The current persistence helpers do not
retain complete verbatim provider responses.

Artifacts are append-only. A model column distinguishes primary and optional
escalation output. Organization and ingestion indexes support tenant-safe lookup
and provider-call deduplication.

The table has a default partition, so new writes are not tied to a hard-coded
calendar partition. There is no automated partition-creation or archival job in
the repository; operators should add one before data volume makes the default
partition a maintenance risk.

### Extraction runs and fields

Every machine attempt or human correction creates a new
`ingestion.extraction_run`. A run records attempt number, outcome, extractor and
prompt versions, OCR provider, primary and optional escalation model, OCR
artifact reference, rule-set version, correlation, trace, and server time.

`ingestion.extracted_field` stores one row per field per run. Uniform metadata is
typed and queryable:

- `field_name`;
- JSONB string value or null;
- evidence and computed provenance;
- source artifact ID;
- validation status and warnings;
- LLM, OCR, and combined confidence;
- confidence band;
- source: `llm`, `gs1`, or `human`.

Current profile version 2 does not emit `price`. The database keeps the wider
historical field-name set, including old `product_name`, `supplier_name`, and
`price` rows, so immutable version 1 records remain readable.

Important constraints include:

- one attempt number per ingestion;
- one field name per run;
- positive attempt numbers;
- bounded metadata, values, evidence, warnings, and idempotency keys;
- finite confidence ranges from zero to one;
- evidence exists if and only if a value exists;
- non-null values require provenance and a source artifact;
- allowed field names, sources, statuses, bands, and outcomes.

`ingestion.interim_field` is a short-lived concept but an append-only table. Its
rows are non-authoritative OCR previews and are ignored after a full extraction
run exists.

`ingestion.request_idempotency` protects per-field override and atomic final
review requests. It binds actor and request key to the ingestion, resulting run,
field when applicable, and request hash.

## Traceability and current arrivals

`traceability.product` and `traceability.supplier` are immutable registry rows.
`traceability.batch` links them to the confirmed ingestion and human extraction
run. Its visible business identity is tenant and portal aware, so the same lot
can exist independently in separate organizations or portals.

A batch is inserted as `registered` or `flagged`. It is not created directly by
an HTTP route; the traceability consumer creates it after `review.finalized`.
Repeated publication of the same confirmed ingestion is idempotently ignored.

`traceability.arrival_projection` is the intentionally mutable read model. It
contains the latest field map and presentation metadata for a batch while the
source ingestion, runs, and batch remain historical truth. Human revisions
increment the projection revision rather than rewriting source history.

The catalog repository applies tenant and portal predicates before search,
filtering, sorting, pagination, and exact total counting. Its main indexes cover:

- organization, portal, and recorded time;
- organization, portal, and expiry;
- product, supplier, lot, status, and completeness sort expressions;
- trigram search over the JSONB field projection, supplier, and lot;
- capture actor and trade snapshots.

## Alerts and internal control data

`haccp.control_plan` is append-only configuration read by the alerting consumer.
`haccp.temperature_log` is partitioned and append-only, but the current HTTP app
does not expose a temperature-log route.

`haccp.alert` is mutable because its state moves through `open`,
`acknowledged`, and `resolved`. It carries organization, store, and portal
ownership and is audited on insert and update. Current event consumers create
expiry and consistency alerts; the schema also retains other constrained alert
types used by internal rules and compatibility paths.

## Audit integrity

Application writes set four transaction-local values before touching an audited
table:

```text
labelscan.actor_id
labelscan.action
labelscan.correlation_id
labelscan.trace_id
```

Database triggers reject audited writes without this context and insert the
audit row in the same transaction. If the business write rolls back, its audit
row rolls back too. The runtime role can read the audit log but cannot insert,
update, delete, or truncate it directly.

Mutation-denial triggers protect append-only tables from update, delete, and
truncate operations. Least-privilege grants provide a second layer. The audited
unit for extraction fields is the parent extraction run, not a separate audit row
for every field.

This is strong protection against accidental or compromised application writes;
it is not cryptographic tamper evidence and it is not a claim that a privileged
database owner cannot alter DDL or disable controls. Backups, restricted owner
access, external audit retention, and infrastructure monitoring remain necessary.

## Tenant isolation

The runtime sets `labelscan.organization_id` transaction-locally. Row-level
security policies compare tenant-owned rows with that value. Direct tenant tables
and ingestion child tables use forced RLS, so the runtime table owner cannot be
used as an implicit bypass.

Repositories also add explicit organization, store, and portal predicates. The
two layers serve different purposes: query predicates express the business
perimeter, while RLS is database defence in depth.

The migration chain validates the role split before applying its hardening step:

- `labelscan_app` must not be the migration connection;
- it must not be superuser or have `BYPASSRLS`, database creation, role creation,
  or replication privileges;
- it must not own application schemas, tables, functions, or the database;
- application object ownership belongs to a separate migration role.

RLS depends on setting tenant context correctly. An empty or wrong context fails
closed for tenant rows, but new repositories still need tests proving that they
set the context before every access.

## Platform durability tables

`platform.idempotency_key` protects capture submission. Its scope hash includes
tenant, principal, portal or store, route, and caller key or content identity. A
fingerprint mismatch is a conflict rather than a replay. New rows receive an
`expires_at` timestamp, but current claim and replay queries do not filter on it
and no cleanup job removes expired rows. In practice, a submitted scope remains
reserved.

`platform.outbox` is written in the same transaction as business events. Workers
claim only registered event types, lock one row with `SKIP LOCKED`, and mark it
published after every registered consumer succeeds.

`platform.processed_event` stores `(consumer, event_id)` and prevents a committed
consumer side effect from running twice. Handler failures record attempt count,
error detail, next retry time, and eventually `dead_letter` status. These platform
records have no append-only mutation-denial trigger. `idempotency_key` and `outbox` are
mutable working state; the runtime role receives only `SELECT` and `INSERT` on
`processed_event`.
`outbox.last_error` currently retains the full formatted traceback. There is no
general redaction or automated retention pass for that column, so exception text
must be treated as potentially sensitive operational data.

## Migration workflow

From the backend environment:

```bash
cd server
alembic upgrade head
```

CI proves that the full chain can upgrade, downgrade to base, and upgrade again
on a disposable database. That reversibility test does not make every production
downgrade safe after real data has been written; inspect each migration before a
rollback and prefer a forward repair when data conversion could be destructive.

Practical migration rules:

- use Alembic files under `server/migrations/versions/` only;
- connect as the migration owner, never `labelscan_app`;
- add nullable structures before making application code depend on them;
- backfill with explicit audit context when audited rows change;
- add constraints after existing data satisfies them;
- create or replace indexes with a lock-aware deployment plan;
- update RLS, grants, foreign keys, and tests together with a new tenant table;
- validate both upgrade and downgrade on a disposable copy.

## Retention, backup, and deletion

The repository does not implement a universal retention period, automated purge,
partition rotation, legal hold, or backup schedule. Do not infer one from old
design examples.

Before production growth, the service owner should define and implement:

- retention by data class and tenant agreement;
- default-partition monitoring and partition creation;
- object-store lifecycle rules that remain consistent with database references;
- encrypted backups and restore exercises;
- privileged database activity monitoring;
- a documented process for account erasure requests that preserves required
  business history without retaining unnecessary credentials.

Soft deletion is used for runtime identities and access. Immutable business
records require an explicit, reviewed retention process rather than ad hoc SQL.

## Current limitations

- `compliance` has no active rule-set table; the worker uses a versioned profile
  placeholder composed in application code.
- There is no partition-management or retention job.
- Capture-idempotency expiry is recorded but not enforced or cleaned up.
- There is no cryptographic audit hash chain or external immutable audit sink.
- There is no operator-facing DLQ query or requeue API.
- Full exception text can persist in outbox failure rows; no automatic redaction or
  retention job protects that column.
- The emitted `extraction.completed` event has no registered consumer and can
  accumulate as an unpublished row outside the worker’s claimable types.
- The temperature log has no public HTTP workflow.
- The manager single-portal rule is an application invariant, not a complete
  database cardinality constraint.
