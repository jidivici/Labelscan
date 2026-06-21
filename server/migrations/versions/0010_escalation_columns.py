"""Work Item A escalation: raw_artifact.model + extraction_run.escalation_model

Revision ID: 0010_escalation_columns
Revises: 0009_outbox_dlq_backoff
Create Date: 2026-06-19

Work Item A (two-tier LLM escalation: Haiku primary -> Opus 4.8 escalation, both
behind LlmExtractorPort; SYNTHESIS C12). ADDITIVE, NULLABLE-ONLY — no backfill, no
CHECK change, no behaviour change while the feature flag is off.

  1. raw_artifact.model  text NULL
     Records WHICH model produced an 'llm_output' artifact. The dedup guard (the
     existence of the artifact = "this model already ran, don't call it again")
     becomes (ingestion_id, artifact_kind, model)-aware, so the primary and the
     escalation model each get at most one external call per ingestion. We KEEP
     artifact_kind = 'llm_output' for both (NO 'llm_output_escalation' kind — the
     model column is the discriminator). Legacy rows written before this migration
     have model NULL and count as the PRIMARY (the _ensure_llm primary query matches
     `model = :primary OR model IS NULL`).

  2. extraction_run.escalation_model  text NULL
     Set to the escalation model id on the runs where escalation actually ran; NULL
     on every legacy/primary-only run. extraction_run stays append-only and is_latest
     stays intact (we add a column, never update a row).

We deliberately do NOT add a per-field model column on extracted_field: an escalated
value's source stays 'llm' (the run's escalation_model records that the second tier
was used; per-field model is out of scope, Decision 8).

Same safety envelope as 0008/0009: this is DDL on the table structure only. The
append-only row triggers (BEFORE UPDATE OR DELETE on extraction_run; the immutable
raw store on raw_artifact) are FOR EACH ROW on DML and do NOT fire on ALTER TABLE.
ADD COLUMN ... (nullable, no default) is a metadata-only change in PostgreSQL — no
row rewrite. The existing table-level `GRANT SELECT, INSERT` (0002 raw_artifact,
0005 extraction_run) already covers future columns, so no new grant is required.
"""

from __future__ import annotations

from alembic import op

revision = "0010_escalation_columns"
down_revision = "0009_outbox_dlq_backoff"
branch_labels = None
depends_on = None


UP = [
    # Which model produced this llm_output artifact (NULL == legacy primary).
    "ALTER TABLE ingestion.raw_artifact ADD COLUMN model text;",
    # Escalation model id, set only on runs where the second tier ran (NULL otherwise).
    "ALTER TABLE ingestion.extraction_run ADD COLUMN escalation_model text;",
]


DOWN = [
    "ALTER TABLE ingestion.extraction_run DROP COLUMN IF EXISTS escalation_model;",
    "ALTER TABLE ingestion.raw_artifact DROP COLUMN IF EXISTS model;",
]


def upgrade() -> None:
    for stmt in UP:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
