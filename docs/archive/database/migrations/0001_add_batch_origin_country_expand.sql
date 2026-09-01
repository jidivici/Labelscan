-- =============================================================================
-- Migration 0001 — EXPAND: add nullable traceability.batch.origin_country_iso2
-- =============================================================================
-- Illustrative expand-and-contract step (BACKEND §11.2). This is the EXPAND phase:
-- add a NULLABLE column (no table rewrite, no long lock in PG 16 for a nullable add
-- with no default). Backfill happens in a SEPARATE migration (0002); enforce NOT NULL
-- only after backfill+parity in a still-later contract step.
--
-- Reversible: the DOWN drops the column. Safe because nothing reads it yet (expand phase).
-- Run OUTSIDE any "add index concurrently" txn — this migration is a single transaction.

-- == UP ==
BEGIN;
ALTER TABLE traceability.batch
    ADD COLUMN origin_country_iso2 text;                       -- nullable, no default => metadata-only change
ALTER TABLE traceability.batch
    ADD CONSTRAINT ck_batch_origin_iso2_shape
    CHECK (origin_country_iso2 IS NULL OR origin_country_iso2 ~ '^[A-Z]{2}$') NOT VALID;
-- NOT VALID => constraint applies to new/updated rows immediately without scanning existing rows
-- (no long lock). VALIDATE it in a later step once backfilled:
--   ALTER TABLE traceability.batch VALIDATE CONSTRAINT ck_batch_origin_iso2_shape;
COMMIT;

-- == DOWN ==
-- BEGIN;
-- ALTER TABLE traceability.batch DROP CONSTRAINT IF EXISTS ck_batch_origin_iso2_shape;
-- ALTER TABLE traceability.batch DROP COLUMN IF EXISTS origin_country_iso2;
-- COMMIT;
