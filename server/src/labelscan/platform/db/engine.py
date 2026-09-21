"""Database engine wiring (infrastructure / platform layer).

This is the ONLY place a connection string is resolved. Domain and application
layers never import this module (enforced by G-ARCH / .importlinter).
"""

from __future__ import annotations

from sqlalchemy import Engine, create_engine

from labelscan.platform.config import secret_value


def database_url() -> str:
    """Resolve the connection URL from the environment.

    Uses psycopg (v3) driver. No default host/credentials are baked in —
    a missing URL is a hard error, never a silent fallback.
    """
    url = secret_value("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Expected a postgresql+psycopg://... URL."
        )
    return url


def make_engine(url: str | None = None) -> Engine:
    # future=True is the default in SQLAlchemy 2.0; pool_pre_ping guards stale conns.
    return create_engine(url or database_url(), pool_pre_ping=True)
