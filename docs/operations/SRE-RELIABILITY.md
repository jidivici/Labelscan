# Reliability and operations guide

This guide describes the operational controls that exist in the current LabelScan
repository and the work an environment must add around them. It is intentionally careful
about the difference between a design goal, an application signal, and a production
service that has been measured and tested.

Use the [deployment guide](../../deploy/README.md) for release mechanics and the
[security checklists](../security/PRE-PENTEST-CHECKLIST.md) for release evidence.
The [open-risk register](../security/THREAT-MODEL.md#confirmed-open-risk-register) is the
canonical source for confirmed blockers, impact, and required mitigation.

## Current operating baseline

| Area | Implemented in the repository | Still required from the environment |
|---|---|---|
| API health | Liveness, dependency readiness, and release-version endpoints | External probes, alert routing, maintenance suppression, and escalation ownership |
| Worker health | A heartbeat file checked by Docker | Alert delivery and a backlog detector that catches a healthy-but-ineffective worker |
| Async work | PostgreSQL outbox, concurrent row claiming, consumer deduplication, bounded retry, and dead-letter state | Backlog/dead-letter queue (DLQ) dashboards, a supported requeue procedure, and operator access controls |
| Logs | JSON lines on stdout with correlation, tenant, outcome, retry, and selected latency fields | Central collection, retention, access control, alert rules, and leak review |
| Metrics and traces | No Prometheus exporter or OpenTelemetry pipeline | Service-level indicators (SLIs), dashboards, distributed traces, and tested service-level objective (SLO) alerts |
| Release safety | CI gates, Hostinger pre-release backups, migrations, public smoke tests, and image rollback | Managed-topology automation, compatible migration policy, off-host backup, and restore exercises |
| Abuse controls | Process-local login, refresh, mutation, ingestion, and long-poll limits | Shared/edge limiting before more API processes are added |
| Mobile retry | Persistent local outbox with stable idempotency and correlation IDs | Recovery of stale `in_flight` claims and atomic reconciliation with the visible scan queue |

Do not infer a service-level objective (SLO), recovery objective, or on-call response time
from this table. Those
are service-owner decisions that require real measurements and named responders.

## Service paths and failure behavior

### Synchronous capture

The API validates an upload, writes the image to the selected raw store, and then commits
the ingestion, artifact reference, audit entry, and outbox event. It returns `202` only
after both storage layers succeed. If either dependency is unavailable, the API returns a
sanitized `DEPENDENCY_UNAVAILABLE` response and the mobile client should retry with the
same idempotency key.

Because the object write occurs before the database transaction, a database failure can
leave an unreferenced content-addressed object. This is preferable to acknowledging a
capture without its bytes, but orphan detection and safe cleanup are not automated.

### Asynchronous extraction

The worker polls PostgreSQL and handles up to a bounded batch. Multiple workers can claim
different rows safely with `FOR UPDATE SKIP LOCKED`. A consumer side effect and its
processed-event marker commit with publication of the outbox row. A crash before commit
leaves the row pending.

Unexpected consumer exceptions are retried with exponential backoff. After the configured
maximum, the row becomes `dead_letter`. OCR/LLM provider exhaustion is handled differently:
the extraction consumer records an `extraction_failed` run and consumes the event, so it
does not retry forever.

This design prevents one poison event from blocking the whole queue, but there is no
automatic operator notification, requeue endpoint, or dead-letter retention policy.

### Mobile offline work

The mobile outbox persists operation payloads and stable idempotency keys in AsyncStorage.
That improves network-retry behavior, but two crash windows remain:

- an operation is persisted as `in_flight` before the HTTP call, while drains select only
  `pending`; there is no lease or startup recovery for a stale claim, so a process kill can
  strand capture, review, or override work indefinitely;
- the durable upload operation/photo and the visible scan-queue card are not committed as
  one local transaction. Scan-queue persistence is fire-and-forget, so an immediate kill
  can leave replayable work without its expected card;
- if copying the photo into the pending document directory fails, enqueue continues with
  the original temporary URI. The operating system may purge that file after a restart,
  leaving a durable outbox record whose image can no longer be read.

Until those gaps are fixed and tested with process-kill scenarios, do not claim that local
enqueue/replay is atomic or that the client cannot lose visible pending work.

Two account-boundary risks also affect recovery. Ownerless legacy operations are treated
as replayable, so an old `create_ingestion` can be sent with a later user's JWT and enter
that tenant. Newer ownership metadata contains only portal and trade, so two different
managers in the same portal also match and the later JWT supplies the wrong audit actor.
The persisted catalogue also uses a global cache key and is not explicitly
removed before cold-start hydration. Never recover queued work or cached data under a new
identity unless ownership is proven; quarantine ambiguous entries and clear or partition
the persisted cache.

## Health endpoints

| Probe | Meaning | What it does not prove |
|---|---|---|
| `GET /v1/health/live` | The API process can answer HTTP | Database, raw store, workers, providers, or business correctness |
| `GET /v1/health/ready` | The API can run `SELECT 1` and the selected raw-store health check | OCR/LLM availability, worker progress, DLQ state, backup health, or client reachability |
| `GET /v1/version` | The running build identity and active rule-set version | That every replica or client is on the same release |
| worker container health | The poll loop refreshed its heartbeat recently | That events are completing, providers are healthy, or backlog age is acceptable |

Production readiness hides dependency names and returns a generic 503 problem response
when a check fails. The worker heartbeat freshness window is configurable; the Claude
request timeout is currently fixed at 120 seconds. Alert on state transitions rather than
probing so aggressively that the probes become load.

The repository includes an active public security probe for an explicitly approved
release target:

```bash
npm run security:production -- https://reviewed-target.example
```

Run it from outside the deployment after authorization. It sends network requests,
including a synthetic login attempt and an oversized anonymous upload. The helper falls
back to the public production origin when no URL is supplied, so always pass the exact
reviewed target. It checks a useful public subset, not data integrity, provider behavior,
tenant isolation with real accounts, or restore readiness. Follow the
[production validation guide](../security/PRODUCTION-VALIDATION.md) for the complete gate.

## Logs and correlation

The API and worker write JSON lines to stdout through `labelscan.platform.observability`.
The formatter accepts only a fixed list of structured fields, including correlation/trace
IDs, organization ID, ingestion/run IDs, outcome, retry timing, provider latency, model ID,
and selected counts.

Important limits:

- `trace_id` is correlation metadata propagated through requests and outbox events. It is
  not an OpenTelemetry span or a distributed trace.
- The allow-list reduces accidental structured-field leakage, but exception tracebacks and
  explicitly allowed `error` strings are still emitted. There is no automatic secret or
  personally identifiable information (PII) redaction filter.
- A dead-letter row stores the full Python traceback in `platform.outbox.last_error`.
  Database access and retention must account for that content.
- Raw images, OCR text, prompts, tokens, passwords, and provider response bodies must not
  be added to logs. Verify this with representative failures, not only code review.

At minimum, central logging should support searches by release, correlation ID,
organization, ingestion ID, and these existing messages:

- `api_error` and `unhandled_exception`;
- `rate_limited`;
- `event_retry_scheduled` and `event_dead_lettered`;
- `extraction_failed`, `extraction_persisted`, and `extraction_timing`;
- `interim_persist_failed`;
- `evidence_gate_reject_total` and `ocr_skipped_garbage_total`;
- `llm_cache_usage`, `llm_escalation_total`, and `llm_escalation_failed`.

Names ending in `_total` are currently log messages, not exported counters.

## Manual database checks

Use a read-only operational connection scoped to the intended organization where RLS
applies. Never paste a production URL or secret into a ticket or shell history.

### Outbox and dead letters

This query shows queue state and the oldest row in each state:

```sql
SELECT status, count(*) AS rows, min(created_at) AS oldest_created_at
FROM platform.outbox
GROUP BY status
ORDER BY status;
```

This query lists unpublished work without returning payloads or stored tracebacks:

```sql
SELECT id, event_type, status, attempts, created_at, next_retry_at
FROM platform.outbox
WHERE published_at IS NULL
ORDER BY created_at
LIMIT 100;
```

Do not change `dead_letter` rows directly during an incident. First determine whether the
consumer is idempotent for that event, preserve the event and error evidence, validate a
requeue in an isolated environment, and use a reviewed runbook. The repository does not
currently provide that runbook or command.

### Stalled ingestions

This view helps find old non-terminal captures without exposing extracted values:

```sql
SELECT status, count(*) AS rows, min(server_received_at) AS oldest_received_at
FROM ingestion.ingestion
WHERE status NOT IN ('extracted', 'confirmed', 'rejected', 'extraction_failed')
GROUP BY status
ORDER BY status;
```

Interpret the result with the outbox state and worker logs. `needs_review` and
`ocr_skipped_garbage` may represent safe human-work queues rather than infrastructure
failure.

## Release and rollback

### Managed topology

The repository validates the Compose shape in CI but does not deploy it. The platform
owner must build a digest-pinned release path, provide separate migration/runtime database
credentials, gate startup on migrations, keep one API process, and implement rollback and
restore. The current Compose file's shared database secret is an open release blocker for
least-privilege production.

### Hostinger topology

The Hostinger workflow revalidates the exact commit, then calls a root-owned wrapper on a
self-hosted runner. The deploy script creates a database dump and raw-image archive,
installs the reviewed contracts, applies migrations, starts one API and four workers, and
runs public smoke tests.

Its automatic rollback restores the previous Compose/Caddy contracts and images. It does
not reverse migrations. Releases must keep the previous application compatible with the
new schema for the rollback window. A demo reset is exceptional: if it fails after data
replacement starts, recover from a coherent VPS snapshot rather than mixing old code and
new data.

## Backup and recovery

The Hostinger deploy script keeps recent PostgreSQL dump and raw-image archive files under
`/opt/labelscan/backups`. These files are mode `0600` and useful for release rollback, but
they share the VPS failure domain and are not continuous recovery.

A production backup design still needs:

- encrypted off-host copies with independently controlled credentials;
- retention and deletion rules approved by product/legal owners;
- a defined recovery point objective (RPO) and recovery time objective (RTO) based on
  business needs;
- restore of PostgreSQL and the matching raw-image set into an isolated environment;
- row-count and checksum validation plus an authenticated application smoke test;
- evidence that backup credentials and restored personal data are removed afterward.

The managed topology must provide equivalent database and object-store recovery through
its infrastructure. Startup validation of S3 and its Key Management Service (KMS) settings
does not prove bucket versioning, replication, or restore capability.

## Incident starting points

### API is not ready

1. Confirm whether liveness also fails. A dead process and a dependency failure require
   different responders.
2. Correlate the first readiness transition with deployment, database, raw-store, and host
   events. Production HTTP intentionally hides the failed dependency.
3. Stop rollout promotion. Avoid restarting repeatedly before preserving logs and the
   release identity.
4. Restore service using the topology-specific rollback rules. Do not downgrade the
   database ad hoc.

### Worker is healthy but work is old

1. Compare pending/dead-letter age with the worker heartbeat and `event_*` logs.
2. Check database saturation and provider errors without exposing event payloads.
3. Scale workers only after confirming the database/provider can accept the load. Worker
   concurrency is supported; API concurrency has a separate process-local limit problem.
4. Do not blindly requeue dead letters. Fix or isolate the cause first.

### Suspected raw-image or audit loss

1. Treat any confirmed mismatch as a high-severity integrity incident.
2. Freeze releases and destructive cleanup.
3. Preserve database, object/volume, logs, release identity, and backup evidence.
4. Compare immutable references and checksums from a controlled read-only process.
5. Involve security/privacy owners if personal or regulated records may be affected.

There is no continuous repository job that proves every acknowledged image remains
readable or every expected transition has an audit row. A manual sample is evidence only
for the sampled records.

On the single-VPS profile, a successful filesystem read also does not recompute the
expected SHA-256. Until OR-15 is fixed, a path can be readable while its bytes are corrupt.
Integrity sampling should calculate the hash independently and treat any mismatch as the
same high-severity incident as a missing image.

Two forms of evidence are also incomplete even when their rows are readable. Provider
history contains reduced OCR/LLM projections rather than the complete envelopes, geometry,
and per-token confidence described by ADR-0003. Audit rows identify the actor, action,
subject, time, correlation, and trace, but do not reference before/after snapshots. Preserve
the available rows, provider-side evidence where policy permits, and related business
history; do not claim exact provider-response or mutable-state reconstruction during the
incident. OR-17 and OR-18 define the required remediations.

### Mobile work is stuck or missing from the queue

1. Preserve the device's outbox and scan-queue state before signing out, clearing storage,
   reinstalling, or deleting a pending scan.
2. Look for `in_flight` operations whose `updated_at` predates the app process. There is no
   safe automatic lease recovery in the current implementation.
3. Check the server with the stable idempotency key before deciding whether to retry; an
   HTTP request may have committed before the client died.
4. Escalate for a reviewed recovery path rather than editing AsyncStorage manually on a
   production device.

### Mobile account changed with local data present

1. Stop automatic drains and preserve only the evidence required by the incident policy.
2. Do not replay an ownerless legacy operation under the new session. Quarantine it until
   trustworthy ownership can be established; `create_ingestion` has no previous server
   tenant for the API to compare.
3. Do not treat a matching portal/trade as proof of ownership. Compare the server actor ID;
   two managers can share the same portal.
4. Remove the persisted catalogue for the previous identity before allowing hydration,
   then verify that the in-memory client and disk persister are both empty.
5. Inspect the document directory for residual JSON/CSV exports and remove them from the
   device and known share destinations after preserving necessary evidence.
6. If token-bearing catalogue metadata may have been present, follow the token-exposure
   response below and revoke the affected session family.

### Token may have been exported from mobile

Article photo metadata currently carries an authorization header into the persisted
catalogue cache and JSON export. If an export was shared or device storage was exposed,
revoke the affected session family, remove the exported file from every destination,
preserve incident evidence, and review access logs. JWT expiry limits the access-token
lifetime but does not make an exported token harmless while valid.

## Defining service objectives

No measured production SLO is implemented in this repository. Before publishing targets,
collect a representative baseline and agree on user outcomes, exclusions, window, owner,
and alert response. Useful service-level indicator (SLI) candidates are:

- accepted ingestions divided by valid authenticated attempts;
- time from capture submission to `extracted`, `needs_review`, or a loud terminal failure;
- latency and availability of authorized catalogue reads;
- oldest pending outbox age and dead-letter creation rate;
- acknowledged images later proven readable with the expected checksum;
- business transitions with their expected same-transaction audit evidence;
- mobile operations that remain `in_flight` beyond a process lifetime.

Avoid a fixed target copied from a design document. A percentage without measurement,
traffic shape, and an on-call policy is not an operational control.

## Known reliability gaps

The [open-risk register](../security/THREAT-MODEL.md#confirmed-open-risk-register) owns the
complete impact and remediation record. For operations, the main consequences are:

- **Work can become invisible or stranded:** mobile claims and local durability need
  recovery (`OR-04`, `OR-05`), while the worker heartbeat proves loop activity rather than
  useful progress.
- **Account changes are not a safe local-state boundary:** queued work and catalogue state
  have unresolved ownership/isolation gaps (`OR-02`, `OR-03`, `OR-16`).
- **Capacity and retention need active controls:** mobile exports and shared AsyncStorage
  are not bounded or cleaned up for a defined workload (`OR-07`, `OR-19`).
- **Environment resilience remains external:** VPS egress, off-host backups, and storage
  integrity require controls beyond the current Compose health checks (`OR-09`, `OR-10`,
  `OR-15`).
- **Detection and reconstruction are incomplete:** backlog alerting, provider evidence,
  and before/after audit reconstruction remain open (`OR-12`, `OR-17`, `OR-18`).

Prometheus/OpenTelemetry, automated SLO evaluation, tested on-call routing, provider quota
and cost alarms, and continuous extraction-quality monitoring do not ship with the
repository. Functional tests do not replace labeled-data calibration or live operational
evidence.
