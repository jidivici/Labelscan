"""Unit proofs for the identity primitives — NO database required.

Covers password hashing, the JWT codec, and the Login use case (with a fake repo),
so the security-critical logic is verified even without PostgreSQL.
"""

from __future__ import annotations

import pytest

from labelscan.contexts.identity.application.login import InvalidCredentials, Login
from labelscan.contexts.identity.application.manage_users import (
    CreateUserCommand,
    UpdateUserCommand,
    UserAdminService,
)
from labelscan.contexts.identity.application.ports import AdminAuditContext
from labelscan.contexts.identity.application.store_ports import StoreRequired
from labelscan.contexts.identity.domain.password import hash_password, verify_password
from labelscan.contexts.identity.domain.store import normalize_store_code
from labelscan.contexts.identity.domain.user import (
    ADMIN_SCOPES,
    OPERATOR_SCOPES,
    USER_ROLES,
    ManagedUser,
    StoredUser,
    scopes_for_role,
)
from labelscan.platform.http import jwt as jwt_codec

ADMIN_ID = "11111111-1111-1111-1111-111111111111"


# ── password hashing ────────────────────────────────────────────────────────


def test_password_roundtrip():
    enc = hash_password("s3cr3t-pw")
    assert enc.startswith("pbkdf2_sha256$")
    assert verify_password("s3cr3t-pw", enc)
    assert not verify_password("wrong-pw", enc)


def test_password_salt_is_random():
    assert hash_password("same") != hash_password("same")


def test_password_rejects_empty():
    with pytest.raises(ValueError):
        hash_password("")


def test_verify_handles_garbage_without_raising():
    assert not verify_password("x", "not-an-encoded-hash")
    assert not verify_password("x", "")


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
    token = jwt_codec.encode({"sub": "admin"}, ttl_seconds=-1)
    with pytest.raises(jwt_codec.TokenError):
        jwt_codec.decode(token)


def test_jwt_tampered_is_rejected():
    token = jwt_codec.encode({"sub": "admin"}, ttl_seconds=60)
    with pytest.raises(jwt_codec.TokenError):
        jwt_codec.decode(token + "tamper")


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
    user = Login(_FakeRepo(_admin("pw")))("admin", "pw")
    assert user.actor_id == ADMIN_ID
    assert user.username == "admin"
    assert user.display_name == "Administrator"
    assert user.role == "admin"
    assert user.scopes == ADMIN_SCOPES


def test_login_wrong_password_rejected():
    with pytest.raises(InvalidCredentials):
        Login(_FakeRepo(_admin("pw")))("admin", "nope")


def test_login_unknown_user_rejected():
    with pytest.raises(InvalidCredentials):
        Login(_FakeRepo(None))("ghost", "pw")


# ── RBAC + administrative user-management service ──────────────────────────


def test_role_scope_matrix_is_additive_and_fail_closed():
    assert USER_ROLES == {"admin", "operator"}
    assert OPERATOR_SCOPES < ADMIN_SCOPES
    assert "identity:admin" in ADMIN_SCOPES
    assert "identity:admin" not in OPERATOR_SCOPES
    assert "catalog:read" in OPERATOR_SCOPES
    assert scopes_for_role("unknown") == frozenset()


class _FakeAdminRepo:
    def __init__(self) -> None:
        self.created = None
        self.updated = None

    def create_user(self, user, audit: AdminAuditContext):
        self.created = (user, audit)
        return ManagedUser(
            id="22222222-2222-2222-2222-222222222222",
            username=user.username,
            display_name=user.display_name,
            role=user.role,
            active=True,
            store_code=user.store_code,
            created_by=user.created_by,
            created_at="2026-07-26T00:00:00Z",
            updated_at="2026-07-26T00:00:00Z",
        )

    def update_user(self, user_id, changes, audit):
        self.updated = (user_id, changes, audit)
        return ManagedUser(
            id=user_id,
            username="operator",
            display_name=changes.display_name or "Operator",
            role=changes.role or "operator",
            active=changes.active if changes.active is not None else True,
            store_code=changes.store_code or "PARIS-01",
            created_by=ADMIN_ID,
            created_at="2026-07-26T00:00:00Z",
            updated_at="2026-07-26T00:01:00Z",
        )


def test_create_user_normalizes_fields_and_hashes_password():
    repo = _FakeAdminRepo()
    created = UserAdminService(repo).create(
        CreateUserCommand(
            username="  alice  ",
            display_name="  Alice   Martin ",
            password="long-password-123",
            role="operator",
            store_code="PARIS-01",
            actor_id=ADMIN_ID,
            correlation_id="corr",
            trace_id="trace",
        )
    )
    stored, audit = repo.created
    assert created.username == "alice"
    assert stored.display_name == "Alice Martin"
    assert verify_password("long-password-123", stored.password_hash)
    assert audit.actor_id == ADMIN_ID


def test_create_user_accepts_any_non_empty_password_and_rejects_unknown_role():
    service = UserAdminService(_FakeAdminRepo())
    long_username = "a" * 600
    base = dict(
        username=long_username,
        display_name="Alice",
        actor_id=ADMIN_ID,
        correlation_id="corr",
        trace_id="trace",
    )
    created = service.create(
        CreateUserCommand(
            password="x",
            role="operator",
            store_code="PARIS-01",
            **base,
        )
    )
    assert created.username == long_username
    with pytest.raises(ValueError, match="unknown role"):
        service.create(
            CreateUserCommand(
                password="long-password-123",
                role="superuser",
                store_code="PARIS-01",
                **base,
            )
        )


def test_operator_requires_a_store_assignment():
    with pytest.raises(StoreRequired):
        UserAdminService(_FakeAdminRepo()).create(
            CreateUserCommand(
                username="alice",
                display_name="Alice",
                password="x",
                role="operator",
                store_code=None,
                actor_id=ADMIN_ID,
                correlation_id="corr",
                trace_id="trace",
            )
        )


def test_store_code_is_canonical_and_rejects_unsafe_characters():
    assert normalize_store_code(" paris-01 ") == "PARIS-01"
    with pytest.raises(ValueError):
        normalize_store_code("Paris centre")


def test_update_user_rejects_empty_patch_and_hashes_reset_password():
    repo = _FakeAdminRepo()
    service = UserAdminService(repo)
    with pytest.raises(ValueError, match="at least one"):
        service.update(
            UpdateUserCommand(
                user_id=ADMIN_ID,
                actor_id=ADMIN_ID,
                correlation_id="corr",
                trace_id="trace",
            )
        )

    service.update(
        UpdateUserCommand(
            user_id="22222222-2222-2222-2222-222222222222",
            password="replacement-password",
            actor_id=ADMIN_ID,
            correlation_id="corr",
            trace_id="trace",
        )
    )
    assert verify_password("replacement-password", repo.updated[1].password_hash)
