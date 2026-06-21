# LabelScan — SRE: Reliability, Observability & Operations Strategy

**Phase:** Partially implemented (structured logging + worker heartbeat done; metrics/SLO instrumentation pending)
**Author role:** Site Reliability Engineer
**Scope:** `LabelScan/` backend (modular monolith, Python/FastAPI, PostgreSQL) + async extraction worker.
**Date:** 2026-06-18 (updated from 2026-06-14 design)

**Implemented so far:**
- Structured JSON logging (`platform/observability.py`)
- Correlation/trace middleware (`CorrelationMiddleware`)
- Outbox worker heartbeat + compose healthcheck
- DLQ with exponential backoff (migration 0009)

**Not yet implemented:**
- Prometheus/OTel metrics + SLO instrumentation
- Per-principal rate limits
- Dead-man's switch / stuck-run detector
- Capacity / provider rate-limit calibration

## 0. How this fits the existing design (read first)

This document **extends** `docs/backend/BACKEND-ARCHITECTURE.md §10` (Observability) and §10.4 (SLO seeds);
it does not restate it. It is consistent with: the async queue-backed extraction (sync ingestion →
202 after the **raw artifact is durably stored**, then OCR+LLM in a worker via a transactional
**outbox + bus**); `correlation_id`/`trace_id` everywhere; the RFC 9457 **stable error-code catalog**
(BACKEND §5.2); the append-only **audit log** (ADR-0004); **raw-before-normalized immutability**
(ADR-0003); the **LLM validation gate** as the no-fabrication trust boundary (BACKEND §8.2,
AI-PIPELINE §6); `ExtractionFlaggedForReview` driving human review with **no auto-approve on
timeout**; and the per-dependency timeout/retry/circuit-breaker/DLQ policy (BACKEND §9).

The four non-negotiables that shape everything below: **audit-ready at all times · zero data loss ·
silent failures (esp. OCR/LLM) must be detectable · traceability reads stay available under load ·
alerting is reliable and does not spam.**

> Capacity figures in §8 are **ASSUMED** and labelled as such — they exist to derive a starting
> envelope, not to assert facts. Replace with measured data before any go-live sizing decision.

---

## 1. SLO definitions

SLIs are defined as good-events / valid-events ratios, instrumented at the stated point, measured
over a rolling **28-day** window unless noted. Each is tied to a real user/business outcome, not a
machine vanity metric. The sync **ingestion path** (a counter clerk capturing a label, or a device
queue flushing) is held to a stricter availability + durability bar than the async **extraction
path** (which the user does not block on — they get a 202 and results appear shortly after).

### SLO-1 Ingestion availability (sync capture path)
- **SLI:** `count(POST /v1/ingestions responses that are 2xx) / count(POST /v1/ingestions − responses that are 4xx-except-429)`. Measured at the HTTP edge (server-observed), after excluding client-fault 4xx (a malformed capture is not our unreliability) but **including 429** (we rate-limited a legitimate capture → that *is* user-impacting).
- **Target:** **99.9%** / 28 days. Error budget = 0.1% ≈ **40 min/28d** of allowed failed-capture time-equivalent.
- **Why it's real:** if capture fails, the operator cannot record the label at the counter — work stops or (worse) is done on paper and never enters traceability. This is the front-line user experience.

### SLO-2 Latency
Split by path because the user's tolerance differs sharply.
- **SLI-2a Ingestion submit latency:** `count(POST /v1/ingestions with server-duration < 1.5 s) / count(all non-4xx submits)`; **p95 < 1.5 s, p99 < 3 s**. Dominated by the object-store PUT (raw image) which must complete before 202 (durability-first, §SLO-3). Instrumented as a duration histogram on the route.
- **SLI-2b Read/traceability latency:** `count(GET trace/lookup/audit with duration < 200 ms) / count(all)`; **p95 < 200 ms, p99 < 500 ms**. This is the **"traceability available under load"** constraint expressed as a number — an auditor or recall investigator pulling a lot's chain must get it fast even during peak capture.
- **Target window:** 28 days. **Why:** sub-1.5s keeps the capture loop fluid; sub-200ms reads keep traceability usable during an active recall (the highest-stakes read moment).

### SLO-3 Data integrity (the budget is effectively zero)
Two SLIs, both treated as **near-1.0, page-on-any-breach** rather than budgeted:
- **SLI-3a Raw-artifact durability:** `count(ingestions returning 202 whose raw artifact is later confirmed readable + checksum-valid in the object store) / count(ingestions returning 202)`. A 202 is a **promise of durability**; breaking it is the cardinal sin. **Target: 100% (zero loss).** Verified continuously by the durability-audit job (§10).
- **SLI-3b Audit completeness:** `count(business-critical state transitions that produced exactly one matching append-only audit row) / count(business-critical state transitions)`. **Target: 100%.** A confirmed extraction, batch creation, alert transition, override, etc. with **no** audit row means the system is no longer audit-ready — which violates the prime directive.
- **Why:** this is a HACCP/traceability system. A lost raw label or a missing audit entry is not "degraded service" — it is a **compliance failure** that can invalidate a recall investigation. Hence it is not budgeted (see §2).

### SLO-4 Pipeline success rate (async extraction path)
- **SLI-4a Extraction completion:** `count(ingestions reaching a terminal-good state {extracted | needs_review} within 5 min) / count(ingestions submitted)`. A `needs_review` outcome **counts as success** — flagging for a human is the correct, designed behavior, not a failure. Only `*_failed` (unparseable, provider-exhausted, refusal-with-no-recovery) and **stuck/never-terminal** count against it.
- **Target:** **≥ 99%** reach a terminal state within 5 min; of those, **≥ 95%** reach `extracted`/`needs_review` (≤ 5% hard-fail). Two numbers because "got stuck forever" (a reliability bug) is worse than "failed loudly and was flagged" (working as designed).
- **SLI-4b Extraction freshness:** p95 submit→result-available **< 60 s**.
- **Why:** stale or stuck extraction means traceability records aren't being created from captures — silent erosion of coverage. The split deliberately does **not** penalize the design's safe behaviors (flag-for-review, fail-loud-and-retain-raw); it penalizes silent loss and indefinite hangs.

> **Calibration note (measure before committing):** these targets are *initial*. Before declaring
> them contractual, run 2–4 weeks of baseline measurement (per the "measure before optimizing"
> rule). Each added nine costs ~10× — do not buy 99.99% ingestion availability without data showing
> the business needs it.

---

## 2. Error-budget policy

Lead with the data: a release decision is "how much budget remains vs how much of the window
remains," not a gut call.

### 2.1 Budgeted SLOs (availability, latency, pipeline success)
Per SLO, per 28-day window:

| Budget consumed | Window elapsed | Policy |
|---|---|---|
| < 50% | any | **Ship freely.** Budget is funding velocity — spend it. |
| 50–90% | budget burning ≤ proportional to time | Ship, but **canary every change** and watch burn (§7). |
| 50–90% | burning **faster** than the window elapses (projected exhaustion before window end) | **Soft freeze:** only low-risk / reliability changes; every change requires a named reviewer + canary hold at each stage. |
| ≥ 90% | any | **Feature freeze.** All engineering effort on that SLO's reliability until burn is back under control. Exceptions require explicit sign-off (eng lead + product) recorded as a decision. |
| 100% (exhausted) | any | **Hard freeze + incident.** Reliability work only; postmortem; do not resume feature releases until a credible fix has restored headroom. |

**Who decides:** the on-call SRE owns the freeze trigger (it's mechanical — driven by the burn
dashboard); lifting a freeze early requires eng-lead sign-off recorded in the incident channel.
Blameless: a freeze is the system telling us where to invest, not a punishment.

### 2.2 The data-integrity SLO is NOT budgeted
SLO-3 (raw durability, audit completeness) has an **effectively-zero budget** and is treated
categorically differently:
- There is **no "we can afford to lose 0.1% of raw labels."** Any confirmed loss or audit gap is a
  **SEV1** (§6), pages immediately, and **auto-freezes all releases** regardless of other budgets.
- Releases that touch ingestion-durability, the outbox, the raw store, or the audit-write path get
  **extra gates** (durability verification in canary, see §7) precisely because their failure
  spends a budget we don't have.
- Trade-off, stated plainly: we accept **higher ingestion latency** (synchronous object-store PUT
  before 202) and more operational rigor to buy zero raw-loss. Reliability of the *promise* beats
  speed of the *ack*.

### 2.3 Interaction with rollouts
A canary stage **cannot be promoted** while the relevant SLO is in soft/hard freeze; promotion gates
(§7) read the same burn signals. This couples "is it safe to ship" to "do we have budget" by
construction, rather than leaving it to judgment under pressure.

---

## 3. Observability design (extends BACKEND §10)

BACKEND §10 already defines: JSON logs with `correlation_id`/`trace_id`/`span_id`/`principal` +
stable log codes; RED-per-route + USE-per-resource metrics; OTel traces across the async hop; and
the initial SLO/alert seeds. This section **adds** the domain-specific layer an SRE needs to detect
*silent* failure and to answer questions before they're asked.

### 3.1 Metrics — golden signals + domain-specific (additions)
Golden signals (latency/traffic/errors/saturation) are covered by RED/USE in §10.2. Add these
**domain metrics** (all labelled by `extractor_version`, `prompt_version`, `ocr_provider`,
`llm_model` so a version change is filterable):

| Metric | Type | Why it exists (what silent failure it exposes) |
|---|---|---|
| `pipeline_stage_outcome_total{stage,outcome}` | counter | Per-stage success/fail/skip across preprocess→ocr→quality-gate→llm→validate→persist. Pinpoints *which* stage regressed. |
| `extraction_confidence` | histogram | Combined per-field confidence distribution. A **downward shift = silent extraction-quality degradation** (drift) even while success-rate looks fine. |
| `extraction_review_flag_total{reason}` | counter | `ExtractionFlaggedForReview` by reason (missing-required / low-confidence / ambiguous / validation-fail / security). Rising = upstream OCR/label/model problem. |
| `extraction_autoaccept_ratio` | gauge | Fraction auto-accepted vs sent to review. A **sudden jump** can mean a miscalibrated/too-lax threshold (false confidence); a **drop** means quality fell. Both are silent-failure signals. |
| `llm_refusal_total` | counter | `stop_reason:"refusal"` count. A spike = provider policy false-positives blocking legitimate labels. |
| `evidence_gate_reject_total` | counter | No-fabrication gate hits (value not tied to raw OCR → coerced null). **This is the hallucination detector** (§5). |
| `ocr_confidence` / `ocr_skip_garbage_total` | histogram / counter | OCR quality + how often the cost-saver gate skipped the LLM on garbage input. |
| `llm_tokens_total` / `llm_cost_estimate` / `llm_latency` | counter / counter / histogram | Cost & latency per model — feeds capacity + the cost trade-off (§11). |
| `review_queue_depth` / `review_queue_oldest_age` | gauge | Human-review backlog. Depth growth + age = reviewers underwater (operational, and a compliance lag). |
| `outbox_lag` (unpublished rows, oldest age) | gauge | The single most important **stuck-pipeline** signal (§5.4). |
| `dlq_depth` / `dlq_oldest_age` | gauge | Dead-lettered events — work that failed repeatedly and is parked, never dropped. |
| `idempotency_replay_total` | counter | Replays (client retries). A spike can indicate client-side or network trouble. |
| `circuit_breaker_state{dependency}` | gauge (0/1) | OCR/LLM/DB/object-store breaker open = degraded dependency. |
| `audit_write_failures_total` | counter | **Pages on > 0** — see §3.4. |

### 3.2 Logs (additions)
Keep §10.1's structure. SRE-specific requirements:
- **Redaction is enforced, not hoped for:** a logging filter strips tokens, device secrets, raw
  provider payloads, and PII (label text may contain a supplier/person name) before emit. Raw OCR
  text is referenced by `raw_artifact_id`, **never inlined** into logs.
- Every silent-failure detector (§5) emits a **stable log code** (e.g. `EXT_EVIDENCE_REJECTED`,
  `EXT_STUCK_RUN`, `ING_DURABILITY_UNVERIFIED`) so detectors are queryable and alertable by code,
  not by regex on free text.
- Log-based metrics are a fallback only; prefer real metrics for alerting (lower cardinality, cheaper).

### 3.3 Traces (additions)
§10.3 connects the trace across the outbox. Add required **span attributes** so a trace answers
"why is this extraction slow/wrong" without a code dive:
- Ingestion span: `ingestion_id`, `image_checksum`, `idempotency_key`, `object_store_put_ms`, `raw_appended:true`.
- Worker root span: `extraction_run_id`, `extractor_version`, `prompt_version`.
- OCR span: `ocr_provider`, `ocr_confidence_mean`, `ocr_skip_garbage:bool`, retry count, breaker state.
- LLM span: `llm_model`, `tokens_in/out`, `effort`, `stop_reason`, `repair_attempts`, cost estimate.
- Gate span: `evidence_rejects`, `required_missing[]`, `low_confidence[]`, `validation_status` summary, `outcome` (extracted/needs_review/failed).
- **Exemplars:** link trace IDs from the latency-histogram buckets so one click on a p99 spike opens a representative slow trace.

### 3.4 The audit-write path is special
Audit completeness (SLO-3b) is a prime directive. If an audit write fails, the business action it
describes **must not be silently committed without its record**. Design stance (cross-ref BACKEND
§12, DATABASE §3): the business write and its audit append are committed in the **same DB
transaction** where possible (same Postgres instance), so they succeed or fail together — there is
no window where the action lands but the audit doesn't. Where an audit derives from an event
(async), the consumer is idempotent on `event_id` and its failure parks in the DLQ and **pages**.
`audit_write_failures_total > 0` is a paging alert.

---

## 4. Alerting strategy

Two disjoint alert classes that are frequently conflated — keeping them separate is itself a
reliability decision. **Anti-spam is a hard constraint**, so every alert below specifies grouping,
a `for:` duration, and inhibition.

### 4.1 DOMAIN / business alerts — HACCP product alerts (NOT ops alerts)
These are **outputs of the system**, raised by the HACCP context as first-class domain objects
(the `Alert` aggregate), routed to **fishmongery operators/supervisors** in-app, not to the SRE
on-call. They are a product feature; the SRE concern is that the alerting *machinery is reliable*.

| Alert | Condition | Severity (business) | Route | Reliability requirement |
|---|---|---|---|---|
| **Expiry alert** | `use_by` within plan window (or passed) for a tracked batch | per ControlPlan | in-app to supervisor/fishmonger | Must fire **once, on time** — the scan that detects it runs on schedule; the scan job itself is monitored as an ops concern (§4.2 "scheduled-job missed"). |
| **Temperature breach** | logged `temp_c` outside the active ControlPlan threshold | high | in-app + supervisor escalation | Same — the breach evaluation must run; a missed evaluation is an **ops** failure (it could hide a real food-safety breach). |

**The distinction that matters:** a temperature breach is a *food-safety* event for the operator; a
*failure to evaluate temperature logs* is an *SRE* event (§4.2) because it silently suppresses
food-safety alerts. We monitor the **reliability of the alert pipeline** (did the scan run? did the
alert get delivered + acknowledged?) as ops, while the alert content goes to operators.

**Anti-spam for domain alerts:** one open `Alert` per (batch, rule) — re-evaluation does **not**
raise a duplicate; it updates the existing open alert (the `Alert` lifecycle `open → ack →
resolved` enforces this). Escalation only if unacknowledged past SLA. This is enforced in the
domain model, not the alert router.

### 4.2 OPERATIONAL / SRE alerts
Routed to the on-call. Symptom-based (alert on user-visible/budget impact, not on every internal
cause), with explicit anti-spam.

| Alert | Condition | Severity | Anti-spam design |
|---|---|---|---|
| **SLO burn (availability/latency)** | multi-window multi-burn-rate (see §4.3) | page (fast) / ticket (slow) | The MWMBR method *is* the anti-spam: fast+slow windows must **both** breach → no flapping on a single blip. One alert per SLO, grouped. |
| **Pipeline hard-fail rate** | `*_failed` ratio (SLI-4a) > 5% `for: 10m` | page | grouped by `extractor_version`; inhibited if "LLM breaker open" is already firing (don't double-page for one root cause). |
| **Outbox lag / stuck pipeline** | `outbox_lag` oldest-age > 2 min `for: 5m`, or runs in non-terminal state > 10 min | page | single alert keyed on the lag gauge; auto-resolves when drained. |
| **DLQ growth** | `dlq_depth` increasing `for: 15m` or `dlq_oldest_age` > 1 h | ticket→page if growing | one alert; links the DLQ replay runbook. |
| **Provider breaker open** | `circuit_breaker_state{dep=ocr|llm} == 1` `for: 2m` | page | one per dependency; **inhibits** the downstream "pipeline hard-fail" page (root-cause grouping). |
| **Object-store PUT failures** | error-rate on raw PUT > 0.5% `for: 2m` | page (data-loss risk) | high priority — capture durability at risk (R9). |
| **Audit-write failure** | `audit_write_failures_total > 0` | **page immediately, no `for:`** | never debounced — a compliance-integrity signal. Dedup by error signature. |
| **Raw-durability verification gap** | durability-audit job finds a 202 with no readable/checksum-valid artifact | **SEV1 page** | dedup by `ingestion_id`. |
| **Review queue underwater** | `review_queue_oldest_age` > SLA `for: 30m` | ticket | business-ops + SRE; grouped. |
| **Scheduled-eval missed** | expiry/temperature scan didn't run on schedule | page | dead-man's-switch (alert on **absence** of the heartbeat), so a silently-dead scan is caught. |
| **Cost anomaly** | `llm_cost_estimate` daily run-rate > N× baseline | ticket | one daily alert; protects the budget (§11). |

### 4.3 Multi-window multi-burn-rate (the core anti-spam mechanism)
For each budgeted SLO, two paired burn-rate conditions (Google SRE workbook pattern):

- **Fast / page:** burn-rate ≥ **14.4×** over a **5 min** window **AND** ≥ 14.4× over **1 h** (would exhaust 28-day budget in ~2 days if sustained). Pages.
- **Slow / ticket:** burn-rate ≥ **6×** over **30 min** **AND** ≥ 6× over **6 h**. Tickets (no page).

Requiring **both** the short and long window to breach is what kills false pages: a transient 5-min
spike that the 1-h window doesn't corroborate never pages. Alerts auto-resolve when burn returns to
nominal. This is the single biggest lever for "reliable, doesn't spam."

### 4.4 Global anti-spam policy
- **Grouping** by (alertname, service, dependency) — one notification per group, not per firing series.
- **Inhibition** — a root-cause alert (breaker open, DB down) suppresses its known downstream symptom alerts.
- **`for:` durations** on everything except integrity/audit pages (which fire immediately by design).
- **Escalation, not repetition** — unacked page escalates to secondary after N min rather than re-paging the same person repeatedly.
- **Maintenance windows / silences** for planned deploys + migrations.

---

## 5. Failure detection (catching the *silent* ones)

The design's whole point is that OCR/LLM failures are caught rather than trusted. Each detector:
signal → threshold → action → tie-in.

### 5.1 OCR errors
- **Provider error / timeout:** `OcrPort` returns error or exceeds the 10s budget (BACKEND §9.1) → run `ocr_failed`, retried by the job (raw image already durably stored — no loss), breaker on repeated failure → `DEPENDENCY_UNAVAILABLE`/`provider_degraded`. Metric: `pipeline_stage_outcome_total{stage=ocr,outcome=fail}`.
- **Garbage / unreadable input:** OCR-quality gate verdict `skip_garbage` or `ocr_confidence` below floor → **LLM is skipped** (cost saver) and the run goes to `needs_review` with reason `unreadable` (eval E05). Detector signal: `ocr_skip_garbage_total` rising = camera/lighting/label-stock problem at a store. **Silent-failure guard:** a sudden rise here would otherwise quietly inflate the review queue — alerting on it surfaces the field problem.

### 5.2 LLM hallucinations (the trust boundary)
- **Primary detector — evidence-substring gate:** every non-null value must tie back to a span in the **stored raw OCR**; one that doesn't is coerced to `null/unverifiable` and counted in `evidence_gate_reject_total` (BACKEND §8.2.2, eval E15). A **rising reject rate = the model is fabricating more** — drift or a bad prompt/model version. Ties to `ExtractionFlaggedForReview` (required field nulled → review).
- **Confidence miscalibration:** monitor calibration (ECE) of reported vs realized correctness against the human-review/override ground truth (AI-PIPELINE §4). ECE creeping up, or `extraction_autoaccept_ratio` jumping without a quality basis, signals the model is **confidently wrong** — the most dangerous silent failure. Fires a drift ticket + can trip the **force-all-to-review kill-switch** (§7) if severe.
- **Refusal:** `stop_reason:"refusal"` → handled as extraction failure → retain raw → flag for review → **never fabricate**. `llm_refusal_total` spike pages (provider policy false-positives blocking legitimate labels).
- **Drift:** AI-PIPELINE §9 input/output/confidence drift monitors run continuously; drift never auto-changes anything — it raises a ticket and triggers a cross-model eval before any change ships.

### 5.3 Partial or missing data
- Required-field nulls / below-threshold → `REQUIRED_FIELD_MISSING` / `LOW_CONFIDENCE_FIELD`, ingestion `needs_review`, `ExtractionFlaggedForReview{reason}`. This is **designed behavior, not a failure** — but a **rising rate** for a given field/supplier/store is a detector (label format changed? OCR region wrong?). Metric: `extraction_review_flag_total{reason=missing_required}` by field.
- **Incomplete runs:** a run that produced *some* fields then errored is marked failed as a whole and retained — never persisted as a silently-truncated partial (no partial-merge, eval E20/E21).

### 5.4 Stuck pipelines (the classic silent killer)
- **Outbox lag:** unpublished outbox rows older than 2 min → page. The outbox is the canonical "work accepted but not progressing" signal.
- **Non-terminal runs past SLA:** any `extraction_run` not in a terminal state after 10 min → flagged, investigated, re-enqueued (idempotent on `event_id`, no double-processing). A run that's been "in progress" forever is the worst case — it's *invisible* without this detector.
- **Worker liveness:** worker heartbeat + queue-consumption rate; **dead-man's-switch** alert on absence of heartbeat (alerting on silence, not just on errors). If the worker dies, ingestion still succeeds (202) and raw is stored — but extraction silently stops; this detector catches that within minutes.
- **Scheduled scans (expiry/temperature):** dead-man's-switch on the scan heartbeat — a silently-dead scan would suppress food-safety alerts (§4.2).

**Theme:** every detector that matters alerts on **absence/staleness**, not only on error counts —
because the failures this system most fears are silent.

---

## 6. Incident response

Severity is set by **SLO/integrity impact**, not gut feeling.

| Sev | Definition (mapped to THIS system) | Examples | Response target | MTTR target |
|---|---|---|---|---|
| **SEV1** | Data loss or audit-integrity compromise; or core capture/traceability fully down | confirmed raw-artifact loss (SLO-3a breach); audit-write failing / immutability-trigger violation alarm; ingestion submit hard-down; traceability reads down org-wide during a recall | **page < 5 min**, all-hands | **mitigate < 1 h**, full resolve ASAP, mandatory postmortem |
| **SEV2** | Major SLO breach, user-impacting, no data loss | ingestion availability/latency burning fast (MWMBR page); extraction backlog growing unbounded; OCR/LLM breaker open & not recovering; review queue critically underwater | page < 15 min | mitigate < 4 h |
| **SEV3** | Degraded / partial, contained | elevated hard-fail rate within a version; DLQ growing slowly; single-store OCR-quality problem; cost anomaly | ticket, business-hours page if worsening | < 1 business day |
| **SEV4** | Minor / single-record | one bad extraction caught by the gate and flagged; a single device misbehaving | ticket | best effort |

Notably: **a single bad extraction is SEV4, not an incident** — the system caught it (flagged for
review), which is the design working. **Systemic** bad extraction (rising `evidence_gate_reject` /
miscalibration) is SEV2/3. We escalate on *patterns*, not on the designed safe-fail of one record.

**On-call & culture:** primary on-call + escalation to secondary then eng-lead; **blameless**
postmortems for all SEV1/SEV2 focused on systemic fixes (the freeze/budget mechanism, not a person);
track **MTTR** (and MTTD — mean time to *detect*, which the §5 silent-failure detectors directly
improve).

### Runbooks (detect → diagnose → mitigate → verify → postmortem)

**RB-1 — Extraction worker backlog / outbox lag growing**
- *Detect:* `outbox_lag` page or extraction-freshness SLO burn.
- *Diagnose:* check worker liveness (heartbeat), `circuit_breaker_state{llm,ocr}` (provider degraded?), DLQ depth, DB pool saturation. Open the slowest worker trace via exemplar.
- *Mitigate:* if provider breaker open → confirm provider status, let breaker half-open probe; if worker undersized → scale worker concurrency/replicas; if a poison message is wedging a partition → quarantine it to DLQ so others flow. Ingestion is **unaffected** (202 + raw stored) throughout — communicate that captures are safe, only results are delayed.
- *Verify:* lag drains to < 2 min, freshness p95 back < 60 s, no DLQ growth.
- *Postmortem:* was it capacity (update §8 sizing), provider (adjust breaker/timeout), or a poison-message class (add a guard + eval case)?

**RB-2 — Suspected raw-artifact write failure / data-loss risk (SEV1)**
- *Detect:* object-store PUT failure alert, or durability-audit job finds a 202 with no valid artifact.
- *Diagnose:* object-store health/credentials/quota; was a 202 ever returned without a confirmed PUT? (it must not be — verify the ordering invariant held). Pull the ingestion trace: `object_store_put_ms`, `raw_appended`.
- *Mitigate:* if object store is down → ingestion should already be returning `503 DEPENDENCY_UNAVAILABLE` (so clients' durable queue retries — no loss); if 202s are being returned without durable PUT, **that is the bug** — kill-switch the ingestion path to fail-closed (503) rather than ack-without-durability until fixed. Recover any affected captures from client device queues.
- *Verify:* durability-audit job shows 100% for the window; reconcile client queue vs server ingestions.
- *Postmortem:* SEV1 always; root-cause the ordering/durability guarantee; add a regression test + chaos scenario (§9).

**RB-3 — Traceability query latency breach under load**
- *Detect:* read-latency SLO burn (SLI-2b), esp. during peak capture or an active recall.
- *Diagnose:* `pg_stat_statements` top offenders; `EXPLAIN ANALYZE` the traceability-lookup query (DATABASE §5) — seq scan? partition not pruned? plan flipped to nested-loop at scale? Check DB pool saturation and whether heavy capture writes are contending.
- *Mitigate:* route reads to a **read replica** (reads must stay available under write load — the constraint); ensure the lot/GTIN indexes are used; if a plan regressed, `ANALYZE`/adjust; rate-limit/queue non-urgent writes before degrading reads.
- *Verify:* read p95 < 200 ms restored under the same load.
- *Postmortem:* capacity (replica sizing), indexing (add/adjust per DATABASE §2), or query (fix N+1 / SELECT-list).

**RB-4 — Audit-log immutability-violation alarm (SEV1)**
- *Detect:* `audit_write_failures_total > 0`, or the DB immutability trigger (`platform.deny_mutation`, DATABASE §3) raised on an UPDATE/DELETE attempt against audit/raw.
- *Diagnose:* who/what attempted the mutation (it should be impossible via the app role — REVOKE + trigger)? A trigger-raise means a code path tried to mutate append-only data — a **bug or intrusion**. Check the hash-chain (if enabled) for continuity.
- *Mitigate:* freeze the offending release immediately; preserve evidence; if a real intrusion, follow security incident process; the trigger already *prevented* the mutation (defense in depth held), so integrity is intact — the alarm is the value.
- *Verify:* no further violations; hash-chain continuous; audit completeness SLO at 100%.
- *Postmortem:* SEV1; the system is supposed to make this impossible — find the path that tried.

---

## 7. Deployment strategy

Never big-bang. **Canary → gradual → full**, gated by the same SLO/budget signals as §2.

### 7.1 Progressive rollout
1. **Canary (5%, ≥ 30 min or N requests):** new version takes a small slice. **Promotion gate:** canary's error-rate, p95/p99 latency, and pipeline hard-fail rate within SLO **and** no relevant SLO in freeze (§2.3) **and** — for changes touching ingestion durability — the durability-audit job shows 100% on canary traffic.
2. **Gradual (25% → 50%):** hold at each step long enough to corroborate burn over the slow window; auto-halt + auto-rollback on a fast-burn breach.
3. **Full (100%):** only after gradual stages are clean.

### 7.2 Rollback
- **Stateless API/worker:** rollback = redeploy previous image; fast and safe (no state migration).
- **Why immutability makes rollback safe:** raw artifacts and audit rows are append-only and never
  mutated, and corrections create **new** ExtractionRuns rather than overwriting — so rolling code
  back never corrupts history; at worst a window of records used the newer extractor (each row
  carries `extractor_version`/`prompt_version`, so it's attributable and re-runnable).
- **Where rollback is NOT trivially reversible — schema (expand-and-contract, BACKEND §11 / DATABASE §6):** the **expand** phase (add nullable column, backfill, add index `CONCURRENTLY`) is backward-compatible and reversible; the **contract** phase (drop the old column) is **not** safely reversible — so **never contract in the same release that expands**. Deploy expand, run on it across at least one full release cycle, contract only after the new code is proven and you're certain you won't roll back to code that needs the old shape. This is the one place "just roll back" doesn't apply, and it's deliberately sequenced so it never has to.

### 7.3 Feature flags & kill-switches
Flags decouple deploy from release and give instant mitigation without a redeploy:
- **`extractor.model` / `extractor.prompt_version`** — switch LLM model or prompt version; roll a new prompt to a canary slice; instant revert if `evidence_gate_reject`/calibration regress.
- **`ocr.adapter` / `llm.adapter`** — swap providers behind the ports (ADR-0002) progressively.
- **`validation.ruleset.mode = warn|enforce`** — new required-field rules roll out **warn-only first** (BACKEND §8.3) so they don't block operations during rollout, then flip to enforce.
- **Kill-switches (the safety levers):**
  - **`force_all_to_review`** — stop auto-accept entirely; every extraction goes to a human. The correct response to a confidence-calibration incident (§5.2): degrade to human oversight rather than trust a misbehaving model. **Never the inverse** — there is no flag to auto-accept low-confidence output.
  - **`ingestion.fail_closed`** — if durability can't be guaranteed, return `503` (clients' durable queue retries) instead of acking without durable storage. Used in RB-2.
  - **`pause_extraction_worker`** — stop pulling the outbox (e.g. during a provider incident); ingestion + raw storage continue, work accumulates safely and drains after.

---

## 8. Capacity planning

> **All numbers in this section are ASSUMED** for a large-retail fishmongery, to derive a starting
> envelope. They are not measured facts — replace with real telemetry before sizing for go-live.

### 8.1 Assumed load
| Parameter | ASSUMED value |
|---|---|
| Stores | 300 |
| Label scans / store / day | 200 |
| Total scans/day | 60,000 |
| Business hours | ~12 h |
| Average ingestion rate | ~1.4 req/s |
| **Peak factor** (morning restock + delivery windows) | **5×** → ~7 req/s peak |
| Temperature logs / store / day | ~288 (every 5 min × ~24 fridge-hours, or per-unit) → ~86k/day fleet-wide, write-heavy but tiny rows |
| Avg image size | ~1–2 MB |

These are modest absolute volumes — the system is **not** throughput-bound; it is **dependency-,
cost-, and integrity-bound** (LLM provider + durability), which is where the risk lives.

### 8.2 Derived load & scaling per tier
- **Ingestion API (stateless):** ~7 req/s peak is trivial for FastAPI; size for the **object-store PUT latency** (the dominant cost) + headroom for the 5× peak and device-queue flush bursts (a store reconnecting can dump a backlog). Scale **horizontally** behind a load balancer; HPA on CPU + request concurrency. Bulkhead the object-store client pool so PUT latency can't starve handlers.
- **Extraction worker:** ~60k extractions/day ≈ ~3.5/s avg, ~17/s peak. At an ASSUMED ~3–8 s per extraction (OCR + LLM), peak needs ~50–140 concurrent in-flight. Scale **worker concurrency + replicas**; this tier is the LLM-rate-limit and cost throttle point.
- **LLM provider:** the **primary bottleneck.** Default traffic is `claude-haiku-4-5`, so size its **RPM and tokens-per-minute** as the primary limit (`claude-opus-4-8` only carries escalation volume, off by default); size the request rate + token budget against those limits, use **prompt caching** on the stable contract prefix (~90% savings on the cached portion) and **Batches (50%)** for non-urgent re-extraction/backfill. Rate-limit at the edge per device so a runaway client can't blow the provider budget. **Verify provider rate limits against current account tier — do not assume.**
- **PostgreSQL:** writes are small but **append-heavy on audit + temperature + raw-metadata** (partitioned by time, DATABASE §7) — monthly partitions give pruning + per-partition autovacuum. Reads (traceability/audit) must stay fast under write load → **read replica(s)** for read APIs; bounded connection **pooling** (PgBouncer) to prevent pool exhaustion; the lot/GTIN indexes (DATABASE §2) keep the traceability join off seq-scans.
- **Object store:** raw images here, not in PG (only key + checksum in PG). Throughput = peak ingestion × image size (~14 MB/s peak ASSUMED) — well within S3-class limits; content-addressed keys make PUT idempotent.

### 8.3 Bottleneck risks (ranked)
1. **LLM provider rate limits + cost** — the real ceiling and the budget lever (§11). Mitigation: caching, batching, model tiering (sonnet/haiku for proven-clean slices, AI-PIPELINE), edge rate-limiting, cost anomaly alert.
2. **Worker throughput vs provider latency** — a slow provider lengthens in-flight time → backlog. Mitigation: concurrency scaling, circuit breaker, `pause_extraction_worker` (ingestion unaffected).
3. **DB write hotspots** (audit/temperature partitions) + autovacuum on append-only tables. Mitigation: time-partitioning, partition pruning, autovacuum tuning, monitoring (DATABASE §8).
4. **Read availability under write load** (the constraint). Mitigation: read replicas, covering indexes, partition pruning.
5. **Object-store availability on the ingestion path** — its outage threatens durability. Mitigation: tight timeout + `503` fail-closed so the device queue retries (no loss).

---

## 9. Chaos engineering plan

Proactively prove the design's safety claims (zero loss, no fabrication, no double-processing)
**before** users hit them. Game-days run in **staging** first, with a blast-radius guardrail, an
abort switch, and an announced window; graduate the safe, well-understood ones to controlled prod
experiments only after staging passes.

| Scenario | Inject | **Expected behavior (must hold)** |
|---|---|---|
| OCR provider down/slow | block/delay `OcrPort` | Retries w/ backoff; breaker opens; runs `ocr_failed` & re-enqueued; **raw image already stored — no loss**; ingestion unaffected (still 202). |
| LLM timeout | delay `LlmExtractorPort` past budget | Retry ≤2; on exhaustion run `extraction_failed`, **raw retained, flagged for review, zero fabricated fields**; breaker may open → `provider_degraded`. |
| LLM refusal | force `stop_reason:"refusal"` | Treated as extraction failure → retain raw → review; **never fabricate**; `llm_refusal_total` increments. |
| LLM rate-limited (429) | simulate provider 429s | Backoff honoring `Retry-After`; worker throttles; no failed *ingestions*; cost/backlog visible. |
| Invalid/partial JSON / poison message | feed malformed extractor output / bad event | Schema gate rejects, bounded ≤2 repair, then fail-loud & retain; **no partial-merge**; poison event → **DLQ, not dropped**; other work flows. |
| DB primary failover | kill primary | Reads continue on replica; writes pause then resume post-failover; in-flight txns retried (serialization/deadlock policy); **no committed action without its audit row** (same-txn invariant). |
| Object store unavailable at ingestion | block PUT | Tight timeout → `503 DEPENDENCY_UNAVAILABLE`; client durable queue retries; **no 202 without durable raw** → no loss. |
| Outbox/worker crash mid-run | kill worker between OCR and persist | On restart, the run is re-driven from the outbox; **idempotent on `event_id` → no double-processing**, no duplicate batch; stuck-run detector catches any that didn't resume. |
| Duplicate submit (client retry storm) | replay same `Idempotency-Key`+image | Replays original `ingestion_id`, **no second raw append**, no duplicate audit row (idempotency two-layer, BACKEND §7). |
| Network partition (worker↔provider / app↔DB) | drop traffic | Timeouts + breakers; degrade not corrupt; recover cleanly when healed. |
| Clock skew | skew a node's clock | Server-stamped times come from the canonical `Clock`; detect skew; audit/temporal ordering must not be corrupted by a bad node clock. |
| Audit-write failure | force audit append to fail | Business action does **not** silently commit without its record (same-txn coupling); pages immediately. |

**Cadence:** monthly staging game-day; a fresh scenario added whenever a real incident reveals a
gap (every SEV1/SEV2 postmortem proposes a chaos test). **Guardrails:** staging-first, scoped blast
radius, abort switch, no experiment during an active incident or feature freeze.

---

## 10. Toil reduction (ranked — automate the highest-toil, highest-risk first)

> Rule: if you did it twice, automate it. Each item lists the manual toil it removes.

1. **Raw-artifact durability verification job** *(removes: manual data-loss auditing; directly defends SLO-3a).* Continuously samples/streams recent 202s and confirms the artifact is readable + checksum-valid in object storage; emits the durability SLI and pages on any gap. **First** because it guards the prime directive and the toil (manually proving "we didn't lose anything") is otherwise unbounded.
2. **DLQ auto-triage + guarded replay** *(removes: hand-inspecting and re-running dead-lettered events).* Auto-classifies DLQ entries (transient vs poison), auto-replays transient after the dependency recovers (idempotent on `event_id`), parks + alerts on poison. Manual replay only for genuinely novel failures.
3. **Stuck-run sweeper** *(removes: manually hunting non-terminal runs).* Periodically finds runs past SLA and re-enqueues them (idempotent), or flags for review if repeatedly failing — turning a silent hang into a tracked, auto-recovered event.
4. **Partition + retention management** *(removes: manual partition creation/detachment, DATABASE §7).* Scheduled job pre-creates upcoming monthly partitions and detaches/archives aged ones per the retention policy (never `DELETE` on append-only) — with the policy windows marked NEEDS VERIFICATION.
5. **Synthetic probes / black-box monitoring** *(removes: waiting for a user to report an outage).* A canary capture flows end-to-end (submit → extract → appears in lookup) every few minutes against a synthetic label, plus a read probe on traceability — catches breakage before real users and feeds MTTD.
6. **Review-queue triage automation** *(removes: reviewers manually sorting the queue).* Auto-prioritizes by reason + business risk (required-field missing on a perishable batch first), surfaces the raw OCR + evidence next to each field — **does not** auto-resolve (no auto-accept of low-confidence; human oversight stays).
7. **Runbook automation** *(removes: hand-running the same diagnostic steps).* Codify RB-1…RB-4's *diagnosis* steps as one-click bundles (pull traces, breaker states, lag, top slow queries) so the on-call starts from data, not from typing commands. Keep *mitigation* human-gated where it touches correctness.

---

## 11. Risks and trade-offs (consolidated)

| Decision | Gains | Gives up / risk | Stance |
|---|---|---|---|
| **Synchronous durability before 202** (raw PUT on request path) | Zero-loss guarantee; a 202 is a real promise | Higher ingestion latency (SLO-2a budget tighter); object-store outage → 503s | **Take it** — durability > ack speed for a compliance system; mitigated by tight timeout + device queue. |
| **Data-integrity SLO unbudgeted** (page on any breach) | Audit-readiness held as absolute | More pages on that class; less "tolerance" | **Take it** — it's the prime directive; offset spam risk via dedup, not via debouncing integrity alerts. |
| **Strict SLOs / freeze policy** | Reliability funded; predictable | Slower feature velocity when budget is low | **Take it, but tune targets with data** (don't buy nines the business doesn't need; each costs ~10×). |
| **MWMBR alerting + heavy anti-spam** | Reliable alerts, no fatigue | Slightly slower detection of slow burns (by design) | **Take it** — alert fatigue is itself a reliability failure; fast window still pages on real fast burns. |
| **Auto-remediation (DLQ replay, stuck-run sweeper)** | Less toil, faster recovery | Automation acting on subtle/novel failures | **Bounded autonomy** — auto-handle *transient/known* (idempotency makes it safe); **never** auto-touch extraction *correctness* (no auto-accept of low-confidence; `force_all_to_review` degrades to humans). |
| **LLM cost vs reliability** (Haiku default, caching, batching, tiering) | Quality + bounded cost | Cheaper tiers risk quality if mis-applied | **Tier only behind evals**; cost-anomaly alert; caching/batching first before downgrading models. |
| **Read replicas + partitioning** | Reads stay fast under write load | Cost (replica), replication lag on reads, ops complexity | **Take it** — traceability availability under load is a hard constraint; tolerate small replica lag for read APIs (not for the durability check). |
| **Expand-and-contract migrations** | Zero-downtime, expand phase reversible | Contract phase not safely reversible; multi-release discipline required | **Take it**; never contract in the same release as expand; sequence so rollback never needs the old shape. |
| **DB-level immutability (REVOKE + triggers)** | Defense in depth; tamper-evident | Slight write overhead; ops must not bypass with superuser | **Take it** — app-level alone is insufficient for a compliance system; the trigger-raise *is* an alarm (RB-4). |

---

### Appendix — consistency map

- **SLO seeds** extend BACKEND §10.4 (same ingestion availability 99.9%, latency p95<1.5s, extraction ≥95%/5min, reads p95<200ms) — this doc adds the **data-integrity SLO**, the unbudgeted treatment, and the burn-rate alerting.
- **Error/log codes** referenced are the stable catalogs in BACKEND §5.2 / §10.1 — no new ad-hoc codes introduced; detectors map onto existing ones (`DEPENDENCY_UNAVAILABLE`, `EXTRACTION_PROVIDER_ERROR`, `GATEWAY_TIMEOUT`, `RATE_LIMITED`) plus stable log codes.
- **Failure detection** realizes AI-PIPELINE §6 (refusal, invalid-JSON, injection, drift) and §9 (drift monitors) as live ops detectors with thresholds + alert routing.
- **Idempotency / no-double-processing** claims rest on BACKEND §7 (two-layer: HTTP key + `event_id` dedup) and DATABASE content-addressed uniqueness.
- **Immutability / audit** rests on ADR-0003, ADR-0004, DATABASE §3 (REVOKE + `deny_mutation` trigger, optional hash chain).
- **Capacity numbers are ASSUMED** and labelled; provider rate limits explicitly marked **verify against account tier**; retention windows marked **NEEDS VERIFICATION** (no regulatory specifics fabricated).
