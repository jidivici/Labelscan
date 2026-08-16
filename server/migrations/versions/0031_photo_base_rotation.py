"""Distinguish historical display rotation from upright landscape captures."""

from alembic import op

revision = "0031_photo_base_rotation"
down_revision = "0030_photo_rotation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing files were captured through the portrait-locked UI and require the
    # historical left quarter-turn. New landscape captures set this to 0 at review.
    op.execute(
        "ALTER TABLE ingestion.ingestion ADD COLUMN photo_base_rotation_degrees "
        "smallint NOT NULL DEFAULT -90 "
        "CHECK (photo_base_rotation_degrees IN (-90, 0))"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE ingestion.ingestion DROP COLUMN photo_base_rotation_degrees"
    )
