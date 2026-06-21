# ADR-0005: Confidence scores and provenance live on each ExtractedField

## Status
Accepted & Implemented

## Context
Constraint #2 requires **every extracted field to carry a confidence score**, and constraint #1
forbids hallucinating data or inventing missing fields. Today no confidence is kept at all
(AUDIT.md D2) and there are no structured fields (D1). We must decide *where* confidence and
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
`value = None` (and still records why — not read vs. not present) and is **never invented**
(constraint #1). `Confidence` is a first-class value object so thresholds (review triggers,
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
3. **Plain float instead of a value object.** Rejected: scatters threshold logic; no place for the
   no-fabrication and band rules.

## Trade-offs
We trade *model richness/mapping effort* for *an enforceable per-field confidence+provenance
invariant and no-hallucination guarantee*. The extra structure is exactly where the compliance
value is.

## Reversibility
**High.** `ExtractedField` is an internal value object; its shape can evolve (add fields, refine
bands) behind the aggregate. Persisted as structured rows/JSONB, schema changes are migrations,
not redesigns.
</content>
