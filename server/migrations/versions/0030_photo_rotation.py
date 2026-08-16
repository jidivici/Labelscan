"""Persist the operator-approved product photo orientation."""

from alembic import op

revision = "0030_photo_rotation"
down_revision = "0029_soft_delete_managers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ingestion.ingestion ADD COLUMN photo_rotation_degrees "
        "smallint NOT NULL DEFAULT 0 CHECK (photo_rotation_degrees IN (0, 180))"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE ingestion.ingestion DROP COLUMN photo_rotation_degrees")
