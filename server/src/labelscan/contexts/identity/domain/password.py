"""Password hashing — stdlib PBKDF2-HMAC-SHA256. Pure (no third-party deps).

Encoded form:  ``pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>``

Verification is constant-time (``hmac.compare_digest``). Plaintext is never stored
and never logged.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

_ALGORITHM = "pbkdf2_sha256"
_DEFAULT_ITERATIONS = 600_000  # OWASP-recommended floor for PBKDF2-HMAC-SHA256
_MIN_ACCEPTED_ITERATIONS = 100_000
_MAX_ACCEPTED_ITERATIONS = 2_000_000
_SALT_BYTES = 16
_DIGEST_BYTES = 32
_DEFAULT_MIN_PASSWORD_LENGTH = 12
_MAX_PASSWORD_LENGTH = 128
_FORBIDDEN_PASSWORDS = {
    "change-me-to-a-strong-password",
    "change-me-to-a-long-random-secret-of-at-least-32-bytes",
    "password",
    "password123",
}


def validate_password(
    password: str,
    *,
    min_length: int = _DEFAULT_MIN_PASSWORD_LENGTH,
    reject_known_placeholder: bool = True,
) -> None:
    if len(password) < min_length:
        raise ValueError(f"password must be at least {min_length} characters")
    if len(password) > _MAX_PASSWORD_LENGTH:
        raise ValueError("password must be at most 128 characters")
    if reject_known_placeholder and password.casefold() in _FORBIDDEN_PASSWORDS:
        raise ValueError("password is a known placeholder and must be changed")


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(
    password: str,
    *,
    iterations: int = _DEFAULT_ITERATIONS,
    min_length: int = _DEFAULT_MIN_PASSWORD_LENGTH,
    reject_known_placeholder: bool = True,
) -> str:
    validate_password(
        password,
        min_length=min_length,
        reject_known_placeholder=reject_known_placeholder,
    )
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{_ALGORITHM}${iterations}${_b64e(salt)}${_b64e(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    """Return True iff ``password`` matches ``encoded``. Never raises on bad input."""
    try:
        algorithm, iterations_s, salt_s, hash_s = encoded.split("$")
        if algorithm != _ALGORITHM:
            return False
        iterations = int(iterations_s)
        salt = _b64d(salt_s)
        expected = _b64d(hash_s)
        if not _MIN_ACCEPTED_ITERATIONS <= iterations <= _MAX_ACCEPTED_ITERATIONS:
            return False
        if len(salt) < _SALT_BYTES or len(expected) != _DIGEST_BYTES:
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations
        )
    except (ValueError, AttributeError, TypeError):
        return False
    return hmac.compare_digest(candidate, expected)
