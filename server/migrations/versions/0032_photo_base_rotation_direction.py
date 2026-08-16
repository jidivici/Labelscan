"""Allow either display quarter-turn for a captured landscape photo."""

from alembic import op

revision = "0032_photo_base_rotation_direction"
down_revision = "0031_photo_base_rotation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "DROP CONSTRAINT ingestion_photo_base_rotation_degrees_check"
    )
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "ADD CONSTRAINT ingestion_photo_base_rotation_degrees_check "
        "CHECK (photo_base_rotation_degrees IN (-90, 0, 90))"
    )


def downgrade() -> None:
    # Preserve readable display for the new direction before restoring the old
    # two-value constraint.
    op.execute(
        "UPDATE ingestion.ingestion SET photo_base_rotation_degrees = -90 "
        "WHERE photo_base_rotation_degrees = 90"
    )
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "DROP CONSTRAINT ingestion_photo_base_rotation_degrees_check"
    )
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "ADD CONSTRAINT ingestion_photo_base_rotation_degrees_check "
        "CHECK (photo_base_rotation_degrees IN (-90, 0))"
    )
