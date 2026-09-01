# ADR-0005: Confidence scores and provenance live on each ExtractedField

## Status

Accepted and implemented

The context and alternatives below preserve the conditions recorded when this decision
was made. The current persisted field shape is summarized at the end.

## Context

The decision brief required **every extracted field to carry a confidence score** and
forbade fabricating missing fields. At decision time, the system retained
no confidence and had no structured fields. The decision needed to establish *where* confidence and
provenance live in the model and how "unknown" is represented.

## Decision

Model each extracted seafood field as an **`ExtractedField` value object** owned by the
`ExtractionRun` inside the `Ingestion` aggregate, shaped as:

```
ExtractedField {
  name:        FieldName          # e.g. species, scientific_name, fao_area, lot, use_by, storage_temp
  value:       Optional[...]      # None when the field is absent/unreadable — NEVER fabricated
  confidence:  Confidence         # value object, 0.0–1.0 + qualitative band (low/med/high)
  provenance:  Provenance         # extractor_version, source = ocr|llm|barcode|human, source_ref
  source_ref:  RawArtifactRef     # points back to the immutable raw artifact / OCR token span
}
```

Rules: a **non-null value must always carry a confidence and provenance**; a missing field has
`value = None` (and still records why — not read vs. not present) and is **never invented**.
`Confidence` is a first-class value object so thresholds (review triggers,
HACCP gating) are expressed in domain terms, not raw floats scattered around. Human confirmation
(`ExtractionConfirmed`) records overrides as new provenance, not by erasing the original.

## Consequences

- **Easier:** confidence travels with the datum everywhere (events, persistence, UI review);
  required-field validation and low-confidence review become simple domain rules; auditors can see
  source + confidence per field.
- **Harder:** richer field model than a flat row; mapping LLM output into typed fields + bands is
  extra adapter work.

## Alternatives considered

1. **Separate `confidence` side-table keyed by ingestion+field.** Rejected: confidence is
   intrinsic to a reading; splitting it invites rows where a value exists without a confidence,
   violating the invariant the model should make impossible.
2. **A single overall confidence per ingestion.** Rejected: violates "every *field* must have a
   confidence"; loses per-field review granularity.
3. **Plain float instead of a value object.** Rejected: scatters threshold logic and leaves no
   single place for evidence-grounding and confidence-band rules.

## Trade-offs

We trade *model richness and mapping effort* for an enforceable per-field confidence and
provenance invariant. This structure supports evidence review, but it does not prove semantic
truth or regulatory compliance by itself.

## Reversibility

**High.** `ExtractedField` is an internal value object; its shape can evolve (add fields, refine
bands) behind the aggregate. Persisted as structured rows/JSONB, schema changes are migrations,
not redesigns.

## Current implementation note

The current extracted-field model records LLM confidence, OCR confidence, combined
confidence, qualitative band, evidence, provenance, source, validation status, and
warnings. Database constraints require a non-null value to carry provenance and a source
artifact reference; null values carry neither. Human review and field override create a new
append-only extraction run instead of mutating the earlier interpretation.
