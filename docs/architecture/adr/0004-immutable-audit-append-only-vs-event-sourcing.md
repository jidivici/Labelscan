# ADR-0004: Immutable audit log — append-only table now, event sourcing deferred

## Status
Accepted & Implemented

## Context
There is no audit log today (AUDIT.md D5) and history is destructively mutable (D4). The brief
requires **all business-critical changes to be auditable** and **historical traceability data to
be immutable** (#4), with `correlation_id`/`trace_id` everywhere (#8). Two common ways to satisfy
this: a dedicated append-only audit table, or full **event sourcing** (the event log *is* the
system of record and state is a projection).

## Decision
Use a **dedicated append-only audit table** in PostgreSQL, written through `AuditLogPort` by every
context. Each `AuditEntry` is write-once and carries actor, action, subject reference,
before/after snapshot references, server timestamp (from `Clock`), `correlation_id`, and
`trace_id`. Immutability is enforced by DB grants (no UPDATE/DELETE) plus a trigger. **Defer event
sourcing.** Domain events are still first-class (§6) for integration, but aggregate state is
stored as current-state rows, not reconstructed from an event stream.

## Consequences
- **Easier:** straightforward to implement, query, and explain to auditors; current-state reads
  are trivial; immutability is a DB-level guarantee.
- **Harder:** the audit table duplicates some information that an event stream would have unified;
  if we later want full temporal reconstruction of *every* aggregate, we would migrate toward ES.

## Alternatives considered
1. **Full event sourcing now.** Rejected: high complexity (snapshots, projections, versioned
   event upcasting, eventual-consistency reads) that the team does not yet need; risk of
   architecture astronautics. The raw store (ADR-0003) + audit table already give immutability
   and reprocessability where it matters.
2. **Application-level audit (log files / app code only).** Rejected: not tamper-evident, easy to
   bypass, not queryable as a record; convention is not a guarantee.
3. **Soft-delete flags on mutable tables.** Rejected: still mutable; does not satisfy immutability
   and is easy to circumvent.

## Trade-offs
We trade *full temporal reconstruction of all state and a single unified log* for *simplicity,
queryability, and a strong DB-enforced immutability guarantee delivered sooner*. Auditability and
immutability — the actual requirements — are fully met without ES.

## Reversibility
**Medium-high (forward).** Because domain events already exist as published contracts, moving a
context to event sourcing later is an additive evolution (start persisting its event stream as the
source of record) rather than a redesign. The append-only audit table remains valid alongside ES.
</content>
