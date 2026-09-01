# ADR-0003: Raw-before-normalized immutable ingestion store

## Status

Accepted; partially implemented

The context and alternatives below preserve the conditions recorded when this decision
was made. The current storage layout is summarized at the end.

## Context

At decision time, the mobile app discarded the raw OCR payload:
`src/services/ocr.ts` kept only `fullTextAnnotation.text` and dropped bounding boxes and
per-token confidence. History was mutable and destructive. The brief required **raw label data stored before
normalization**, **immutable** historical data and **auditable** changes, **confidence per
field**, and **no fabrication** of missing fields. Re-running a better extractor
later must not silently overwrite the original fact. The original detailed audit and
target-architecture source material is retained in Git history; the archived landing pages
no longer reproduce its numbered findings and sections.

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
  recovering confidence/provenance (not possible in the system recorded by the audit); proving "we did not invent fields"
  (unknown stays `null` in the normalized run, while raw shows what was actually read).
- **Harder:** more storage (images + raw JSON retained); a two-step write (raw append, then
  extraction) the application must order correctly; cannot "edit" a bad raw row — only supersede.

## Alternatives considered

1. **Store only normalized fields (status quo).** Rejected: irrecoverable loss of provenance and
   confidence; it breaks the raw-first and per-field-confidence requirements.
2. **Store raw but allow updates.** Rejected: it breaks immutability and reproducibility.
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

## Current implementation note

The raw-before-normalized image path and append-only history are implemented. Image bytes
live in the selected raw store, while PostgreSQL keeps append-only `raw_artifact` metadata,
checksums, and storage references.

The provider-response part diverges from the accepted decision. OCR and LLM adapters return
provider output, but the extraction consumer serializes reduced projections before storage:
OCR keeps full text, mean confidence, and page; LLM keeps decoded fields plus model/prompt
metadata. The verbatim provider envelopes, OCR geometry, and per-token confidence are not
retained. PostgreSQL also stores references rather than the provider JSON itself. The system
therefore cannot reconstruct the complete response described in the decision; this remains
open as OR-17 in the threat model.

Managed S3 object keys include the organization. The single-VPS filesystem store is
content-hash-only and does not create a storage-level tenant boundary; API and database
authorization still scope ordinary access.
