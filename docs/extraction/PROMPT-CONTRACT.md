# Structured extraction contract

This guide describes the contract implemented by the Claude adapter and the
backend validation gate. It is written for engineers changing prompts, trade
profiles, provider adapters, or extraction tests.

The executable sources are:

- `server/src/labelscan/business_profiles.py` for profile versions, field names,
  and application-required fields;
- `server/src/labelscan/contexts/ingestion/adapters/claude_llm_provider.py` for
  prompt text, prompt identifiers, request schema, and adapter checks;
- `server/src/labelscan/contexts/ingestion/adapters/extraction_consumer.py` for
  provider-boundary limits and orchestration;
- `server/src/labelscan/contexts/ingestion/domain/extraction.py` for evidence,
  confidence, vocabulary, date-consistency, and review decisions.

This Markdown file explains those sources; it does not replace them. The runtime provider
schema is built from the selected trade profile in the Claude adapter.

## Request context

The extractor receives:

- OCR text from one captured image;
- field names already resolved from the scanned barcode or conservative exact-OCR
  rules, when available;
- the ingestion's snapshotted trade code and profile version.

OCR text is untrusted input. The user message clearly labels it as OCR content,
but prompt wording is not the security boundary. The backend independently
checks the returned field set, sizes, confidence values, evidence, and business
rules.

The deterministic hint asks the model to omit already resolved fields and focus on
the remaining free text. Reconciliation applies deterministic precedence again
after validation, so the hint is only an optimization.

## Current response shape

The provider must return one JSON object with exactly one top-level property:

```json
{
  "fields": [
    {
      "name": "commercial_designation",
      "value": "Example value",
      "confidence": 0.92,
      "evidence": ["Example value"],
      "validation_status": "normalized"
    }
  ]
}
```

The response is sparse: an ordinary missing field is omitted. Each emitted field
object has four required properties and two optional diagnostics:

| Property | Runtime type | Meaning |
|---|---|---|
| `name` | string | One allowed field name for the selected profile |
| `value` | string or null | Proposed value; all current values are flat strings |
| `confidence` | number | Model confidence; the consumer later requires a finite value in `[0, 1]` |
| `evidence` | array of strings | Exact OCR substrings offered in support of the value |
| `validation_status` | optional string | Model self-assessment; defaults to `present` for a value and `missing` for null |
| `warnings` | optional array of strings | Concise field-specific ambiguity or anomaly note |

Allowed validation statuses are:

```text
present, missing, ambiguous, normalized, unnormalizable, invalid
```

The provider JSON schema closes the object against extra properties and constrains
the `name` enum to the selected profile. The adapter accepts a duplicate-free subset
of profile fields and rejects unexpected names. Required-field checks happen after
decoding, so omitting ordinary missing fields saves output tokens without weakening
review routing.

The response does not contain `schema_version`, `raw_warnings`, polymorphic date,
temperature, weight, or price objects. Prompt, extractor, model, OCR provider, and
rule-set provenance are stored on the extraction run instead.

## Active profile version

New ingestions snapshot profile version `2`. Version `1` remains resolvable only
for immutable historical workflows; it includes the retired `price` field.

Version 2 shares these fields:

```text
commercial_designation, producer_name, reseller_brand, batch_number,
origin_country, expiry_date, packaging_date, storage_temperature,
allergens, health_mark, weight, gtin
```

It adds the following trade-specific fields:

| Trade code | Additional fields | Complete response |
|---|---|---:|
| `poissonnerie` | `scientific_name`, `FAO_area`, `production_method`, `fishing_gear_or_farming_method` | up to 16 fields |
| `boucherie` | `animal_species`, `animal_category`, `cut_name`, `birth_country`, `rearing_country`, `slaughter_country`, `cutting_country`, `slaughterhouse_approval`, `cutting_plant_approval` | up to 21 fields |
| `charcuterie_traiteur` | `product_family`, `manufacturer_name`, `ingredients`, `additives`, `preparation_date`, `conditioning_type`, `storage_mode`, `use_instructions`, `reheating_instructions` | up to 21 fields |

The following fields are currently required by application configuration:

| Trade code | Required fields |
|---|---|
| `poissonnerie` | `scientific_name`, `expiry_date`, `production_method` |
| `boucherie` | `animal_species`, `cut_name`, `expiry_date` |
| `charcuterie_traiteur` | `commercial_designation`, `expiry_date`, `ingredients` |

These are operational application rules. They are not presented as a complete or
authoritative regulatory checklist. The Poissonnerie rule set is still assembled
from a placeholder configuration in the application wiring; there is no separately
governed compliance-rule store yet.

## Prompt identifiers and variants

| Selection | Prompt identifier | Prompt style |
|---|---|---|
| Poissonnerie, profile 2 | `seafood-label-extraction/v3.3.0` | Detailed cached sparse-output prompt with examples |
| Other profiles, including history | `food-label-extraction/{trade_code}/profile-{profile_version}/prompt-v2.0.0` | Compact profile-generated prompt |

Both prompt and extractor version columns receive the selected identifier. The
model identifier is stored separately.

The detailed Poissonnerie prompt includes normalization and ambiguity guidance,
while the other active trades currently use shorter instructions. Their shared
contract and backend gate are the same, but the repository has no checked-in
trade-specific labelled dataset demonstrating equal extraction quality.

## Behavioral rules

The prompts consistently aim for these behaviors:

- return only the JSON object;
- audit every profile field, while emitting only present or genuinely ambiguous ones;
- prefer null over an unsupported guess;
- never translate, repair OCR spelling, or fill a value from outside knowledge;
- cite exact substrings from OCR for every proposed value;
- preserve ambiguity in status and warnings;
- normalize a date only when its interpretation is unambiguous;
- do not treat an establishment or health mark as proof of product origin;
- do not derive a GS1 field from an unrelated printed number.

These are extraction instructions, not legal determinations. Human reviewers are
responsible for final values, and publication requires a complete human run.

## Backend enforcement

Structured output guarantees only a constrained JSON shape. After the provider
returns, the backend also enforces:

- a provider artifact size limit of 2 MiB;
- no more than 64 fields;
- field-name and value length limits;
- finite confidence in `[0, 1]`;
- the allowed validation-status set;
- bounded evidence and warning arrays;
- allowed and unique field names;
- exact-substring evidence grounding;
- configured vocabulary and date-order rules;
- review routing for missing or weak required fields.

For grounded model fields, combined confidence is the lower of model and OCR
confidence. A value without grounded evidence becomes null. A matching substring
does not prove that the normalized value is semantically correct, so human review
and representative evaluation remain necessary.

Reconciliation then adds supported GS1 values and gives them precedence over model
proposals. Critical printed/barcode conflicts force review instead of being hidden.

## Human review contract

Machine extraction never publishes a traceability arrival. Final review uses
`POST /v1/ingestions/{ingestion_id}/reviews` and must submit the complete profile
field set. A label value that is not communicated is recorded explicitly as `NC`;
null and blank values cannot be finalized.

The backend creates a new human extraction run rather than altering the machine
run. It confirms the ingestion and emits `review.finalized` atomically. Only this
event is registered into the traceability catalogue.

## Evidence invariant

The provider contract always uses an array. An ordinary missing field is omitted. An
emitted ambiguous field has `value: null`, `confidence: 0`, and `evidence: []`, with
its concise diagnostic in `warnings`. The public read API still renders stored SQL
`NULL` evidence as `[]`, so clients never need a nullable evidence branch.

## Verification when changing the contract

Any field, prompt, schema, or normalization change should include:

1. profile tests for exact field membership and historical-version resolution;
2. adapter tests for the actual provider request schema and decoded response;
3. evidence-gate tests with grounded and fabricated substrings;
4. GS1 precedence and conflict tests;
5. complete human-review and publication tests;
6. evaluation on representative, verified labels for every affected trade.

Current automated coverage lives under `server/tests/`. The missing representative
production evaluation layer is described in
[`../pipeline/eval-suite.md`](../pipeline/eval-suite.md).
