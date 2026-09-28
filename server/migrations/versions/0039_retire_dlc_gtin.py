"""Use the V3 contract without DLC/GTIN for new records; preserve history.

Columns, JSON values, audit records and V1/V2 snapshots remain intact so that
existing reviews can finish and historical articles remain readable. Field
allow-lists are versioned in business_profiles, not narrowed on historical tables.
"""

from alembic import op

revision = "0039_retire_dlc_gtin"
down_revision = "0038_hygiene_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE ingestion.ingestion
            ALTER COLUMN trade_profile_version SET DEFAULT '3';
        ALTER TABLE traceability.batch
            ALTER COLUMN trade_profile_version SET DEFAULT '3';
        ALTER TABLE traceability.arrival_projection
            ALTER COLUMN trade_profile_version SET DEFAULT '3';
    """)


def downgrade() -> None:
    # Restore insertion defaults without relabelling any V3 record as V2.
    op.execute("""
        ALTER TABLE ingestion.ingestion
            ALTER COLUMN trade_profile_version SET DEFAULT '2';
        ALTER TABLE traceability.batch
            ALTER COLUMN trade_profile_version SET DEFAULT '2';
        ALTER TABLE traceability.arrival_projection
            ALTER COLUMN trade_profile_version SET DEFAULT '2';
    """)
