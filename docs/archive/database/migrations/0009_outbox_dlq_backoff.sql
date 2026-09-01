-- Migration 0009: outbox DLQ + exponential backoff
-- See server/migrations/versions/0009_outbox_dlq_backoff.py for the actual migration.
-- This is the design reference DDL.

-- Retry bookkeeping + terminal-state columns
ALTER TABLE platform.outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE platform.outbox ADD COLUMN next_retry_at timestamptz;
ALTER TABLE platform.outbox ADD COLUMN last_error text;
ALTER TABLE platform.outbox ADD COLUMN status text NOT NULL DEFAULT 'pending';

-- Backfill: rows that predate the column derive status from published_at
UPDATE platform.outbox SET status = 'published' WHERE published_at IS NOT NULL;

-- Constrain the lifecycle set
ALTER TABLE platform.outbox ADD CONSTRAINT ck_outbox_status
    CHECK (status IN ('pending', 'published', 'dead_letter'));

-- Replace old claim index (excluded dead-lettered rows from hot path)
DROP INDEX IF EXISTS platform.ix_outbox_unpublished;
CREATE INDEX ix_outbox_claimable ON platform.outbox (created_at)
    WHERE published_at IS NULL AND status <> 'dead_letter';

-- Ops index: list the DLQ cheaply for triage / requeue
CREATE INDEX ix_outbox_dead_letter ON platform.outbox (created_at)
    WHERE status = 'dead_letter';
