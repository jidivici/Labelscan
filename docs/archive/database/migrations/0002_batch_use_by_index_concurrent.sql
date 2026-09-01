-- =============================================================================
-- Migration 0002 — add an index CONCURRENTLY (zero-downtime, no table lock)
-- =============================================================================
-- Demonstrates the online-index caveat (BACKEND §11.2 / DATABASE.md §6):
-- CREATE INDEX CONCURRENTLY CANNOT run inside a transaction block. Alembic must run this
-- with the autocommit/"transaction_per_migration = False" escape hatch (op.execute on a
-- connection with AUTOCOMMIT), NOT inside the default per-migration transaction.
--
-- This index supports the HACCP expiry-window scan (DATABASE.md §4 query 4) on a hot,
-- non-null subset (partial index keeps it small => less write amplification).
--
-- NO transaction wrapper here on purpose.

-- == UP ==
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_batch_use_by_concurrent
    ON traceability.batch (use_by)
    WHERE use_by IS NOT NULL;

-- == DOWN ==
-- DROP INDEX CONCURRENTLY also cannot run in a txn:
-- DROP INDEX CONCURRENTLY IF EXISTS traceability.idx_batch_use_by_concurrent;

-- CAVEAT: CREATE INDEX CONCURRENTLY can leave an INVALID index behind if it fails midway
-- (e.g. a duplicate-violation on a UNIQUE concurrent build). The migration tooling must check
-- pg_index.indisvalid afterwards and DROP+retry the invalid index rather than assume success.
