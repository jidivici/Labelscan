# ADR-0001: Modular monolith first, not microservices

## Status

Accepted; implementation evolved

The context and alternatives below preserve the conditions recorded when this decision
was made. The current runtime is summarized at the end.

## Context

At decision time, LabelScan was a single-device Expo app and needed to become a
multi-user, audit-ready HACCP traceability backend. The team was small, the bounded
contexts had only recently been identified, and the strongest requirements were
**strong consistency** for the ingestion-and-audit path: store raw evidence before
normalization and keep audit history immutable. The brief explicitly preferred a modular
monolith over premature microservices. The original detailed audit and target-architecture
source material is retained in Git history; the archived landing pages no longer reproduce
its numbered findings and sections.

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
2. **Single-tier app with no module isolation (the equivalent of the then-current shape,
   server-side).** Rejected: it would reproduce the direct coupling that existed in the
   mobile-only application and make later extraction a rewrite.

## Trade-offs

We trade *independent scalability/deployability* (given up now) for *low operational cost,
refactorability, and strong in-process consistency* (gained now). We accept that one shared
PostgreSQL is a coupling risk, mitigated by per-context schemas and append-only grants.

## Reversibility

**High.** The whole point of the seam design is reversibility: a context behind ports + events
can be promoted to a service incrementally. The first such candidate (likely HACCP alerting or
extraction) can move without touching other contexts' domains.

## Current implementation note

The modular-monolith decision still stands, but the runtime evolved from the originally
described in-process event bus. The API and workers are separate processes built from the
same backend image, and cross-context asynchronous work uses the PostgreSQL transactional
outbox with per-consumer deduplication. PostgreSQL remains the shared consistency boundary;
no external broker or service-to-service authentication layer is present.
