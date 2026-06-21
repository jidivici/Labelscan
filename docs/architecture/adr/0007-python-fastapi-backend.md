# ADR-0007: Python / FastAPI backend with Pydantic at boundaries, PostgreSQL

## Status
Accepted & Implemented

## Context
The system needs a real backend (today there is none — AUDIT.md A2). The dominant workloads are
OCR/LLM orchestration, structured field extraction, validation, and an audit-ready relational
store. The existing client is an Expo/React Native TypeScript app (`package.json` Expo SDK 54,
`react-native 0.81.5`). A stack must be chosen for the new `server/`.

## Decision
Use **Python + FastAPI** for the backend, with **Pydantic for validation/serialization at the
boundary only** (HTTP DTOs in adapters — never inside the framework-free domain, per
ARCHITECTURE.md §5.2), and **PostgreSQL** as the system of record (append-only raw + audit tables,
relational traceability model). The domain layer uses plain Python value objects/dataclasses to
remain framework-free (constraint #5).

## Consequences
- **Easier:** first-class OCR/LLM/ML ecosystem; FastAPI gives typed request/response models,
  async IO for provider calls, and OpenAPI for free; Pydantic enforces input validation at the
  edge; PostgreSQL supports the immutability guarantees (grants/triggers), JSONB for raw OCR, and
  rich querying for traceability.
- **Harder:** **no type sharing** with the TypeScript mobile app — the API contract must be kept
  in sync manually or via generated clients (accepted trade-off, stated in the brief). Pydantic
  must be deliberately kept out of the domain or it becomes a hidden framework dependency.

## Alternatives considered
1. **Node/TypeScript backend (share types with the mobile app).** Rejected by the user despite
   type-sharing, because Python's OCR/LLM ecosystem and the team's direction favour Python; the
   type-sharing benefit does not outweigh it for this domain.
2. **Pydantic models as the domain model.** Rejected: would couple the domain to a framework,
   violating constraint #5; Pydantic stays at the boundary.
3. **A non-relational primary store.** Rejected: traceability is relational and auditability
   benefits from PostgreSQL's grant/constraint/trigger guarantees and transactions.

## Trade-offs
We trade *end-to-end type sharing with the TS client* for *a stronger OCR/LLM/data ecosystem and
explicit boundary validation*. We accept the duplicate contract maintenance cost, mitigated by
generating a typed client from the OpenAPI spec.

## Reversibility
**Medium.** Language choice is the least reversible decision here (it shapes the codebase). It is
de-risked by the hexagonal design: business rules live in framework-free domain code, so the
FastAPI/Pydantic/SQLAlchemy layers are replaceable adapters, and a future re-platform would
re-implement adapters rather than the core. The OpenAPI contract makes the client integration
portable across backend rewrites.
</content>
