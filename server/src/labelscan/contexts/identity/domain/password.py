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
_SALT_BYTES = 16


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password: str, *, iterations: int = _DEFAULT_ITERATIONS) -> str:
    if not password:
        raise ValueError("password must not be empty")
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
    except (ValueError, AttributeError):
        return False
    candidate = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations
    )
    return hmac.compare_digest(candidate, expected)
