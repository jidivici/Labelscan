"""rotating refresh-token sessions

Revision ID: 0024_auth_sessions
Revises: 0023_remove_mobile_activation
Create Date: 2026-08-03

Refresh tokens are opaque client credentials. Only their SHA-256 digests are
stored. Every rotation appends a row in the same family; replaying a consumed
token revokes the complete family, including all access tokens carrying its sid.
"""

from __future__ import annotations

from alembic import op

revision = "0024_auth_sessions"
down_revision = "0023_remove_mobile_activation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE identity.auth_session (
            id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            family_id          uuid        NOT NULL,
            organization_id    uuid        NOT NULL REFERENCES identity.organization(id),
            user_id            uuid        NOT NULL REFERENCES identity.app_user(id)
                                      ON DELETE CASCADE,
            refresh_token_hash text        NOT NULL UNIQUE,
            refresh_expires_at timestamptz NOT NULL,
            consumed_at        timestamptz,
            revoked_at         timestamptz,
            replaced_by_id     uuid        REFERENCES identity.auth_session(id),
            created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT ck_auth_session_expiry CHECK (refresh_expires_at > created_at)
        );
        CREATE INDEX ix_auth_session_family
            ON identity.auth_session (family_id, refresh_expires_at DESC);
        CREATE INDEX ix_auth_session_user
            ON identity.auth_session (organization_id, user_id, refresh_expires_at DESC);

        GRANT SELECT, INSERT, UPDATE ON identity.auth_session TO labelscan_app;
        ALTER TABLE identity.auth_session ENABLE ROW LEVEL SECURITY;
        CREATE POLICY identity_auth_session_refresh_lookup
            ON identity.auth_session FOR SELECT
            USING (true);
        CREATE POLICY identity_auth_session_tenant_write
            ON identity.auth_session FOR INSERT
            WITH CHECK (
                current_setting('labelscan.system_access', true) = 'true'
                OR organization_id::text =
                    current_setting('labelscan.organization_id', true)
            );
        CREATE POLICY identity_auth_session_tenant_update
            ON identity.auth_session FOR UPDATE
            USING (
                current_setting('labelscan.system_access', true) = 'true'
                OR organization_id::text =
                    current_setting('labelscan.organization_id', true)
            )
            WITH CHECK (
                current_setting('labelscan.system_access', true) = 'true'
                OR organization_id::text =
                    current_setting('labelscan.organization_id', true)
            );
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE identity.auth_session;")
