"""schemas and least-privilege app role

Revision ID: 0001_schemas_and_roles
Revises:
Create Date: 2026-06-14

PG-1 foundation, part 1/2. Establishes:
  - one schema per bounded context (schema-per-context boundary at the DB level)
  - the runtime application role `labelscan_app` (NOLOGIN; least privilege).
    The runtime role is deliberately separate from the migration/owner role so
    that table ownership (and thus the power to bypass grants) never belongs to
    the application principal.

Assumes PostgreSQL 16 (uses built-in gen_random_uuid(); no extension needed).
"""

from __future__ import annotations

from alembic import op

revision = "0001_schemas_and_roles"
down_revision = None
branch_labels = None
depends_on = None

_SCHEMAS = (
    "ingestion",
    "compliance",
    "traceability",
    "haccp",
    "audit",
    "identity",
    "platform",
)


def upgrade() -> None:
    # Runtime role: NOLOGIN — tests/app assume it via SET ROLE; CI/prod attach a
    # LOGIN role that is a member, or grant LOGIN out-of-band. Least privilege.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_app') THEN
                CREATE ROLE labelscan_app NOLOGIN;
            END IF;
        END $$;
        """
    )
    for schema in _SCHEMAS:
        op.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        op.execute(f"GRANT USAGE ON SCHEMA {schema} TO labelscan_app")


def downgrade() -> None:
    # 0002 has already dropped its objects by the time we get here.
    for schema in reversed(_SCHEMAS):
        op.execute(f"DROP SCHEMA IF EXISTS {schema} RESTRICT")
    op.execute("DROP ROLE IF EXISTS labelscan_app")
