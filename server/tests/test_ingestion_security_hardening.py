"""Security boundary proofs for ingestion fields, idempotency and DB tenancy."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from sqlalchemy import text

from labelscan.contexts.ingestion.adapters.http.read_router import (
    FieldView,
    _requires_recapture,
)
from labelscan.contexts.ingestion.domain.input_validation import (
    validate_barcode_raw,
    validate_client_captured_at,
    validate_human_field_value,
    validate_idempotency_key,
    validate_note,
)


@pytest.mark.parametrize(
    "value",
    ["bad key", "../escape", "line\nbreak", "nul\x00byte", "\u202etxt.exe"],
)
def test_idempotency_key_rejects_ambiguous_or_control_input(value: str) -> None:
    with pytest.raises(ValueError):
        validate_idempotency_key(value, required=True)


def test_idempotency_key_accepts_mobile_uuid_style_keys() -> None:
    key = f"review:{uuid.uuid4()}"
    assert validate_idempotency_key(key, required=True) == key


def test_barcode_allows_gs1_separator_but_rejects_other_controls() -> None:
    raw = "0103700161210047\x1d10LOT-7"
    assert validate_barcode_raw(raw) == raw
    with pytest.raises(ValueError):
        validate_barcode_raw("0103700161210047\n10LOT-7")


@pytest.mark.parametrize(
    "value",
    ["2026-08-20", "2026-08-20T10:00:00", "not-a-date", "2026-13-40T10:00Z"],
)
def test_capture_timestamp_requires_valid_timezone_aware_iso8601(value: str) -> None:
    with pytest.raises(ValueError):
        validate_client_captured_at(value)


def test_capture_timestamp_is_canonicalized_to_utc() -> None:
    assert (
        validate_client_captured_at("2026-08-20T12:30:00+02:00")
        == "2026-08-20T10:30:00Z"
    )


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("expiry_date", "2026-02-30"),
        ("production_method", "unknown"),
        ("gtin", "40063813339"),  # unsupported length
        ("commercial_designation", "safe\u202eevil"),
        ("ingredients", "safe\x00evil"),
    ],
)
def test_human_review_rejects_malformed_or_spoofed_values(
    field_name: str, value: str
) -> None:
    with pytest.raises(ValueError):
        validate_human_field_value(field_name, value)


def test_human_review_accepts_canonical_safety_values_and_nc() -> None:
    assert validate_human_field_value("expiry_date", "2026-08-31") == "2026-08-31"
    assert (
        validate_human_field_value("production_method", "wild_caught") == "wild_caught"
    )
    assert validate_human_field_value("gtin", "4006381333931") == "4006381333931"
    assert validate_human_field_value("gtin", "93000502900206") == "93000502900206"
    assert validate_human_field_value("gtin", "nc") == "NC"


def test_notes_allow_newlines_but_not_direction_spoofing() -> None:
    assert validate_note("Ligne 1\nLigne 2") == "Ligne 1\nLigne 2"
    with pytest.raises(ValueError):
        validate_note("visible\u202etxt.exe")


def _field_view(
    value: str | None, validation_status: str | None = None
) -> FieldView:
    return FieldView(
        field_name="commercial_designation",
        value=value,
        evidence=None,
        provenance=None,
        source_raw_artifact_id=None,
        validation_status=validation_status or ("missing" if value is None else "present"),
        warnings=[],
        llm_confidence=0.0,
        ocr_confidence=0.0,
        combined_confidence=0.0,
        confidence_band="low",
        source="llm",
        created_at="2026-08-20T00:00:00Z",
    )


def test_zero_extracted_fields_requires_photo_recapture() -> None:
    assert _requires_recapture("needs_review", []) is True
    assert _requires_recapture("ocr_skipped_garbage", [_field_view(None)]) is True
    assert _requires_recapture("needs_review", [_field_view("   ")]) is True
    assert _requires_recapture("needs_review", [_field_view("NC")]) is True
    assert _requires_recapture(
        "needs_review", [_field_view("valeur", "invalid")]
    ) is True
    assert _requires_recapture("needs_review", [_field_view("Cabillaud")]) is False
    assert _requires_recapture("extraction_failed", []) is False


def test_vps_bootstrap_separates_runtime_from_database_owner() -> None:
    deploy_script = (
        Path(__file__).resolve().parents[2] / "deploy" / "hostinger" / "deploy.sh"
    ).read_text(encoding="utf-8")

    assert 'DB_ROLE_MARKER="${APP_ROOT}/.database-roles-v4"' in deploy_script
    assert "SELECT CASE WHEN oid = 10 THEN 1 ELSE 0 END" in deploy_script
    assert "ALTER ROLE labelscan_app RENAME TO labelscan_db_admin;" in deploy_script
    assert "REVOKE labelscan_db_admin FROM labelscan_app;" in deploy_script
    assert "FROM pg_auth_members membership" in deploy_script
    assert "psql -U labelscan_db_admin -d labelscan" in deploy_script
    assert 'up -d --no-deps db' in deploy_script
    assert 'readonly APP_SECRET_GID="10001"' in deploy_script
    assert "grant_application_secret_access" in deploy_script
    assert 'chown root:"$APP_SECRET_GID" "$target"' in deploy_script
    assert 'chmod 640 "$target"' in deploy_script


def test_privileged_deploy_trusts_only_its_checkout_for_git_validation() -> None:
    deploy_script = (
        Path(__file__).resolve().parents[2] / "deploy" / "hostinger" / "deploy.sh"
    ).read_text(encoding="utf-8")

    assert 'git -c safe.directory="$checkout_root" -C "$checkout_root"' in deploy_script
    assert "git config --global" not in deploy_script
    assert '[[ "$checkout_head" == "$commit_sha" ]]' in deploy_script


def test_vps_healthcheck_uses_the_allowed_production_host() -> None:
    compose = (
        Path(__file__).resolve().parents[2]
        / "deploy"
        / "compose"
        / "single-vps.yml"
    ).read_text(encoding="utf-8")

    assert "http://127.0.0.1:8000/v1/health/live" in compose
    assert "headers={'Host': 'label-scan.fr'}" in compose


def test_guarded_demo_reset_uses_the_maintenance_database_role() -> None:
    compose = (
        Path(__file__).resolve().parents[2]
        / "deploy"
        / "compose"
        / "single-vps.yml"
    ).read_text(encoding="utf-8")
    demo_service = compose.split("\n  demo:\n", 1)[1].split(
        "\n  secure_demo_credentials:\n", 1
    )[0]

    assert "profiles: [demo-reset]" in demo_service
    assert "DATABASE_URL_FILE: /run/secrets/database_admin_url" in demo_service
    assert "secrets: [database_admin_url, demo_credentials]" in demo_service
    assert "DATABASE_URL_FILE: /run/secrets/database_url" not in demo_service


def test_runtime_role_is_neither_elevated_nor_application_owner(engine) -> None:
    with engine.connect() as conn:
        role = conn.execute(
            text(
                "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, "
                "rolreplication FROM pg_roles WHERE rolname = 'labelscan_app'"
            )
        ).one()
        owned_count = conn.execute(
            text(
                "SELECT count(*) FROM pg_class object "
                "JOIN pg_namespace namespace ON namespace.oid = object.relnamespace "
                "JOIN pg_roles owner ON owner.oid = object.relowner "
                "WHERE namespace.nspname = ANY(:schemas) "
                "AND owner.rolname = 'labelscan_app'"
            ),
            {
                "schemas": [
                    "ingestion",
                    "compliance",
                    "traceability",
                    "haccp",
                    "audit",
                    "identity",
                    "platform",
                    "public",
                ]
            },
        ).scalar_one()
        owner_membership_count = conn.execute(
            text(
                "SELECT count(*) FROM pg_class object "
                "JOIN pg_namespace namespace ON namespace.oid = object.relnamespace "
                "WHERE namespace.nspname = ANY(:schemas) "
                "AND pg_has_role('labelscan_app', object.relowner, 'member')"
            ),
            {
                "schemas": [
                    "ingestion",
                    "compliance",
                    "traceability",
                    "haccp",
                    "audit",
                    "identity",
                    "platform",
                    "public",
                ]
            },
        ).scalar_one()
        owns_database = conn.execute(
            text(
                "SELECT owner.rolname = 'labelscan_app' "
                "OR pg_has_role('labelscan_app', owner.oid, 'member') "
                "FROM pg_database database "
                "JOIN pg_roles owner ON owner.oid = database.datdba "
                "WHERE database.datname = current_database()"
            )
        ).scalar_one()
    assert not any(role)
    assert owned_count == 0
    assert owner_membership_count == 0
    assert owns_database is False


@pytest.mark.parametrize(
    "table",
    [
        "ingestion.ingestion",
        "ingestion.raw_artifact",
        "ingestion.extraction_run",
        "ingestion.extracted_field",
        "ingestion.interim_field",
        "ingestion.request_idempotency",
        "identity.app_user",
        "identity.auth_session",
        "traceability.batch",
        "traceability.arrival_projection",
        "haccp.alert",
    ],
)
def test_tenant_tables_force_row_level_security(engine, table: str) -> None:
    schema, name = table.split(".")
    with engine.connect() as conn:
        row_security, force_row_security = conn.execute(
            text(
                "SELECT class.relrowsecurity, class.relforcerowsecurity "
                "FROM pg_class class "
                "JOIN pg_namespace namespace ON namespace.oid = class.relnamespace "
                "WHERE namespace.nspname = :schema AND class.relname = :name"
            ),
            {"schema": schema, "name": name},
        ).one()
    assert row_security is True
    assert force_row_security is True


def test_runtime_role_cannot_delete_or_update_immutable_ingestion_data(engine) -> None:
    with engine.connect() as conn:
        privileges = conn.execute(
            text(
                "SELECT "
                "has_table_privilege('labelscan_app', 'ingestion.raw_artifact', 'DELETE'), "
                "has_table_privilege('labelscan_app', 'ingestion.extraction_run', 'UPDATE'), "
                "has_table_privilege('labelscan_app', 'ingestion.extracted_field', 'DELETE'), "
                "has_table_privilege('labelscan_app', 'audit.audit_log', 'INSERT')"
            )
        ).one()
    assert not any(privileges)
