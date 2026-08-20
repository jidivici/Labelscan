# ADR-0001: Modular monolith first, not microservices

## Status
Accepted & Implemented

## Context
LabelScan must become a multi-user, audit-ready HACCP traceability backend (today it is a
single-device Expo app — see the [initial audit](../../archive/AUDIT.md), A2). The team is small, the bounded contexts are newly
identified (§2 of ARCHITECTURE.md) and still likely to shift, and the strongest requirements are
**strong consistency** for the ingestion+audit path (raw stored before normalization, immutable
audit). The brief explicitly says: prefer a modular monolith and avoid premature microservices.

## Decision
Build a **single deployable modular monolith** (`server/` FastAPI app) with strictly isolated
modules per bounded context, communicating across contexts only via **published domain events on
an in-process event bus** and consuming them behind anti-corruption layers. Module boundaries,
ports, and events are designed so that any context can later be **extracted into its own service**
along an existing seam without redesign.

## Consequences
- **Easier:** local development, transactions spanning a single context, refactoring boundaries
  while they are still fluid, one CI/CD pipeline, one observability surface.
- **Easier later:** extraction to a service is an adapter swap (in-process bus → broker) because
  contexts already talk via events + ports.
- **Harder:** independent scaling of one hot context (e.g. extraction) — must scale the whole
  monolith until extracted. A shared database needs disciplined per-context schemas/grants to
  avoid hidden coupling.

## Alternatives considered
1. **Microservices from day one.** Rejected: operational tax (deploys, networking, distributed
   tracing, eventual-consistency everywhere) that a small team and unsettled boundaries cannot
   justify; premature per the brief.
2. **Single-tier app with no module isolation (today's shape, server-side).** Rejected: would
   re-create the current coupling (A1) and make later extraction a rewrite.

## Trade-offs
We trade *independent scalability/deployability* (given up now) for *low operational cost,
refactorability, and strong in-process consistency* (gained now). We accept that one shared
PostgreSQL is a coupling risk, mitigated by per-context schemas and append-only grants.

## Reversibility
**High.** The whole point of the seam design is reversibility: a context behind ports + events
can be promoted to a service incrementally. The first such candidate (likely HACCP alerting or
extraction) can move without touching other contexts' domains.
</content>
