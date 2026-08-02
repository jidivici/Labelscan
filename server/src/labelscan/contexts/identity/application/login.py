"""Login use case — credentials -> authenticated identity. Pure application logic.

It does NOT mint a token (the token format is an adapter/platform concern) and it
does NOT reveal why authentication failed: unknown user, wrong password and an
inactive account all raise the same ``InvalidCredentials``, and a password hash is
verified even when the user is missing, so callers cannot probe for valid
usernames via the response or via timing.
"""

from __future__ import annotations

from labelscan.contexts.identity.application.ports import UserRepository
from labelscan.contexts.identity.domain.password import hash_password, verify_password
from labelscan.contexts.identity.domain.user import AuthenticatedUser, scopes_for_role

# A well-formed hash to verify against when no user is found, so the missing-user
# path costs the same as the wrong-password path (no timing oracle).
_DUMMY_HASH = hash_password("invalid-credentials-placeholder")


class InvalidCredentials(Exception):
    """Authentication failed. Carries no distinguishing detail by design."""


class Login:
    def __init__(self, users: UserRepository) -> None:
        self._users = users

    def __call__(
        self, username: str, password: str, organization_slug: str = "labelscan"
    ) -> AuthenticatedUser:
        try:
            user = self._users.find_active_by_username(username, organization_slug)
        except TypeError:
            # Additive rollout compatibility for an in-process legacy adapter.
            user = self._users.find_active_by_username(username)  # type: ignore[call-arg]
        stored_hash = user.password_hash if user else _DUMMY_HASH
        password_ok = verify_password(password, stored_hash)
        if not user or not password_ok:
            raise InvalidCredentials()
        return AuthenticatedUser(
            actor_id=user.id,
            username=user.username,
            display_name=user.display_name,
            role=user.role,
            scopes=scopes_for_role(user.role),
            store_code=user.store_code,
            organization_id=user.organization_id,
            organization_slug=user.organization_slug,
            store_id=user.store_id,
        )
