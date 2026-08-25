"""Activate trade-profile V2 without the price field.

Revision ID: 0033_trade_profiles_v2
Revises: 0032_ingestion_db_hardening
Create Date: 2026-08-24

Confirmed V1 ingestions remain immutable and readable. Only unfinished workflows are
advanced to V2 so the deployed mobile client can finalize them with the new contract.
"""

from alembic import op

revision = "0033_trade_profiles_v2"
down_revision = "0032_ingestion_db_hardening"
branch_labels = None
depends_on = None


def _set_audit_context(action: str) -> None:
    """Attribute the intentional workflow backfill to this migration."""

    op.execute(
        "SELECT set_config('labelscan.actor_id', "
        "'00000000-0000-0000-0000-000000000000', true)"
    )
    op.execute(f"SELECT set_config('labelscan.action', '{action}', true)")
    op.execute(
        "SELECT set_config('labelscan.correlation_id', 'migration-0033', true)"
    )
    op.execute("SELECT set_config('labelscan.trace_id', 'migration-0033', true)")


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "ALTER COLUMN trade_profile_version SET DEFAULT '2'"
    )
    op.execute(
        "ALTER TABLE traceability.batch "
        "ALTER COLUMN trade_profile_version SET DEFAULT '2'"
    )
    op.execute(
        "ALTER TABLE traceability.arrival_projection "
        "ALTER COLUMN trade_profile_version SET DEFAULT '2'"
    )
    _set_audit_context("ingestion.trade_profile_v2_activated")
    op.execute(
        """
        UPDATE ingestion.ingestion
        SET trade_profile_version = '2'
        WHERE trade_profile_version = '1'
          AND status NOT IN ('confirmed', 'rejected')
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "ALTER COLUMN trade_profile_version SET DEFAULT '1'"
    )
    op.execute(
        "ALTER TABLE traceability.batch "
        "ALTER COLUMN trade_profile_version SET DEFAULT '1'"
    )
    op.execute(
        "ALTER TABLE traceability.arrival_projection "
        "ALTER COLUMN trade_profile_version SET DEFAULT '1'"
    )
    _set_audit_context("ingestion.trade_profile_v2_reverted")
    op.execute(
        """
        UPDATE ingestion.ingestion
        SET trade_profile_version = '1'
        WHERE trade_profile_version = '2'
          AND status NOT IN ('confirmed', 'rejected')
        """
    )
