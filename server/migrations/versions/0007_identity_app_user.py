"""identity.app_user — credential store for the simple admin JWT auth

Revision ID: 0007_identity_app_user
Revises: 0006_traceability_haccp
Create Date: 2026-06-17

AUTH (simple JWT, single 'admin' role). Adds the credential store read by
POST /v1/auth/login.

Deliberate choices that keep the existing invariants untouched:
  - identity.app_user is MUTABLE (passwords rotate, is_active toggles) so it gets
    NO platform.deny_mutation trigger.
  - it is NOT wired to platform.audit_on_insert: it is a security/credential table,
    not a HACCP business record, and provisioning happens out-of-band (the CLI) with
    no HTTP correlation/trace context. The immutable HACCP audit trail and its
    triggers are left exactly as they are.
  - role is constrained to the single application role 'admin' (no RBAC, no
    multi-role). The 'identity' schema and the least-privilege 'labelscan_app' role
    already exist (migration 0001); this only adds a table + grants.
"""

from __future__ import annotations

from alembic import op

revision = "0007_identity_app_user"
down_revision = "0006_traceability_haccp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE identity.app_user (
            id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            username       text        NOT NULL UNIQUE,
            password_hash  text        NOT NULL,
            role           text        NOT NULL DEFAULT 'admin'
                CONSTRAINT ck_app_user_role CHECK (role IN ('admin')),
            is_active      boolean     NOT NULL DEFAULT true,
            created_at     timestamptz NOT NULL DEFAULT now(),
            updated_at     timestamptz NOT NULL DEFAULT now()
        );
        """
    )
    # least privilege: the runtime role reads for login and upserts for provisioning;
    # never DELETE (deactivate via is_active instead).
    op.execute("GRANT SELECT, INSERT, UPDATE ON identity.app_user TO labelscan_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS identity.app_user CASCADE;")
