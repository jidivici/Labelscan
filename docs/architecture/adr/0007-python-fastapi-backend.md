# ADR-0007: Python / FastAPI backend with Pydantic at boundaries, PostgreSQL

## Status

Accepted and implemented

The context and alternatives below preserve the conditions recorded when this decision
was made. The current contract-maintenance approach is summarized at the end.

## Context

At decision time, the system had no backend. The expected workloads were OCR/LLM orchestration,
structured field extraction, validation, and an audit-ready relational store. The existing
client was an Expo/React Native TypeScript app; the recorded dependency set used Expo SDK 54
and React Native 0.81.5. A stack had to be chosen for the new `server/`. The original
detailed audit and target-architecture source material is retained in Git history; the
archived landing pages no longer reproduce its numbered findings and sections.

## Decision

Use **Python + FastAPI** for the backend, with **Pydantic for validation/serialization at the
boundary only** (HTTP DTOs in adapters, never inside the framework-free domain), and
**PostgreSQL** as the system of record (append-only raw and audit tables plus the relational
traceability model). The domain layer uses plain Python value objects and dataclasses to
preserve the inward-dependency constraint.

## Consequences

- **Easier:** first-class OCR/LLM/ML ecosystem; FastAPI gives typed request/response models,
  async IO for provider calls, and an automatically generated OpenAPI inventory; Pydantic enforces input validation at the
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
   violating the inward-dependency constraint; Pydantic stays at the boundary.
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

## Current implementation note

Python, FastAPI, Pydantic at HTTP boundaries, SQLAlchemy adapters, and PostgreSQL remain the
implemented stack. CI exports and checks `docs/backend/openapi.v1.yaml`, but the repository
does not currently ship a generated TypeScript client. Mobile and web clients are maintained
against the contract by code and tests, so the typed-client sentence above describes the
accepted mitigation direction rather than a completed control.
