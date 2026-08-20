# ADR-0003: Raw-before-normalized immutable ingestion store

## Status
Accepted & Implemented

## Context
The current app discards the raw OCR payload — `src/services/ocr.ts` keeps only
`fullTextAnnotation.text` and drops bounding boxes and per-token confidence
([initial audit](../../archive/AUDIT.md), D2/D3) —
and history is mutable/destructive (D4). The brief requires: **raw label data stored before
normalization** (#3), **immutable** historical data and **auditable** changes (#4), **confidence
per field** (#2), and **no fabrication** of missing fields (#1). Re-running a better extractor
later must not silently overwrite the original fact (ARCHITECTURE.md R19).

## Decision
Persist the **raw artifact append-only and before any normalization**, in two parts:
1. **Binary image** in object storage, content-addressed, with a checksum.
2. **Raw provider JSON** (full OCR response incl. geometry + per-token confidence) in a
   PostgreSQL **append-only** table.

Raw rows are **write-once**: never `UPDATE`d or `DELETE`d. Immutability is enforced at the
storage tier (restricted DB grants + a trigger that rejects update/delete), not merely by
convention. The mutable, interpreted representation (normalized `ExtractedField`s) is a separate
`ExtractionRun` that **references** the raw artifact by ID. Corrections and re-extractions create
**new** runs; the raw fact and prior runs are retained.

## Consequences
- **Easier:** reprocessing with improved OCR/LLM later; auditing exactly what the label said;
  recovering confidence/provenance (impossible today); proving "we did not invent fields"
  (unknown stays `null` in the normalized run, while raw shows what was actually read).
- **Harder:** more storage (images + raw JSON retained); a two-step write (raw append, then
  extraction) the application must order correctly; cannot "edit" a bad raw row — only supersede.

## Alternatives considered
1. **Store only normalized fields (status quo).** Rejected: irrecoverable loss of provenance and
   confidence; violates #2/#3.
2. **Store raw but allow updates.** Rejected: violates immutability (#4); breaks reproducibility.
3. **Single table mixing raw + normalized.** Rejected: couples an append-only fact to a revisable
   interpretation; makes the immutability grant impossible to scope.

## Trade-offs
We trade *storage cost and write-ordering discipline* for *recoverability, reprocessability, and
provable auditability*. Storage is cheap relative to the compliance value; retention policy can
be tuned later without changing the model.

## Reversibility
**Medium.** The "raw first, append-only" decision is foundational and intentionally hard to
reverse (that is its value). But *implementation* choices around it are reversible: object-store
vendor is behind `ObjectStore` (ADR-0002); retention windows are policy, not schema.
</content>
