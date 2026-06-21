"""outbox DLQ + backoff: attempts, next_retry_at, last_error, status (R-B01)

Revision ID: 0009_outbox_dlq_backoff
Revises: 0008_gs1_provenance
Create Date: 2026-06-18

R-B01 fix — Dead-Letter Queue + exponential backoff for the transactional outbox.

Before this migration the relay tracked a single bit of lifecycle state implicitly
(`published_at IS NULL` == "needs processing"). That makes a non-transient failure
("poison pill" from the LLM) un-representable: a row that can never succeed is
indistinguishable from a fresh one, so the worker re-claims it forever, blocking
every other photo behind it. This adds the columns needed to give a failing event
a *history* and a *terminal state*:

  - attempts       how many times a handler has raised on this row
  - next_retry_at  not-before time for the next claim (exponential backoff w/ jitter)
  - last_error     the last traceback, for ops triage of the DLQ
  - status         explicit lifecycle: pending -> published | dead_letter

`published_at` is KEPT as the publication timestamp (and as the claim sentinel) so
the at-least-once / idempotency invariants and every existing fixture that drives
the relay through `published_at` stay intact. The new `status` only ADDS the
terminal `dead_letter` state; `published_at IS NULL AND status <> 'dead_letter'`
is exactly "pending and claimable". A native enum is intentionally avoided — the
codebase models small closed sets with a CHECK constraint (see idempotency_key.state,
temperature_log.source), and a CHECK is cheaper to extend than an enum value.

DDL only on a mutable working table (platform.outbox is deliberately NOT append-only,
migration 0002 §4) — no immutability/audit trigger is involved, so this is safe to
roll forward and back.
"""

from __future__ import annotations

from alembic import op

revision = "0009_outbox_dlq_backoff"
down_revision = "0008_gs1_provenance"
branch_labels = None
depends_on = None


UP = [
    # ----- 1. retry bookkeeping + terminal-state columns -------------------------
    # All NULL/0-defaulted so the existing producer INSERTs (which list only
    # event_type/payload/correlation_id/trace_id) keep working unchanged.
    "ALTER TABLE platform.outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0;",
    "ALTER TABLE platform.outbox ADD COLUMN next_retry_at timestamptz;",
    "ALTER TABLE platform.outbox ADD COLUMN last_error text;",
    "ALTER TABLE platform.outbox ADD COLUMN status text NOT NULL DEFAULT 'pending';",
    # ----- 2. backfill: rows that predate the column derive status from published_at
    "UPDATE platform.outbox SET status = 'published' WHERE published_at IS NOT NULL;",
    # ----- 3. constrain the lifecycle set (the 'enum') ---------------------------
    "ALTER TABLE platform.outbox ADD CONSTRAINT ck_outbox_status "
    "CHECK (status IN ('pending', 'published', 'dead_letter'));",
    # ----- 4. claim index: scans ONLY rows the worker can pick up ----------------
    # Replaces ix_outbox_unpublished: that one also indexed dead-lettered rows
    # (still published_at IS NULL), which we now want excluded from the hot path.
    "DROP INDEX IF EXISTS platform.ix_outbox_unpublished;",
    "CREATE INDEX ix_outbox_claimable ON platform.outbox (created_at) "
    "WHERE published_at IS NULL AND status <> 'dead_letter';",
    # ----- 5. ops index: list the DLQ cheaply for triage / requeue ---------------
    "CREATE INDEX ix_outbox_dead_letter ON platform.outbox (created_at) "
    "WHERE status = 'dead_letter';",
]


DOWN = [
    "DROP INDEX IF EXISTS platform.ix_outbox_dead_letter;",
    "DROP INDEX IF EXISTS platform.ix_outbox_claimable;",
    "CREATE INDEX ix_outbox_unpublished ON platform.outbox (created_at) "
    "WHERE published_at IS NULL;",
    "ALTER TABLE platform.outbox DROP CONSTRAINT IF EXISTS ck_outbox_status;",
    "ALTER TABLE platform.outbox DROP COLUMN IF EXISTS status;",
    "ALTER TABLE platform.outbox DROP COLUMN IF EXISTS last_error;",
    "ALTER TABLE platform.outbox DROP COLUMN IF EXISTS next_retry_at;",
    "ALTER TABLE platform.outbox DROP COLUMN IF EXISTS attempts;",
]


def upgrade() -> None:
    for stmt in UP:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
