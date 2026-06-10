#!/usr/bin/env python3
"""One-shot migration: add `clerk_user_id` column + index to `users` table,
and relax `password_hash` to NULLable.

This is the v3.0.1 schema migration that ships with the Clerk auth rewrite.
Run once on each environment (MacBook dev DB + Mac Mini production DB):

    cd /Users/admin/Dev/tocafichadr-extension/backend
    python scripts/migrate_add_clerk_user_id.py

Idempotent — safe to re-run. Detects existing column via SQLAlchemy `inspect`
and skips ADD COLUMN if already present. Works on both Postgres and SQLite.
"""
import sys
import logging
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from emr_automation.database import get_engine, init_db
from sqlalchemy import inspect, text


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("migrate")


def main():
    engine = get_engine()
    log.info("connected to: %s", str(engine.url).split("@")[-1])

    # Ensure the base schema exists (no-op if already created).
    init_db(engine)

    inspector = inspect(engine)
    columns = {c["name"] for c in inspector.get_columns("users")}
    log.info("existing users columns: %s", sorted(columns))

    dialect = engine.dialect.name  # 'postgresql' or 'sqlite'
    statements = []

    if "clerk_user_id" not in columns:
        statements.append(("add clerk_user_id column",
                           "ALTER TABLE users ADD COLUMN clerk_user_id VARCHAR(255)"))
        # Indexes
        if dialect == "postgresql":
            statements.append(("create unique index ix_users_clerk_user_id",
                               "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_clerk_user_id "
                               "ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL"))
        else:  # sqlite — partial-index syntax differs slightly but supported in 3.8+
            statements.append(("create unique index ix_users_clerk_user_id",
                               "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_clerk_user_id "
                               "ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL"))
    else:
        log.info("clerk_user_id column already exists — skipping ADD COLUMN")

    # Drop NOT NULL on password_hash so Clerk-only users (no password) are allowed.
    # Postgres: ALTER COLUMN ... DROP NOT NULL is supported.
    # SQLite: requires table recreation; skip — SQLite is dev-only fallback.
    if dialect == "postgresql":
        col_info = next((c for c in inspector.get_columns("users") if c["name"] == "password_hash"), None)
        if col_info and not col_info.get("nullable", True):
            statements.append(("relax password_hash to NULL",
                               "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"))
        else:
            log.info("password_hash already nullable — skipping ALTER COLUMN")

    if not statements:
        log.info("no changes needed; schema is up to date")
        return 0

    with engine.begin() as conn:
        for desc, sql in statements:
            log.info("executing: %s", desc)
            conn.execute(text(sql))

    log.info("migration complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
