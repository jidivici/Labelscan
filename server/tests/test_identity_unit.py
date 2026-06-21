"""Unit proofs for the identity primitives — NO database required.

Covers password hashing, the JWT codec, and the Login use case (with a fake repo),
so the security-critical logic is verified even without PostgreSQL.
"""

from __future__ import annotations

import pytest

from labelscan.contexts.identity.application.login import InvalidCredentials, Login
from labelscan.contexts.identity.domain.password import hash_password, verify_password
from labelscan.contexts.identity.domain.user import ADMIN_SCOPES, StoredUser
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
        password_hash=hash_password(password),
        role="admin",
        is_active=True,
    )


def test_login_success_maps_admin_scopes():
    user = Login(_FakeRepo(_admin("pw")))("admin", "pw")
    assert user.actor_id == ADMIN_ID
    assert user.username == "admin"
    assert user.role == "admin"
    assert user.scopes == ADMIN_SCOPES


def test_login_wrong_password_rejected():
    with pytest.raises(InvalidCredentials):
        Login(_FakeRepo(_admin("pw")))("admin", "nope")


def test_login_unknown_user_rejected():
    with pytest.raises(InvalidCredentials):
        Login(_FakeRepo(None))("ghost", "pw")
