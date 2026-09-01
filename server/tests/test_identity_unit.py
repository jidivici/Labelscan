"""Unit proofs for the identity primitives — NO database required.

Covers password hashing, the JWT codec, and the Login use case (with a fake repo),
so the security-critical logic is verified even without PostgreSQL.
"""

from __future__ import annotations

import os
import time

import jwt
import pytest
from pydantic import ValidationError

from labelscan.contexts.identity.adapters.http.access_router import (
    CreateIdentityRequest,
    CreateManagerRequest,
)
from labelscan.contexts.identity.adapters.http.router import LoginRequest
from labelscan.contexts.identity.adapters.http.store_admin_router import (
    CreateStoreRequest,
)
from labelscan.contexts.identity.application.login import InvalidCredentials, Login
from labelscan.contexts.identity.application.sessions import refresh_ttl_seconds
from labelscan.contexts.identity.domain.password import hash_password, verify_password
from labelscan.contexts.identity.domain.store import (
    normalize_store_code,
    normalize_store_name,
    normalize_store_query,
)
from labelscan.contexts.identity.domain.user import (
    ADMIN_SCOPES,
    MANAGER_SCOPES,
    SUPER_ADMIN_SCOPES,
    USER_ROLES,
    StoredUser,
    normalize_identity_text,
    scopes_for_role,
)
from labelscan.platform.http import jwt as jwt_codec
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import _principal_from_bearer

ADMIN_ID = "11111111-1111-1111-1111-111111111111"


# ── password hashing ────────────────────────────────────────────────────────


def test_password_roundtrip():
    enc = hash_password("s3cr3t-passphrase")
    assert enc.startswith("pbkdf2_sha256$")
    assert verify_password("s3cr3t-passphrase", enc)
    assert not verify_password("wrong-pw", enc)


def test_password_salt_is_random():
    assert hash_password("same passphrase") != hash_password("same passphrase")


def test_password_rejects_empty():
    with pytest.raises(ValueError):
        hash_password("")


def test_verify_handles_garbage_without_raising():
    assert not verify_password("x", "not-an-encoded-hash")
    assert not verify_password("x", "")
    assert not verify_password(
        "x",
        "pbkdf2_sha256$999999999$MDEyMzQ1Njc4OWFiY2RlZg$"
        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    )


# ── JWT codec ───────────────────────────────────────────────────────────────


def test_jwt_roundtrip_preserves_claims():
    token = jwt_codec.encode(
        {
            "sub": "admin",
            "actor_id": ADMIN_ID,
            "principal": "admin",
            "scopes": sorted(ADMIN_SCOPES),
            "role": "admin",
        },
        ttl_seconds=60,
    )
    claims = jwt_codec.decode(token)
    assert claims["actor_id"] == ADMIN_ID
    assert claims["role"] == "admin"
    assert set(claims["scopes"]) == set(ADMIN_SCOPES)
    assert claims["exp"] > claims["iat"]


def test_jwt_expired_is_rejected():
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": "admin",
            "iss": "labelscan-api",
            "aud": "labelscan-clients",
            "jti": "expired-test-token",
            "iat": now - 60,
            "exp": now - 1,
        },
        os.environ["LABELSCAN_JWT_SECRET"],
        algorithm="HS256",
    )
    with pytest.raises(jwt_codec.TokenError):
        jwt_codec.decode(token)


def test_jwt_tampered_is_rejected():
    token = jwt_codec.encode({"sub": "admin"}, ttl_seconds=60)
    with pytest.raises(jwt_codec.TokenError):
        jwt_codec.decode(token + "tamper")


def test_jwt_rejects_a_token_for_another_audience(monkeypatch):
    monkeypatch.setenv("LABELSCAN_JWT_AUDIENCE", "labelscan-clients")
    token = jwt_codec.encode({"sub": "actor-1", "actor_id": "actor-1", "scopes": []})
    monkeypatch.setenv("LABELSCAN_JWT_AUDIENCE", "another-service")
    with pytest.raises(jwt_codec.TokenError):
        jwt_codec.decode(token)


def test_production_principal_requires_tenant_claims(monkeypatch):
    monkeypatch.setenv("LABELSCAN_ENV", "production")
    token = jwt_codec.encode(
        {
            "sub": "admin",
            "actor_id": ADMIN_ID,
            "scopes": [],
            "sid": "session-family",
        }
    )
    with pytest.raises(ApiError, match="UNAUTHENTICATED"):
        _principal_from_bearer(token)


def test_production_principal_rejects_noncanonical_claim_shapes(monkeypatch):
    monkeypatch.setenv("LABELSCAN_ENV", "production")
    token = jwt_codec.encode(
        {
            "sub": "admin",
            "actor_id": ADMIN_ID,
            "principal": "admin",
            "scopes": "catalog:read",
            "role": "admin",
            "organization_id": "22222222-2222-2222-2222-222222222222",
            "organization_slug": "labelscan",
            "sid": "33333333-3333-3333-3333-333333333333",
        }
    )
    with pytest.raises(ApiError) as rejected:
        _principal_from_bearer(token)
    assert rejected.value.error_code == "UNAUTHENTICATED"
    assert rejected.value.detail == "invalid or expired token"


def test_configured_token_lifetimes_are_bounded(monkeypatch):
    monkeypatch.setenv("LABELSCAN_JWT_TTL_SECONDS", "3601")
    with pytest.raises(RuntimeError, match="must not exceed 3600"):
        jwt_codec.default_ttl_seconds()

    monkeypatch.setenv("LABELSCAN_REFRESH_TTL_SECONDS", "2592001")
    with pytest.raises(RuntimeError, match="must not exceed 2592000"):
        refresh_ttl_seconds()

    with pytest.raises(RuntimeError, match="between 1 and 3600"):
        jwt_codec.encode({"sub": "admin"}, ttl_seconds=3601)


# ── Login use case ──────────────────────────────────────────────────────────


class _FakeRepo:
    def __init__(self, user: StoredUser | None) -> None:
        self._user = user

    def find_active_by_username(self, username: str) -> StoredUser | None:
        if self._user and self._user.username == username:
            return self._user
        return None


def _admin(password: str) -> StoredUser:
    return StoredUser(
        id=ADMIN_ID,
        username="admin",
        display_name="Administrator",
        password_hash=hash_password(password),
        role="admin",
        active=True,
        store_code=None,
    )


def test_login_success_maps_admin_scopes():
    user = Login(_FakeRepo(_admin("valid passphrase")))("admin", "valid passphrase")
    assert user.actor_id == ADMIN_ID
    assert user.username == "admin"
    assert user.display_name == "Administrator"
    assert user.role == "admin"
    assert user.scopes == ADMIN_SCOPES


def test_login_wrong_password_rejected():
    with pytest.raises(InvalidCredentials):
        Login(_FakeRepo(_admin("valid passphrase")))("admin", "nope")


def test_login_unknown_user_rejected():
    with pytest.raises(InvalidCredentials):
        Login(_FakeRepo(None))("ghost", "pw")


# ── RBAC and identity normalization ────────────────────────────────────────


def test_role_scope_matrix_is_additive_and_fail_closed():
    assert USER_ROLES == {"super_admin", "admin", "manager"}
    assert MANAGER_SCOPES < ADMIN_SCOPES
    assert ADMIN_SCOPES < SUPER_ADMIN_SCOPES
    assert "identity:admin" in ADMIN_SCOPES
    assert "identity:admin" not in MANAGER_SCOPES
    assert "identity:admins:manage" in SUPER_ADMIN_SCOPES
    assert "identity:admins:manage" not in ADMIN_SCOPES
    assert "identity:read" in MANAGER_SCOPES
    assert "catalog:read" in MANAGER_SCOPES
    assert scopes_for_role("unknown") == frozenset()


def test_store_code_is_canonical_and_rejects_unsafe_characters():
    assert normalize_store_code(" paris-01 ") == "PARIS-01"
    with pytest.raises(ValueError):
        normalize_store_code("Paris centre")


@pytest.mark.parametrize("value", ["safe\nname", "safe\x00name", "safe\u202ename"])
def test_identity_and_store_labels_reject_controls_and_bidi(value: str) -> None:
    with pytest.raises(ValueError):
        normalize_identity_text(value, field="username", maximum=254)
    with pytest.raises(ValueError):
        normalize_store_name(value)
    with pytest.raises(ValueError):
        normalize_store_query(value)


def test_identity_and_store_labels_are_nfc_canonical() -> None:
    assert (
        normalize_identity_text("Cafe\u0301", field="display_name", maximum=120)
        == "Café"
    )
    assert normalize_store_name("Marche\u0301 central") == "Marché central"


def test_login_maps_spoofed_username_to_generic_invalid_credentials() -> None:
    with pytest.raises(InvalidCredentials):
        Login(_FakeRepo(None))("admin\u202etxt", "not-the-password")


@pytest.mark.parametrize(
    "model,payload",
    [
        (
            LoginRequest,
            {"username": "admin\n", "password": "password"},
        ),
        (
            CreateIdentityRequest,
            {
                "username": "manager",
                "display_name": "visible\u202etxt",
                "password": "manager-password-123",
            },
        ),
        (
            CreateStoreRequest,
            {
                "name": "Store\x00hidden",
                "profession_codes": ["poissonnerie"],
            },
        ),
    ],
)
def test_http_identity_models_reject_controls_before_whitespace_stripping(
    model, payload
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_manager_body_accepts_only_canonical_typed_uuid_strings() -> None:
    payload = {
        "username": "manager",
        "display_name": "Manager",
        "password": "manager-password-123",
        "business_portal_ids": ["22222222-2222-2222-2222-222222222222"],
    }
    assert str(
        CreateManagerRequest.model_validate(payload).business_portal_ids[0]
    ) == payload["business_portal_ids"][0]

    payload["business_portal_ids"] = ["22222222-2222-2222-2222-22222222222A"]
    with pytest.raises(ValidationError):
        CreateManagerRequest.model_validate(payload)
