"""Alembic environment.

Reads DATABASE_URL from the environment (no URL is committed). Migrations are
hand-written raw DDL (roles, partitioned append-only tables, triggers, grants),
so there is no model metadata to autogenerate against.
"""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config

_url = os.environ.get("DATABASE_URL")
if not _url:
    raise RuntimeError("DATABASE_URL is not set; cannot run migrations.")
config.set_main_option("sqlalchemy.url", _url)

# Migrations explicitly own PostgreSQL-only features such as RLS, triggers,
# roles and partition attachment, so this project deliberately does not use
# Alembic autogeneration.  See platform.db.models for the ORM mapping.
target_metadata = None


def run_migrations_offline() -> None:
    context.configure(
        url=_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
