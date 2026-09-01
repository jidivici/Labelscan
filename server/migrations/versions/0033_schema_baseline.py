"""Consolidated PostgreSQL schema baseline at the historical 0033 head.

Revision ID: 0033_trade_profiles_v2
Revises:

The companion SQL file is generated from a PostgreSQL 16 database migrated
through the original 0001-0033 chain.  It intentionally owns PostgreSQL-only
objects that SQLAlchemy metadata cannot express: partitions, RLS policies,
triggers, SECURITY DEFINER functions, grants and expression indexes.
"""

from __future__ import annotations

from pathlib import Path

from alembic import op

revision = "0033_trade_profiles_v2"
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


def _create_roles() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_app') THEN
                CREATE ROLE labelscan_app NOLOGIN;
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_auditor'
            ) THEN
                CREATE ROLE labelscan_auditor NOLOGIN;
            END IF;
        END $$;
        """
    )


def _assert_safe_role_split() -> None:
    ownership_schemas = ", ".join(
        f"'{schema}'" for schema in (*_SCHEMAS, "public")
    )
    op.execute(
        f"""
        DO $$
        DECLARE runtime_role record;
        BEGIN
            IF current_user = 'labelscan_app' THEN
                RAISE EXCEPTION
                    'unsafe migration connection: labelscan_app is the runtime role; use the separate DB migration owner';
            END IF;

            SELECT * INTO runtime_role
            FROM pg_roles WHERE rolname = 'labelscan_app';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'required runtime role labelscan_app does not exist';
            END IF;
            IF runtime_role.rolsuper OR runtime_role.rolbypassrls
               OR runtime_role.rolcreatedb OR runtime_role.rolcreaterole
               OR runtime_role.rolreplication THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app: SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION must all be disabled';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_roles privileged
                WHERE (
                    privileged.rolsuper OR privileged.rolbypassrls
                    OR privileged.rolcreatedb OR privileged.rolcreaterole
                    OR privileged.rolreplication
                )
                AND pg_has_role('labelscan_app', privileged.oid, 'member')
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app: membership reaches an elevated role';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_class object
                JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND pg_has_role('labelscan_app', object.relowner, 'member')
            ) OR EXISTS (
                SELECT 1
                FROM pg_proc function
                JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND pg_has_role('labelscan_app', function.proowner, 'member')
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app: membership reaches an application object owner';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_class object
                JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
                JOIN pg_roles owner ON owner.oid = object.relowner
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND owner.rolname = 'labelscan_app'
            ) OR EXISTS (
                SELECT 1
                FROM pg_namespace namespace
                JOIN pg_roles owner ON owner.oid = namespace.nspowner
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND owner.rolname = 'labelscan_app'
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app owns application objects; REASSIGN OWNED to the migration role first';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_database database
                JOIN pg_roles owner ON owner.oid = database.datdba
                WHERE database.datname = current_database()
                  AND (
                      owner.rolname = 'labelscan_app'
                      OR pg_has_role('labelscan_app', owner.oid, 'member')
                  )
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app owns (or can assume the owner of) the application database';
            END IF;
        END $$;
        """
    )


def _apply_schema() -> None:
    sql_path = Path(__file__).with_suffix(".sql")
    # psycopg uses percent-style client placeholders even for driver SQL.  The
    # dump contains PL/pgSQL RAISE format markers, so escape them for the client;
    # PostgreSQL receives the original single-percent function bodies.
    ddl = sql_path.read_text(encoding="utf-8").replace("%", "%%")
    op.get_bind().exec_driver_sql(ddl)
    # pg_dump deliberately clears search_path because all dump objects are
    # qualified.  Alembic still has to write its unqualified version table on
    # this same connection after upgrade() returns.
    op.execute('SET search_path TO "$user", public')


def _seed_reference_data() -> None:
    op.execute(
        """
        INSERT INTO identity.organization (slug, name)
        VALUES ('labelscan', 'LabelScan');

        INSERT INTO identity.profession (code, name)
        VALUES
            ('poissonnerie', 'Poissonnerie'),
            ('boucherie', 'Boucherie'),
            ('charcuterie_traiteur', 'Charcuterie–Traiteur');
        """
    )


def _finalize_security_ownership() -> None:
    op.execute(
        "ALTER FUNCTION platform.audit_on_insert() OWNER TO labelscan_auditor"
    )
    op.execute(
        """
        DO $$
        BEGIN
            EXECUTE format(
                'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, labelscan_app',
                current_database()
            );
        END $$;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC, labelscan_app;
        """
    )


def upgrade() -> None:
    _create_roles()
    _assert_safe_role_split()
    _apply_schema()
    _seed_reference_data()
    _finalize_security_ownership()


def downgrade() -> None:
    for schema in _SCHEMAS:
        op.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
    op.execute("DROP ROLE IF EXISTS labelscan_auditor")
    op.execute("DROP ROLE IF EXISTS labelscan_app")
