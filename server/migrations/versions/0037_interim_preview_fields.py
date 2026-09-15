"""Allow the deterministic approval-mark and production-method previews.

Revision ID: 0037_interim_preview_fields
Revises: 0036_manager_store_credentials
"""

from alembic import op

revision = "0037_interim_preview_fields"
down_revision = "0036_manager_store_credentials"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE ingestion.interim_field
            DROP CONSTRAINT interim_field_field_name_check;
        ALTER TABLE ingestion.interim_field
            ADD CONSTRAINT interim_field_field_name_check CHECK (
                field_name IN ('expiry_date', 'packaging_date', 'storage_temperature',
                               'price', 'batch_number', 'health_mark', 'production_method')
            );
    """)


def downgrade() -> None:
    # Fail without deleting previews if new field names are still stored.
    op.execute("""
        ALTER TABLE ingestion.interim_field
            DROP CONSTRAINT interim_field_field_name_check;
        ALTER TABLE ingestion.interim_field
            ADD CONSTRAINT interim_field_field_name_check CHECK (
                field_name IN ('expiry_date', 'packaging_date', 'storage_temperature',
                               'price', 'batch_number')
            );
    """)
