"""Shared HTTP dependencies (platform / infra)."""

from __future__ import annotations

from sqlalchemy.engine import Engine

from labelscan.platform.db.engine import make_engine

_ENGINE: Engine | None = None


def get_engine() -> Engine:
    """Read engine provider — overridden in tests. Cached so it is built once."""
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = make_engine()
    return _ENGINE
