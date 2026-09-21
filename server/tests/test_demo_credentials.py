from __future__ import annotations

import json

import pytest
from scripts.seed_demo import DEMO_USERS, load_demo_passwords


def _credentials() -> dict[str, str]:
    return {username: f"unique-{username}-password-2026" for username in DEMO_USERS}


def test_demo_passwords_require_a_secret_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LABELSCAN_DEMO_CREDENTIALS_FILE", raising=False)

    with pytest.raises(RuntimeError, match="is required"):
        load_demo_passwords()


def test_demo_passwords_accept_exact_strong_credentials(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    path = tmp_path / "credentials.json"
    expected = _credentials()
    path.write_text(json.dumps(expected), encoding="utf-8")
    monkeypatch.setenv("LABELSCAN_DEMO_CREDENTIALS_FILE", str(path))

    assert load_demo_passwords() == expected


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda values: values.pop("admin"), "exactly the six"),
        (lambda values: values.__setitem__("unexpected", "long-enough-password"), "exactly the six"),
        (lambda values: values.__setitem__("admin", "short"), "at least 12"),
    ],
)
def test_demo_passwords_fail_closed(
    monkeypatch: pytest.MonkeyPatch, tmp_path, mutate, message: str
) -> None:
    path = tmp_path / "credentials.json"
    values = _credentials()
    mutate(values)
    path.write_text(json.dumps(values), encoding="utf-8")
    monkeypatch.setenv("LABELSCAN_DEMO_CREDENTIALS_FILE", str(path))

    with pytest.raises((RuntimeError, ValueError), match=message):
        load_demo_passwords()
