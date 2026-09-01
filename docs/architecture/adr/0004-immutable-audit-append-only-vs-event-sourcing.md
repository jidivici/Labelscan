# ADR-0004: Immutable audit log — append-only table now, event sourcing deferred

## Status

Accepted; partially implemented

The context and alternatives below preserve the conditions recorded when this decision
was made. The current audit-write mechanism is summarized at the end.

## Context

At decision time, the system had no audit log, and its history was destructively mutable.
The brief required **all business-critical changes to be auditable**, **historical
traceability data to be immutable**, and correlation/trace identifiers to follow each
operation. Two common ways to satisfy this were a dedicated append-only audit table or full
**event sourcing** (the event log *is* the system of record and state is a projection).
The original detailed audit source material is retained in Git history; the archived
landing page no longer reproduces its numbered findings.

## Decision

Use a **dedicated append-only audit table** in PostgreSQL, written through `AuditLogPort` by every
context. Each `AuditEntry` is write-once and carries actor, action, subject reference,
before/after snapshot references, server timestamp (from `Clock`), `correlation_id`, and
`trace_id`. Immutability is enforced by DB grants (no UPDATE/DELETE) plus a trigger. **Defer event
sourcing.** Domain events are still first-class integration contracts, but aggregate state is
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
queryability, and DB-enforced append-only controls delivered sooner*. The append-only requirement
can be met without event sourcing; exact reconstruction of mutable changes still depends on the
snapshot evidence described below.

## Reversibility

**Medium-high (forward).** Because domain events already exist as published contracts, moving a
context to event sourcing later is an additive evolution (start persisting its event stream as the
source of record) rather than a redesign. The append-only audit table remains valid alongside ES.

## Current implementation note

The append-only-table decision remains active. The current write path relies primarily on
PostgreSQL audit triggers: repositories set transaction-local actor, action, correlation,
trace, and organization context, and the trigger inserts the audit row in the same
transaction. This is stronger than an optional application call, but it applies only to
tables whose migrations install and protect those triggers. Event sourcing is still not the
system-of-record model.

The implemented `audit.audit_log` row contains the event time, actor, action, subject
schema/table/ID, correlation ID, and trace ID. It does **not** contain the before/after
snapshot references specified by this decision. The append-only journal is therefore
implemented, but exact change reconstruction for mutable records is only partial and
remains open as OR-18 in the threat model.
