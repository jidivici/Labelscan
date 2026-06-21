"""harden SECURITY DEFINER audit function + strict, unspoofable audit context

Revision ID: 0003_harden_secdef
Revises: 0002_foundations
Create Date: 2026-06-14

PG-2 precondition. Hardens the audit machinery before the first ingestion writer
is built:

  1. Minimal owner role. The SECURITY DEFINER audit trigger previously ran as the
     migration superuser. It is re-owned by a dedicated NOLOGIN role
     `labelscan_auditor` whose ONLY privileges are USAGE on schema audit and
     INSERT on audit.audit_log. Even if the definer path were abused, it can do
     nothing but append an audit row.
  2. Fixed, empty search_path. `SET search_path = ''` on both trigger functions
     (pg_catalog is always implicitly searched, so built-ins still resolve, and
     audit.audit_log is fully schema-qualified). This closes the classic
     search-path-capture attack on SECURITY DEFINER functions.
  3. Strict context validation (anti-spoof / anti-garbage). actor_id must be a
     well-formed uuid; action/correlation_id/trace_id are length-bounded. A
     malformed audit context is rejected, so no garbage actor can be recorded.
"""

from __future__ import annotations

from alembic import op

revision = "0003_harden_secdef"
down_revision = "0002_foundations"
branch_labels = None
depends_on = None


_HARDENED_AUDIT_FN = """
CREATE OR REPLACE FUNCTION platform.audit_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_actor  text := nullif(current_setting('labelscan.actor_id',       true), '');
    v_action text := nullif(current_setting('labelscan.action',         true), '');
    v_corr   text := nullif(current_setting('labelscan.correlation_id', true), '');
    v_trace  text := nullif(current_setting('labelscan.trace_id',       true), '');
    v_actor_uuid uuid;
    v_root   oid  := COALESCE(pg_partition_root(TG_RELID), TG_RELID);
    v_schema text;
    v_table  text;
BEGIN
    IF v_actor IS NULL OR v_action IS NULL OR v_corr IS NULL OR v_trace IS NULL THEN
        RAISE EXCEPTION
            'audit context missing: SET LOCAL labelscan.{actor_id,action,correlation_id,trace_id} is required before writing %.%',
            TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'raise_exception';
    END IF;
    -- strict validation: a malformed actor cannot be recorded (anti-spoof)
    BEGIN
        v_actor_uuid := v_actor::uuid;
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid audit context: actor_id is not a uuid (got %)', v_actor
            USING ERRCODE = 'raise_exception';
    END;
    IF length(v_action) > 128 OR length(v_corr) > 200 OR length(v_trace) > 200 THEN
        RAISE EXCEPTION 'invalid audit context: field exceeds length bound'
            USING ERRCODE = 'raise_exception';
    END IF;
    -- record the LOGICAL parent table (never the physical partition)
    SELECT n.nspname, c.relname INTO v_schema, v_table
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = v_root;
    INSERT INTO audit.audit_log
        (occurred_at, actor_id, action, subject_schema, subject_table, subject_id,
         correlation_id, trace_id)
    VALUES
        (clock_timestamp(), v_actor_uuid, v_action, v_schema, v_table,
         NEW.id, v_corr, v_trace);
    RETURN NULL;
END $$;
"""

# Restores the 0002 form (superuser owner, search_path = audit,pg_catalog, no strict checks).
_PRE_HARDENING_AUDIT_FN = """
CREATE OR REPLACE FUNCTION platform.audit_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_catalog AS $$
DECLARE
    v_actor  text := nullif(current_setting('labelscan.actor_id',       true), '');
    v_action text := nullif(current_setting('labelscan.action',         true), '');
    v_corr   text := nullif(current_setting('labelscan.correlation_id', true), '');
    v_trace  text := nullif(current_setting('labelscan.trace_id',       true), '');
    v_root   oid  := COALESCE(pg_partition_root(TG_RELID), TG_RELID);
    v_schema text;
    v_table  text;
BEGIN
    IF v_actor IS NULL OR v_action IS NULL OR v_corr IS NULL OR v_trace IS NULL THEN
        RAISE EXCEPTION 'audit context missing for %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'raise_exception';
    END IF;
    SELECT n.nspname, c.relname INTO v_schema, v_table
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = v_root;
    INSERT INTO audit.audit_log
        (occurred_at, actor_id, action, subject_schema, subject_table, subject_id,
         correlation_id, trace_id)
    VALUES
        (clock_timestamp(), v_actor::uuid, v_action, v_schema, v_table, NEW.id, v_corr, v_trace);
    RETURN NULL;
END $$;
"""


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_auditor') THEN
                CREATE ROLE labelscan_auditor NOLOGIN;
            END IF;
        END $$;
        """
    )
    op.execute("GRANT USAGE ON SCHEMA audit TO labelscan_auditor")
    op.execute("GRANT INSERT ON audit.audit_log TO labelscan_auditor")
    op.execute(_HARDENED_AUDIT_FN)
    # run the definer path as the minimal role, not the superuser
    op.execute("ALTER FUNCTION platform.audit_on_insert() OWNER TO labelscan_auditor")
    # harden the immutability guard too (defence in depth; it touches no schema objects)
    op.execute("ALTER FUNCTION platform.deny_mutation() SET search_path = ''")


def downgrade() -> None:
    op.execute("ALTER FUNCTION platform.deny_mutation() RESET search_path")
    # reassign the function away from the auditor role so the role can be dropped
    op.execute("ALTER FUNCTION platform.audit_on_insert() OWNER TO CURRENT_USER")
    op.execute(_PRE_HARDENING_AUDIT_FN)
    op.execute("DROP OWNED BY labelscan_auditor")
    op.execute("DROP ROLE IF EXISTS labelscan_auditor")
