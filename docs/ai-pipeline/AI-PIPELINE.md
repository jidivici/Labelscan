# LabelScan AI and inference pipeline

This guide explains the inference path implemented by the backend: native
barcode parsing, Google Vision OCR, Claude structured extraction, deterministic
validation, optional escalation, human review, and publication.

The word “AI” in this document does not mean that model output is trusted as a
business record. Machine output remains a proposal until it passes the backend
gate, and an arrival is published only after a complete human review.

For the exact model-output shape, see
[`PROMPT-CONTRACT.md`](../extraction/PROMPT-CONTRACT.md). For orchestration and
event delivery, see
[`PIPELINE-ARCHITECTURE.md`](../pipeline/PIPELINE-ARCHITECTURE.md).

## Implemented design

LabelScan uses a two-stage image path plus a deterministic barcode path:

```text
scanned barcode ──> GS1 parser ───────────────────────────────┐
                                                            |
source image ──> Google Vision OCR ──> Claude extraction ────┤
                                                            v
                                                validation + reconciliation
                                                            |
                                                 extracted / needs_review
                                                            |
                                                   complete human review
                                                            |
                                                   published arrival
```

The API stores the source image and enqueues work. Only the worker calls external
providers. The mobile and browser clients never receive provider credentials and
never call Google Vision or Anthropic directly.

There is no single-pass vision-model path and no provider Batch API integration
in the current code. Both may be useful experiments, but they are not production
fallbacks.

## Versioned trade profiles

Each ingestion snapshots a profession code and profile version before extraction.
New captures use version 2. Version 1 remains resolvable so historical, unfinished
workflows do not become unreadable.

All active profiles share these fields:

```text
commercial_designation, producer_name, reseller_brand, batch_number,
origin_country, expiry_date, packaging_date, storage_temperature,
allergens, health_mark, weight, gtin
```

They then add profession-specific fields:

| Profile | Specific fields | Total active fields |
|---|---|---:|
| `poissonnerie` | `scientific_name`, `FAO_area`, `production_method`, `fishing_gear_or_farming_method` | 16 |
| `boucherie` | `animal_species`, `animal_category`, `cut_name`, `birth_country`, `rearing_country`, `slaughter_country`, `cutting_country`, `slaughterhouse_approval`, `cutting_plant_approval` | 21 |
| `charcuterie_traiteur` | `product_family`, `manufacturer_name`, `ingredients`, `additives`, `preparation_date`, `conditioning_type`, `storage_mode`, `use_instructions`, `reheating_instructions` | 21 |

Price is not part of active version 2. It remains accepted only in historical
version 1 data and legacy human corrections.

The current required operational fields are defined in
`server/src/labelscan/business_profiles.py`. They are application rules, not an
authoritative legal checklist. The Compliance context does not yet provide a
separately governed rule store.

## Stage 1: native GS1 parsing

The barcode supplied by the scanner is parsed before OCR. The pure parser accepts
parenthesized element strings and FNC1-separated raw scans. It recognizes the
application subset used by LabelScan:

| GS1 element | Application field |
|---|---|
| AI `01` | `gtin` |
| AI `10` | `batch_number` |
| AI `17` | `expiry_date` |
| AI `15` | fallback date when AI `17` is absent, with a warning |
| AI `13` | `packaging_date` |
| AI `310x` | net weight in kilograms |

Unsupported or malformed input produces warnings instead of inferred values.
The parser also reports a GTIN check-digit anomaly while preserving the scanner
payload for review.

Barcode-resolved field names are sent to the LLM as an advisory “already known”
list. Correctness does not depend on that hint: reconciliation applies barcode
precedence again after model validation.

## Stage 2: OCR

The `OcrProvider` port returns:

- provider-reported full text;
- mean confidence in `[0, 1]`;
- page number;
- provider response bytes for boundary validation.

The configured adapter is Google Vision REST. Its default feature is
`DOCUMENT_TEXT_DETECTION`; `TEXT_DETECTION` can be selected with
`LABELSCAN_OCR_FEATURE`. The request includes French and English language hints
and sends the original uploaded bytes without server-side resize or crop.

The OCR request timeout is 30 seconds. Boundary checks reject:

- OCR text over 100,000 characters;
- provider output over 2 MiB;
- non-finite or out-of-range confidence;
- page numbers outside 1–100.

The artifact stored for retry is a normalized JSON projection containing full
text, mean confidence, and page. Despite the `raw_json` name in the provider
port, the current persistence helper does not retain the complete verbatim Google
response with token geometry and bounding boxes.

### OCR quality gate

The quality gate is enabled by default and intentionally conservative. It skips
the LLM only when OCR is clearly unusable according to configurable minimum text
length, alphanumeric count, and reported confidence.

When skipped, the system still:

- keeps the image and normalized OCR artifact;
- preserves resolved GS1 values;
- appends an extraction run with outcome `needs_review`;
- sets ingestion status `ocr_skipped_garbage`;
- tells the read model when a new capture is required.

No machine result is silently accepted because a provider returned little text.

### Interim preview

For usable OCR, the worker may commit a small preview before the LLM finishes.
Pure regex rules emit a value only when one explicit, unambiguous label match is
found. Current preview fields are lot, expiry date, packaging date, and storage
temperature.

Interim fields are display-only. They never enter the validation gate, the final
run, traceability registration, or alerting.

## Stage 3: Claude structured extraction

The `LlmExtractor` port receives OCR text, known GS1 fields, trade code, and
profile version. It returns a model identifier, prompt/extractor version, and one
proposal per profile field.

The default adapter uses `claude-haiku-4-5`. `LABELSCAN_LLM_MODEL` may select
only an entry in the explicit capability registry (`claude-haiku-4-5` or
`claude-opus-4-8`); an unknown identifier fails startup.

The request uses provider-native JSON-schema structured output. The adapter then
verifies that the response contains exactly the selected profile’s field names,
with no duplicates or omissions. The consumer adds stricter size, status, and
confidence validation before the domain gate.

The LLM request timeout is 120 seconds. Response budget, adaptive thinking and
effort come from the capability registry: Haiku uses 4096 tokens without
thinking; Opus uses 8192 tokens with adaptive thinking and high effort.

### Prompt versions

Poissonnerie version 2 uses the detailed static prompt
`seafood-label-extraction/v3.1.0`. Other profiles use compact prompts identified
as `food-label-extraction/{trade}/v{profile}`. Prompt version, extractor version,
primary model, and optional escalation model are stored on each run.

The prompt text in Python is canonical. Markdown never duplicates the full
copy-paste prompt because a duplicate becomes stale as soon as code changes.

### Prompt caching

Prompt caching is enabled by default only for the detailed Poissonnerie V2 static
system block. Historical and compact prompts receive no breakpoint. OCR text,
barcode hints, request IDs, timestamps, and secrets stay outside cached content.

Configuration:

| Variable | Default behavior |
|---|---|
| `LABELSCAN_LLM_PROMPT_CACHE_ENABLED` | Enabled |
| `LABELSCAN_LLM_PROMPT_CACHE_TTL` | `5m`; `1h` is an explicit opt-in |
| `LABELSCAN_LLM_PROMPT_CACHE_1H_VERIFIED` | Disabled; required for a measured `1h` deployment |

The adapter logs only allow-listed operational metadata: model/prompt/schema and
cache hashes, TTL, input/output and cache token counters, stop reason and latency.
It never logs OCR, prompts, images, provider bodies or secrets.

The model-specific floor is held in the capability registry. Before adding a
breakpoint, each worker measures the exact static prefix once with `count_tokens`
and disables caching below the floor plus a safety margin. The paid integration
test and `measure_prompt_tokens.py` remain release probes and run only with
explicitly supplied credentials.

### Optional escalation

Escalation is off by default. When enabled, a second `LlmExtractor` instance uses
`LABELSCAN_LLM_ESCALATION_MODEL`; the code default is
`claude-opus-4-8`.

Escalation runs at most once and only when a required free-text field is missing
or below threshold. It never attempts to “repair” barcode-owned fields. The
primary and escalation proposals are evaluated independently, the better grounded
value is selected per field, and the merged result passes through the gate again.

An escalation-provider failure does not fail the primary run. The original
review decision remains in force.

## Stage 4: boundary validation

Before domain evaluation, provider results are bounded:

- at most 64 fields;
- field names no longer than 64 characters;
- string values no longer than 512 characters;
- confidence must be finite and within `[0, 1]`;
- validation status must be one of the six allowed values;
- at most 16 evidence entries and 16 warnings per field;
- individual and total artifact sizes are bounded.

These checks protect storage and runtime behavior. Structured output guarantees
shape; it does not prove that a proposed value is true.

## Stage 5: evidence and confidence gate

The pure `evaluate()` function is the central machine-output decision point.

For each LLM field it:

1. rejects unexpected and duplicate names;
2. validates numeric confidence;
3. requires every evidence string to appear exactly in OCR text;
4. converts a value with missing evidence to null;
5. calculates source spans for grounded evidence;
6. applies controlled-vocabulary and date-order checks;
7. computes combined confidence;
8. evaluates the profile’s required fields.

Combined confidence is:

```text
min(llm_confidence, ocr_confidence)
```

A null value receives zero. Default bands and the review boundary are:

| Band or decision | Default |
|---|---:|
| Review a weak required field below | `0.70` |
| Medium band starts at | `0.70` |
| High band starts at | `0.90` |

The environment can change these values, but they should be calibrated per model
and dataset. They are operational defaults, not universal safety thresholds.

The gate routes the run to review for no extracted value, a missing or weak
required field, ungrounded evidence, unexpected or duplicate fields, invalid
confidence, controlled-vocabulary failure, or inconsistent dates.

This control is accurately described as evidence grounding, not proof of truth.
A quoted OCR substring can support an incorrectly normalized or semantically
misinterpreted value. Human review and representative evaluation remain required.

## Stage 6: reconciliation

The reconciliation layer converts validated LLM fields and GS1 candidates into
the stored field set.

- LLM values cite the OCR artifact and exact text spans.
- GS1 values cite the source image, application identifier, and deterministic
  parser provenance.
- GS1 replaces the LLM proposal for the same owned field.
- The losing printed value is preserved in a warning when it conflicts.
- A critical lot or expiry conflict forces `needs_review`.
- A required field satisfied by GS1 can clear only that missing/weak reason;
  fabrication and consistency flags remain blocking.

The current AI `310x` weight writer stores a compact numeric string while the
provenance carries `unit: kg`. It does not append `kg` to the stored string. This
differs from the human-facing prompt convention and should be normalized in code
before clients rely on a single display format.

## Stage 7: persistence and review

The worker appends an extraction run, all reconciled fields, the ingestion status,
and an `extraction.completed` outbox event in its event transaction. Machine
outcomes are `extracted`, `needs_review`, or `extraction_failed`; the OCR skip
uses run outcome `needs_review` with its distinct ingestion status.

Provider calls are retried a bounded number of times. A committed OCR or model
artifact prevents normal duplicate calls, but a crash between a successful
external response and artifact commit can still cause another billable call.

Neither `extracted` nor `needs_review` publishes an arrival. A reviewer submits
the exact complete profile to `POST /v1/ingestions/{id}/reviews`. The backend
appends a fully human-sourced run, confirms the ingestion, and emits
`review.finalized`. Only that event can create or update a traceability arrival.

## Human-in-the-loop rules

Review is required when machine evidence or profile completeness is insufficient.
The reviewer sees source fields, warnings, confidence, validation state, and the
original image.

The complete-review operation requires every profile field. An absent label value
is recorded explicitly as `NC`; null and blank values cannot be finalized. This
makes publication an affirmative human action rather than a timeout or implicit
acceptance.

Human corrections always create a new run with `source=human`. The machine run
remains unchanged. GS1-owned fields require an explicit force flag on the legacy
per-field route, which makes barcode disagreement visible in audit history.

There is no auto-approval timer.

## Failures and recovery

| Failure | Current behavior |
|---|---|
| Invalid image or oversized request | Reject before durable acceptance |
| Object store or database unavailable during submission | Return retriable `DEPENDENCY_UNAVAILABLE`; client retries the same key |
| OCR transport, HTTP, or malformed response failure | Retry within the bounded provider budget, then append `extraction_failed` |
| Clearly unusable OCR | Skip LLM, preserve GS1, route to recapture/review |
| LLM timeout, refusal, malformed JSON, or invalid field contract | Retry within the provider budget, then append `extraction_failed` |
| Escalation failure | Keep the primary verdict |
| Ungrounded model evidence | Null the value and route to review |
| Unexpected worker bug | Roll back, outbox backoff, then dead-letter after the configured limit |
| Worker outage | Accepted ingestion stays durable but does not progress |

Expected provider exhaustion is stored as a terminal extraction result, so it
does not use the outbox DLQ. The DLQ is for exceptions that escape a consumer.

## Security and data handling

- Provider keys are server-only secrets and support file-mounted secret sources.
- Google receives the source image; Anthropic receives OCR text and a
  list of barcode-resolved field names.
- Images and normalized provider artifacts are stored in the private configured
  object store and referenced by checksum.
- Structured `extra` fields use an allow-list, and the logging policy forbids
  image bytes, OCR text, prompts, model output, credentials, and authentication
  tokens. The formatter still includes message and exception text without a
  general redaction pass, so provider adapters and callers must sanitize them.
- OCR text is treated as untrusted data in the system prompt. The backend gate,
  not prompt obedience, enforces allowed names and evidence checks.
- Tenant context and RLS restrict artifact metadata. S3 object keys include the
  organization; the development filesystem store is checksum-addressed globally.

Any production privacy, residency, or retention requirement must be checked
against the selected provider accounts and deployment configuration. This code
does not make those contractual guarantees.

## Evaluation and calibration

The automated suite covers pure gate behavior, GS1 parsing and reconciliation,
OCR response parsing and quality checks, provider retries, prompt caching request
shape, escalation, multi-trade field contracts, append-only persistence, review,
and event-driven publication. Most tests use deterministic fakes and do not spend
provider budget.

`server/scripts/calibrate_confidence.py` analyzes a labeled JSON dataset and finds
the lowest tested threshold that meets a configured maximum number of wrong
auto-accepts. It compares strings exactly. It is useful threshold tooling, but it
does not calculate ECE, semantic equivalence, class-weighted risk, or confidence
intervals.

The repository does not contain a production-grade, versioned real-label golden
dataset or a mandatory live-provider regression gate. A model, prompt, OCR
feature, or threshold change should not be approved solely because unit tests
pass. The evaluation plan in
[`eval-suite.md`](../pipeline/eval-suite.md) describes the missing release layer.

## Current gaps found by audit

- The provider ports call their byte field `raw_json`, but persistence stores a
  normalized projection rather than the verbatim Google or Anthropic response.
- The detailed Poissonnerie prompt tells the model to use `evidence: null` for a
  missing value, while the provider JSON schema allows only an evidence array.
  The adapter normalizes empty evidence after parsing, but the request contract
  itself is inconsistent and should be corrected in code.
- The runtime structured-output schema is built in the Claude adapter from the selected
  trade profile; no parallel documentation schema is treated as executable.
- Non-seafood prompts are much shorter and less domain-specific than the
  Poissonnerie prompt; quality parity has not been demonstrated by a checked-in
  trade-specific dataset.
- Full input/output token usage and per-request currency cost are not logged.
- Cache eligibility is not validated at startup.
- Provider deduplication does not close the crash-before-artifact-commit billing
  window.
- Evidence substring checks cannot prove that normalization or interpretation is
  semantically correct.
- The active rule set is still an application-composed placeholder.
