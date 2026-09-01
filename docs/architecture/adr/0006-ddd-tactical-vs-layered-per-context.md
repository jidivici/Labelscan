# ADR-0006: Tactical DDD only in core contexts; layered modules elsewhere

## Status

Accepted and implemented

The context and alternatives below preserve the conditions recorded when this decision
was made. The current boundary enforcement is summarized at the end.

## Context

The brief warns against architecture astronautics: tactical DDD (aggregates, value objects,
domain services, repositories) should be used only where it solves a real coupling/complexity/
change problem, and layered/CRUD designs are fine where domain behaviour is thin. We must decide
**per context** whether to invest in rich tactical DDD or a simpler layered module.

## Decision

Apply **tactical DDD** in the two **core** contexts where invariants and lifecycle are real:

- **Ingestion & Extraction:** `Ingestion` and `RawArtifact` aggregates, `ExtractedField` /
  `Confidence` / `Provenance` value objects, status-transition invariants, repositories, ports.
- **HACCP Controls & Alerting:** `ControlPlan`, `Alert` aggregates with monotonic lifecycles and
  versioned thresholds.

Use **simpler layered modules** (presentation → application → data, repositories where helpful,
no rich aggregates) in the **supporting/generic** contexts:

- **Compliance & Catalog:** mostly versioned reference data + a thin policy (required-field rule
  set, controlled vocabularies, GTIN checks). Table-driven.
- **Traceability Registry:** modest behaviour around `Batch`/`Supplier`; aggregates kept thin.
- **Audit & History:** a single append-only entity behind a port — no rich model needed.
- **Identity & Access:** generic; adopt/buy, layered.

## Consequences

- **Easier:** modeling effort concentrated where complexity and risk live; reference-data and
  identity contexts stay small and fast to change.
- **Harder:** two idioms in one codebase; developers must know which context warrants which style.
  The decision expected per-context READMEs and uniform dependency rules regardless of
  internal style. The original detailed target-architecture text is retained in Git history;
  the archived landing page no longer reproduces its numbered sections.

## Alternatives considered

1. **Full tactical DDD in every context.** Rejected: over-engineering CRUD reference data and
   identity; ceremony with no invariant to protect (anemic aggregates).
2. **Layered everywhere, no aggregates.** Rejected: the ingestion and HACCP invariants (raw-
   before-normalized, confidence-per-field, monotonic alert lifecycle, versioned thresholds) would
   leak into procedural code and erode, recreating the data-integrity failures observed in the
   initial mobile-only implementation.

## Trade-offs

We trade *idiom uniformity* for *effort proportional to complexity*. The boundary rules and ports
stay uniform across both idioms, so the inconsistency is contained inside contexts.

## Reversibility

**High.** A supporting context can be upgraded to tactical DDD later if its behaviour grows (its
public surface is its events + APIs, unchanged). Likewise a core context could be simplified. The
choice is internal to each context and does not cross boundaries.

## Current implementation note

The backend currently has six isolated contexts: `identity`, `ingestion`,
`traceability`, `haccp`, `compliance`, and `audit`. Their internal richness has evolved
with the product, but the proportional-modeling decision remains. Import Linter enforces
context independence and keeps infrastructure out of application/domain layers; it is a
more reliable guide to the current boundary rules than the original context examples above.
The per-context READMEs anticipated in the decision were not created; use the current
enterprise/backend architecture documents and `server/.importlinter` instead.
