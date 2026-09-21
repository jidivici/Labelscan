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
from labelscan.contexts.identity.domain.user import (
    AuthenticatedUser,
    normalize_identity_text,
    scopes_for_role,
)

# A well-formed hash to verify against when no user is found, so the missing-user
# path costs the same as the wrong-password path (no timing oracle).
_DUMMY_HASH = hash_password("invalid-credentials-placeholder-value")


class InvalidCredentials(Exception):
    """Authentication failed. Carries no distinguishing detail by design."""


class Login:
    def __init__(self, users: UserRepository) -> None:
        self._users = users

    def __call__(
        self,
        username: str,
        password: str,
        organization_slug: str = "labelscan",
    ) -> AuthenticatedUser:
        try:
            username = normalize_identity_text(
                username, field="username", maximum=254
            )
        except ValueError:
            # Keep malformed and unknown usernames on the same password-cost path.
            verify_password(password, _DUMMY_HASH)
            raise InvalidCredentials() from None
        candidate_lookup = getattr(
            self._users, "find_active_candidates_by_username", None
        )
        if callable(candidate_lookup):
            candidates = candidate_lookup(username, organization_slug)
        else:
            try:
                candidate = self._users.find_active_by_username(
                    username, organization_slug
                )
            except TypeError:
                candidate = self._users.find_active_by_username(username)  # type: ignore[call-arg]
            candidates = (candidate,) if candidate else ()

        # The username/password pair resolves the store invisibly. Shared
        # usernames are safe when their passwords differ. If an exact pair was
        # duplicated across stores, fail closed because no store can be chosen
        # reliably without changing the login form.
        matches = tuple(
            candidate
            for candidate in candidates
            if verify_password(password, candidate.password_hash)
        )
        if not candidates:
            verify_password(password, _DUMMY_HASH)
        if len(matches) != 1:
            raise InvalidCredentials()
        user = matches[0]
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
            business_portal_ids=user.business_portal_ids,
            business_portal_id=user.business_portal_id,
            trade_code=user.trade_code,
            store_ids=user.store_ids,
        )
