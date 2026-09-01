-- Migration 0007: identity.app_user — credential store for JWT auth
-- See server/migrations/versions/0007_identity_app_user.py for the actual migration.
-- This is the design reference DDL.

CREATE TABLE identity.app_user (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    username       text        NOT NULL UNIQUE,
    password_hash  text        NOT NULL,                         -- PBKDF2-HMAC-SHA256, 600k iterations
    role           text        NOT NULL DEFAULT 'admin'
                     CONSTRAINT ck_app_user_role CHECK (role IN ('admin')),
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Grants: labelscan_app gets SELECT, INSERT, UPDATE (never DELETE — deactivate instead).
-- Mutable table (no deny_mutation trigger — passwords rotate, is_active toggles).
-- NOT wired to audit_on_insert (security/credential table, not HACCP business record).
