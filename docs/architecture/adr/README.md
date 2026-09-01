# Architecture Decision Records

Architecture Decision Records (ADRs) explain the choices that shape LabelScan, including
the context, alternatives, and trade-offs that are easy to lose when only the final code
remains. Read them alongside the [enterprise architecture](../../ENTERPRISE-ARCHITECTURE.md),
which describes how the accepted decisions work together in the current system.

## Decision index

| ADR | Decision | Status | Why it matters |
|---|---|---|---|
| [0001](0001-modular-monolith-vs-microservices.md) | Start with a modular monolith, not microservices | **Accepted; implementation evolved** | The modular monolith remains, while asynchronous work moved from the proposed in-process bus to a PostgreSQL outbox shared by separate API and worker processes. |
| [0002](0002-hexagonal-ports-adapters-ocr-llm.md) | Place OCR and LLM providers behind hexagonal ports | **Accepted and implemented** | Provider SDKs remain replaceable and cannot define the core extraction model. |
| [0003](0003-raw-before-normalized-immutable-store.md) | Store raw evidence before normalized data | **Accepted; partially implemented** | Original images are retained, but verbatim OCR/LLM envelopes and detailed OCR evidence are not. |
| [0004](0004-immutable-audit-append-only-vs-event-sourcing.md) | Use an append-only audit log; defer full event sourcing | **Accepted; partially implemented** | The append-only journal exists, but the planned before/after snapshot references do not. |
| [0005](0005-confidence-scores-in-the-model.md) | Keep confidence and provenance on each extracted field | **Accepted and implemented** | Uncertainty belongs to the value it describes, and unsupported values remain `null`. |
| [0006](0006-ddd-tactical-vs-layered-per-context.md) | Use tactical DDD only where domain complexity justifies it | **Accepted and implemented** | Core rules receive richer modeling while straightforward reference data stays simple. |
| [0007](0007-python-fastapi-backend.md) | Use Python, FastAPI, Pydantic, and PostgreSQL | **Accepted and implemented** | The stack fits OCR and data workflows; the deliberate cost is no automatic type sharing with the TypeScript client. |
| [0008](0008-business-portals-for-multi-trade-ownership.md) | Make business portals the multi-trade ownership boundary | **Accepted and implemented** | Organization, store, and profession together define authorization and historical ownership. |

## Writing a new ADR

Use the next four-digit sequence number and a concise kebab-case filename, for example
`0009-descriptive-title.md`. Every record should contain:

- **Status** — proposed, accepted, rejected, or superseded;
- **Context** — the problem, constraints, and forces behind the decision;
- **Decision** — the chosen direction in specific, testable language;
- **Consequences** — what becomes easier, harder, or newly required;
- **Alternatives considered** — credible options and why they were not selected;
- **Trade-offs and reversibility** — the cost of changing course later.

Once an ADR is accepted, preserve it as historical evidence. If the decision changes,
create a new ADR and mark the earlier record `Superseded by ADR-NNNN`.

Implementation details can evolve without reversing the core decision. In that case, add a
clearly labeled current implementation note instead of rewriting the original context as if
it had always described the current code.
