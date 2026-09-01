# Processing pipeline architecture

This guide explains how a capture moves from durable submission to machine
extraction, human review, traceability registration, and HACCP alert creation.
The same pipeline supports the active Poissonnerie, Boucherie, and
Charcuterie/Traiteur trade profiles.

The implementation is an API process, a relay worker, PostgreSQL, and a private
object store. Pipeline stages are ordinary in-process components behind ports;
there is no fleet of autonomous agents and no runtime shared-state document.

For field behavior, see
[`../extraction/PROMPT-CONTRACT.md`](../extraction/PROMPT-CONTRACT.md). For API
operations, see [`../backend/API-CONTRACTS.md`](../backend/API-CONTRACTS.md).

## End-to-end flow

```text
client
  │ POST /v1/ingestions
  ▼
store image bytes ──> ingestion + image artifact + ingestion.raw_stored event
                                                │
                                                ▼
                                      outbox relay worker
                                                │
                 ┌──────────────────────────────┴───────────────────────────┐
                 ▼                                                          ▼
       native GS1 parsing                                            OCR provider
                                                                            │
                                                            OCR quality decision
                                                                            │
                         ┌──────────────────────────────────────────────────┤
                         │ unusable                                         │ usable
                         ▼                                                  ▼
                 GS1-only review run                               interim preview
                                                                            │
                                                                            ▼
                                                                    LLM extraction
                                                                            │
                                                             gate + reconciliation
                                                                            │
                                                                            ▼
                                                          extracted / needs_review
                                                                            │
                                                            complete human review
                                                                            │
                                                                            ▼
                                                                  review.finalized
                                                                            │
                                           ┌────────────────────────────────┴─────────┐
                                           ▼                                          ▼
                                 traceability registration                    review projection
                                           │
                               batch.registered / batch.flagged
                                           │
                                           ▼
                                       HACCP alerts
```

Machine extraction does not publish an arrival. A complete human review is the
publication boundary.

## 1. Durable submission

The submission use case validates the request, hashes the image, and writes the
bytes to the configured object store before creating database records. The
database transaction then writes:

- the ingestion with status `raw_stored`;
- an immutable image artifact reference;
- the audit record through database triggers;
- an `ingestion.raw_stored` outbox event;
- the idempotency result when an HTTP idempotency key is present.

The API returns `202 Accepted` only after the database transaction commits. A
replay of the same key and request returns the original ingestion and remains a
`202` response.

The object store and PostgreSQL cannot participate in one atomic transaction. If
the object write succeeds and the database write fails, the bytes remain durable
but may have no database reference. The repository has no garbage collector for
these unreferenced objects.

## 2. Outbox delivery

The worker polls `platform.outbox` only for event types with registered handlers.
It claims one eligible row at a time with `FOR UPDATE SKIP LOCKED`, so multiple
worker processes can drain work safely.

Delivery is at least once:

1. every consumer and the `(consumer, event_id)` processed marker run in the same
   database transaction;
2. the outbox row is marked published only after all registered consumers finish;
3. a crash before commit leaves the event available for retry;
4. a previously processed consumer is skipped on redelivery.

If a handler raises, the work transaction rolls back. A separate transaction
increments attempts and applies jittered exponential backoff. After the configured
attempt limit, the event is marked `dead_letter`. The full formatted traceback is
stored in `last_error` without a general redaction or retention pass, so it must be
treated as potentially sensitive operational data. Failures are also logged, and
the queue state can be inspected with authorized SQL. There is no HTTP or CLI
operation to list, inspect, or requeue a dead-lettered event.

## 3. Extraction consumer

`ExtractionConsumer` handles `ingestion.raw_stored`.

### Barcode first

The worker parses the scanner's raw barcode without a provider call. Supported GS1
values become deterministic candidates. Their field names are sent to the LLM as
an advisory skip list and are enforced again during reconciliation.

### OCR artifact

The worker looks for an OCR artifact under a per-ingestion advisory lock. On a
miss, it calls the OCR provider, validates the result, writes a normalized JSON
projection to object storage, and inserts the immutable artifact row.

The stored projection contains full text, mean confidence, and page. It is not the
complete verbatim Google response despite the provider port's `raw_json` name.

### OCR quality and interim data

Clearly unusable OCR skips the LLM. The worker creates a GS1-only run with outcome
`needs_review` and sets ingestion status `ocr_skipped_garbage`.

For usable OCR, a best-effort transaction may write conservative regex preview
fields and move the ingestion to `ocr_done` before the LLM call. Preview fields are
non-authoritative and do not enter publication.

### Model artifact, gate, and reconciliation

The worker deduplicates model calls by ingestion and model under an advisory lock.
On a miss, it calls the provider, validates the response, and stores a normalized
projection of fields and provenance metadata. It does not retain the complete
verbatim provider response.

The domain gate then checks field membership, confidence, exact-substring evidence,
configured vocabularies, and date consistency. Optional escalation may run once
for weak required free-text fields. Reconciliation applies GS1 precedence and
keeps conflicts visible.

The final worker transaction appends the run and fields, updates the ingestion to
`extracted`, `needs_review`, or `extraction_failed`, and emits
`extraction.completed`. An OCR garbage run retains its `needs_review` run outcome
while using the more specific ingestion status.

## 4. Provider retry and deduplication limits

Expected OCR or LLM failures are retried within the consumer's bounded provider
budget. Exhaustion is recorded as an `extraction_failed` run and the originating
outbox event is considered successfully handled. It does not enter the outbox DLQ.
Unexpected exceptions escape the consumer and follow the relay backoff/DLQ path.

Committed artifacts prevent a normal retry from calling the same provider again.
This is not exactly-once provider execution: the external response happens before
the artifact transaction commits. A crash after provider success but before commit
can repeat a billable call. The same crash window can leave a normalized artifact
object without a database row.

## 5. Human review and publication

The preferred finalization operation is
`POST /v1/ingestions/{ingestion_id}/reviews`. In one audited transaction it:

- locks the reviewable ingestion;
- validates the exact complete field set for its snapshotted profile;
- creates a new all-human extraction run;
- records explicit `NC` values for information not present on the label;
- applies the selected image rotation;
- changes the ingestion to `confirmed`;
- stores the idempotency result;
- emits `review.finalized` with tenant, store, portal, trade, user, ingestion, and
  run dimensions.

The traceability consumer accepts only `review.finalized`. It checks that the
ingestion is confirmed, every field belongs to the exact profile, every value is a
non-empty string, and every field source is human. It then creates a registered or
flagged batch and emits `batch.registered` or `batch.flagged`.

The review-projection consumer handles the same event and refreshes an existing
arrival projection. The HACCP consumer handles batch events and may append expiry
or consistency alerts according to the active database control plan.

The legacy `/confirm` operation changes the status only. It does not create a
complete human run or emit `review.finalized`, so it does not publish a new arrival.

## 6. Current event inventory

| Event | Producer | Registered consumer |
|---|---|---|
| `ingestion.raw_stored` | ingestion submission | extraction |
| `review.finalized` | complete review; legacy field override also emits it | traceability registration and review projection |
| `batch.registered` | traceability registration | HACCP alerting |
| `batch.flagged` | traceability registration | HACCP alerting |
| `extraction.completed` | extraction consumer | none in the application composition root |

The unhandled `extraction.completed` row is a current operational mismatch. The
worker claims only event types with registered handlers, so these rows remain
pending and can accumulate. Catalogue publication does not depend on them; it is
correctly driven by `review.finalized`. The obsolete event should be removed or a
clear consumer/retention policy should be implemented.

## 7. State and history

The primary implemented path uses these statuses:

```text
raw_stored
  ├─> ocr_done ─> extracted ─> confirmed
  │               └> needs_review ─> confirmed
  ├─> ocr_skipped_garbage ─> confirmed
  └─> extraction_failed
```

The domain enum and database constraint also allow `ocr_running`, `ocr_failed`,
`extraction_running`, `rejected`, and `halted_missing_context`. The current
extraction consumer does not use those states on its main path, so clients should
not infer that every allowed state has a transition implemented.

Extraction runs, fields, artifacts, processed events, and audit records are
append-only by application design and database controls. A later human correction
creates a new run. Read models select the latest attempt while history remains
available.

Runtime state is distributed across versioned PostgreSQL tables, immutable object
artifacts, and typed event payloads. No separate documentation-only shared-state
envelope is part of the runtime contract.

## 8. Tenancy, concurrency, and audit

- Every currently handled tenant-scoped event carries `organization_id`; the relay
  uses it to set transaction-local tenant context before consumers run. The
  currently unhandled `extraction.completed` exception is documented above.
- Row-level security protects tenant-owned tables in production roles.
- Per-ingestion and per-idempotency-key advisory locks serialize provider artifact,
  review, and correction races.
- Outbox rows are locked with `SKIP LOCKED` for horizontal worker concurrency.
- Database triggers require audit context for protected writes and append audit
  events in the same transaction.

These controls provide strong application-level history, not a cryptographic ledger
or protection from a fully privileged database administrator.

## 9. Operations and observability

The API liveness route confirms only that the API process can serve a request.
Readiness checks database and object-store access and hides dependency detail in
production. It does not report worker state, outbox backlog, dead-letter count, or
stale ingestions.

Worker liveness is separate: the poll loop refreshes a local heartbeat file, and
the container health command checks its age. Backlog, dead-letter, and stale-
ingestion state require authorized SQL queries. Logs expose individual processing
and retry outcomes, but they are not a queue-state inventory. The repository has
no dedicated operational API for these concerns.

Structured `extra` fields are restricted to an allow-list for identifiers,
outcomes, timings, and cache counters. The logging policy forbids raw images, OCR
text, prompts, model output, credentials, and authentication tokens. However, the
formatter also writes the log message and full exception text; it does not apply a
general redaction pass to them. Callers must sanitize exceptions, and retained
secret or personal data in those strings remains an open operational risk.

Current limits:

- readiness does not call Google Vision or Anthropic;
- there is no Prometheus or OpenTelemetry exporter;
- the repository has no measured service-level objectives or drift monitor;
- rate limiting is process-local and does not form a global multi-replica budget;
- there is no automated outbox or object-artifact retention job;
- explicit monthly partitions exist alongside default partitions, but no scheduler
  creates future partitions.

## 10. Audit findings to resolve

In addition to the unhandled completion event and provider crash windows above:

- the active Poissonnerie required-field rule set is still a provisional
  application configuration, not a compliance-owned source of truth;
- the relay holds its claimed outbox transaction while the extraction handler
  performs provider calls and separate artifact transactions, so a slow attempt
  occupies a database connection and keeps the event row locked;
- a GS1 `310x` weight is stored as a numeric string while its provenance says
  kilograms, which differs from the prompt's human-facing unit format;
- the legacy per-field override builds `review.finalized` without the portal and
  other dimensions it queried. For a portal-scoped arrival, the projection consumer
  can therefore miss the update;
- evidence grounding verifies substring presence, not the semantic correctness of a
  normalized value;
- compact prompts for Boucherie and Charcuterie/Traiteur have no checked-in quality
  parity evaluation against the detailed Poissonnerie prompt.

These are documented implementation gaps, not guarantees supplied by the pipeline.
