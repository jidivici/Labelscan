"""Allow immutable, decoded/re-encoded image derivatives.

Revision ID: 0034_sanitized_image_artifact
Revises: 0033_trade_profiles_v2

This is deliberately separate from the consolidated 0033 baseline: 0033 stays
byte-for-byte equivalent to the historical head, while this revision records
the one post-head schema evolution explicitly.
"""

from __future__ import annotations

from alembic import op

revision = "0034_sanitized_image_artifact"
down_revision = "0033_trade_profiles_v2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Install and validate the wider constraint before removing the old one.
    # PostgreSQL propagates the CHECK to every raw_artifact partition.
    op.execute(
        """
        ALTER TABLE ingestion.raw_artifact
            ADD CONSTRAINT ck_raw_artifact_kind_expanded CHECK (
                artifact_kind IN (
                    'image', 'sanitized_image', 'ocr_json', 'llm_output'
                )
            ) NOT VALID;
        ALTER TABLE ingestion.raw_artifact
            VALIDATE CONSTRAINT ck_raw_artifact_kind_expanded;
        ALTER TABLE ingestion.raw_artifact
            DROP CONSTRAINT ck_raw_artifact_kind;
        ALTER TABLE ingestion.raw_artifact
            RENAME CONSTRAINT ck_raw_artifact_kind_expanded
            TO ck_raw_artifact_kind;
        """
    )


def downgrade() -> None:
    # Never discard immutable sanitized artifacts to make a downgrade pass.
    # Validation fails safely if callers have not first migrated those rows.
    op.execute(
        """
        ALTER TABLE ingestion.raw_artifact
            ADD CONSTRAINT ck_raw_artifact_kind_legacy CHECK (
                artifact_kind IN ('image', 'ocr_json', 'llm_output')
            ) NOT VALID;
        ALTER TABLE ingestion.raw_artifact
            VALIDATE CONSTRAINT ck_raw_artifact_kind_legacy;
        ALTER TABLE ingestion.raw_artifact
            DROP CONSTRAINT ck_raw_artifact_kind;
        ALTER TABLE ingestion.raw_artifact
            RENAME CONSTRAINT ck_raw_artifact_kind_legacy
            TO ck_raw_artifact_kind;
        """
    )
