# Architecture Decision Records — LabelScan

ADRs for the HACCP-oriented seafood traceability backend. Each ADR uses the template:
**Status / Context / Decision / Consequences / Alternatives considered / Trade-offs /
Reversibility**. See the parent [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full design.

| ADR | Title | Status | One-line rationale |
|-----|-------|--------|--------------------|
| [0001](./0001-modular-monolith-vs-microservices.md) | Modular monolith first, not microservices | **Accepted & Implemented** | Unsettled boundaries + strong consistency for ingestion/audit; extract along seams later. |
| [0002](./0002-hexagonal-ports-adapters-ocr-llm.md) | Hexagonal ports & adapters for OCR/LLM | **Accepted & Implemented** | Providers must be replaceable; keep the domain free of Vision/LLM SDKs (ACL at the edge). |
| [0003](./0003-raw-before-normalized-immutable-store.md) | Raw-before-normalized immutable ingestion store | **Accepted & Implemented** | Capture the literal label fact append-only before interpretation; recoverable & reprocessable. |
| [0004](./0004-immutable-audit-append-only-vs-event-sourcing.md) | Append-only audit table now, ES deferred | **Accepted & Implemented** | Meets auditability/immutability with far less complexity; ES is a forward-compatible evolution. |
| [0005](./0005-confidence-scores-in-the-model.md) | Confidence + provenance on each ExtractedField | **Accepted & Implemented** | Confidence is intrinsic to a field; unknown ⇒ null, never fabricated. |
| [0006](./0006-ddd-tactical-vs-layered-per-context.md) | Tactical DDD in core contexts, layered elsewhere | **Accepted & Implemented** | Effort proportional to complexity; avoid anemic ceremony on CRUD/reference data. |
| [0007](./0007-python-fastapi-backend.md) | Python / FastAPI + Pydantic at boundaries, PostgreSQL | **Accepted & Implemented** | Strong OCR/LLM/data ecosystem; accepted trade-off: no type-sharing with the TS client. |

## Conventions
- Filenames: `NNNN-kebab-title.md`, numbered sequentially.
- A decision that replaces another sets its own Status to `Accepted` and the old one to
  `Superseded by ADR-NNNN`.
- ADRs are immutable once Accepted; change by adding a new ADR, not editing history (consistent
  with the system's own immutability principle).
</content>
