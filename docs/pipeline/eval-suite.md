# Extraction evaluation guide

LabelScan has broad automated backend tests, but it does not yet have a
production-grade model evaluation suite. This guide separates the controls that
exist from the release evidence that is still needed.

It applies to all active profiles: Poissonnerie, Boucherie, and
Charcuterie/Traiteur. No single trade or clean-label sample can stand in for the
others.

## Implemented evaluation layers

The backend CI workflow installs locked dependencies and runs:

- dependency audits for runtime and development locks;
- import-boundary checks;
- Ruff linting;
- generated OpenAPI inventory verification;
- Alembic upgrade, downgrade to base, and upgrade again;
- the complete Pytest suite against PostgreSQL.

The automated tests cover important extraction and pipeline behavior with
deterministic fakes, including:

| Area | Examples of current coverage |
|---|---|
| Profile contracts | active and historical profiles, exact field sets, trade access |
| Provider boundaries | OCR parsing/configuration, LLM request shape, response limits, retries |
| Prompt caching | static/dynamic separation, cache breakpoint, usage-counter logging |
| OCR quality | conservative garbage detection and LLM skip behavior |
| Extraction gate | evidence grounding, confidence, allowed fields, dates and vocabulary |
| GS1 | parsing, validation warnings, reconciliation, conflict routing |
| Optional escalation | trigger conditions, merge behavior, failure fallback |
| Persistence | append-only runs and fields, raw durability, rollback behavior |
| Events | outbox redelivery, consumer idempotency, backoff and dead letters |
| Human review | complete profile validation, idempotency, publication boundary |
| Tenancy and security | access perimeters, row-level security, audit context, structured-log field allow-list |

Most of these tests do not call external providers. A prompt-cache test can call
Anthropic's token-count endpoint when a key and SDK are present, but CI normally
skips it. There is no equivalent live Google Vision extraction run in the regular
suite.

## What is not established

The repository currently provides no verified evidence for:

- field precision or recall on representative real labels;
- quality parity across the three active trades;
- model confidence calibration on production-like data;
- OCR feature quality by image condition and device;
- multilingual and difficult-layout performance;
- review-queue rate or human correction rate by field;
- live-provider latency, availability, or billed usage;
- regression tolerance for a model or provider update;
- drift detection after deployment.

The default confidence thresholds are application settings. They are not validated
quality targets and should not be interpreted as measured accuracy.

## Minimum release dataset

Build a versioned dataset of actual label conditions with human-verified expected
values. Keep the image, scanner barcode when available, expected profile field set,
and review notes linked by an opaque case identifier.

Include each relevant combination of:

- all active trades and any historical profile affected by a compatibility change;
- clean, blurred, cropped, rotated, reflective, low-light, and cluttered images;
- printed, handwritten, damaged, and mixed-font text when supported in practice;
- French, English, and real multilingual combinations from the target population;
- barcode present, absent, malformed, unsupported, and conflicting with print;
- complete labels, missing required fields, and labels that require `NC`;
- ambiguous dates, temperatures, weights, origins, approvals, ingredients, and
  product terminology;
- prompt-injection-like text, irrelevant images, and provider failure fixtures.

Sampling should reflect real traffic while deliberately oversampling rare,
high-impact failures. Split cases by physical label or product source before
creating development and holdout sets so near-duplicate photos cannot leak across
them.

## Ground truth and privacy

Two trained reviewers should independently annotate high-impact fields, with a
documented adjudication path for disagreements. Ground truth must come from the
visible label, a validated barcode element, or an authorized business record—not
from the model being evaluated.

Before committing or uploading a dataset:

- remove faces, contact details, employee names, account identifiers, and unrelated
  background content when they are not needed for the case;
- confirm the organization is permitted to use the images with each evaluation
  provider;
- define access, encryption, region, retention, and deletion controls;
- keep production credentials and provider responses out of Git;
- record dataset version and annotation guidance without embedding sensitive data.

This repository does not currently implement that dataset-governance process.

## Metrics that answer distinct questions

Report results by trade, field, image condition, language, barcode availability,
and model/prompt/OCR configuration. An overall average can hide a severe slice.

### Contract and safety

- **Schema pass rate:** responses accepted by the exact runtime response contract.
- **Closed-set pass rate:** responses containing every expected field exactly once.
- **Unsupported-value rate:** non-null values without matching OCR evidence.
- **Barcode conflict routing rate:** known critical conflicts that reach review.
- **Publication safety:** machine-only runs that create an arrival; expected value is
  zero by architecture.

### Field quality

- **Precision:** correct non-null predictions divided by all non-null predictions.
- **Recall:** correctly extracted expected values divided by extractable expected
  values.
- **Abstention rate:** null predictions divided by evaluated fields.
- **Normalization accuracy:** correct canonical values among values that required
  normalization.
- **Exact evidence rate:** accepted values whose evidence is present verbatim in OCR.

Define equivalence per field before scoring. Exact comparison is appropriate for
identifiers; dates need a canonical format; free text may need a reviewed
normalization policy. Do not silently use fuzzy matching to turn a wrong value into
a pass.

### Operational impact

- ingestion outcomes and review rate;
- human correction rate by field and source (`llm`, `gs1`, or human);
- OCR and LLM latency distributions;
- provider error, retry, and escalation rates;
- input, output, cache-write, and cache-read tokens;
- billed provider usage reconciled with the provider account.

### Confidence calibration

`server/scripts/calibrate_confidence.py` evaluates a grid of review thresholds from
a labelled JSON dataset. It uses exact string equality and reports wrong automatic
accepts plus review rate. It does not compute expected calibration error, semantic
equivalence, confidence intervals, or class-weighted risk.

Use it as one transparent threshold tool, not a complete calibration report.

## Recommended evaluation layers

1. **Pure unit tests:** domain gates, normalization, GS1, and configuration.
2. **Adapter contract tests:** real request shape and recorded provider responses,
   with no secrets in fixtures.
3. **Pipeline integration tests:** PostgreSQL, object storage, outbox redelivery,
   review, and publication with deterministic providers.
4. **Offline provider evaluation:** frozen dataset against exact candidate provider,
   model, prompt, OCR feature, and settings.
5. **Limited production observation:** controlled rollout with human review and
   billing/latency monitoring before broader adoption.

Only the first three layers are substantially represented in the current repository,
and provider behavior is mostly simulated within them.

## Suggested change record

For every candidate, retain a small machine-readable manifest outside sensitive
label content:

```json
{
  "dataset_version": "team-defined-version",
  "trade_profile_versions": {
    "poissonnerie": "2",
    "boucherie": "2",
    "charcuterie_traiteur": "2"
  },
  "ocr_provider": "google-vision",
  "ocr_feature": "DOCUMENT_TEXT_DETECTION",
  "model": "configured-model-id",
  "prompt_versions": ["exact-runtime-identifiers"],
  "rule_set_versions": ["exact-runtime-identifiers"],
  "threshold_configuration": "captured-environment-values",
  "code_revision": "source-control-revision"
}
```

The strings above are descriptive placeholders. Populate them from the evaluated
run rather than copying a sample into production records.

## Release decision

The team should define acceptable per-field and per-slice thresholds from business
risk and observed baseline data. This document deliberately does not invent
unmeasured numbers.

At minimum, block a candidate when it:

- violates the runtime response contract;
- increases unsupported non-null values;
- hides a known barcode/print conflict;
- weakens tenant, audit, idempotency, or append-only controls;
- permits machine-only catalogue publication;
- materially regresses a high-impact field or trade slice without an approved
  mitigation.

This release gate is a recommendation, not current CI behavior. Until it is
automated, model, prompt, OCR feature, and confidence changes require an explicit
human evaluation record.
