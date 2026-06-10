"""Run explicit backend migrations.

Usage:
    DATABASE_URL=sqlite:////tmp/tocafichadr-copy.db python -m migrations.upgrade

Run this on a copied database first. Do not point it at a live production DB
without a backup and review.
"""

from __future__ import annotations

import logging
import sys

from sqlalchemy import inspect, text

from emr_automation.database import get_engine, init_db
import emr_automation.models  # noqa: F401 - registers SQLAlchemy models on Base.metadata

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("tocafichadr.migrations")


def _has_index(inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get("name") == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> int:
    engine = get_engine()
    log.info("connected to: %s", str(engine.url).split("@")[-1])

    init_db(engine)
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "users" not in tables:
        log.info("users table missing after init_db; nothing to migrate")
        return 0

    columns = {column["name"]: column for column in inspector.get_columns("users")}
    dialect = engine.dialect.name
    statements: list[tuple[str, str]] = []

    if "clerk_user_id" not in columns:
        statements.append(
            ("add users.clerk_user_id", "ALTER TABLE users ADD COLUMN clerk_user_id VARCHAR(255)")
        )

    if not _has_index(inspector, "users", "ix_users_clerk_user_id"):
        statements.append(
            (
                "add users.clerk_user_id unique partial index",
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_clerk_user_id "
                "ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL",
            )
        )

    password_hash = columns.get("password_hash")
    if dialect == "postgresql" and password_hash and not password_hash.get("nullable", True):
        statements.append(
            (
                "relax users.password_hash",
                "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL",
            )
        )
    elif dialect == "sqlite" and password_hash and not password_hash.get("nullable", True):
        log.warning("SQLite password_hash remains NOT NULL; table rebuild deferred for reviewed migration")

    # Idempotent operations table (PR 3B)
    if "idempotent_operations" not in tables:
        statements.append(
            ("create idempotent_operations table",
             """CREATE TABLE idempotent_operations (
                id INTEGER NOT NULL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                operation_id VARCHAR(64) NOT NULL,
                endpoint VARCHAR(100) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
                response_body TEXT,
                provider VARCHAR(50),
                duration_ms INTEGER,
                error_code VARCHAR(50),
                created_at DATETIME,
                completed_at DATETIME,
                expires_at DATETIME
            )""")
        )
        statements.append(
            ("index idempotent_operations user_id",
             "CREATE INDEX ix_idempotent_operations_user_id ON idempotent_operations(user_id)")
        )
        statements.append(
            ("index idempotent_operations operation_id",
             "CREATE INDEX ix_idempotent_operations_operation_id ON idempotent_operations(operation_id)")
        )

    # Webhook events table (CHRA-1862)
    if "webhook_events" not in tables:
        statements.append(
            ("create webhook_events table",
             """CREATE TABLE webhook_events (
                id INTEGER NOT NULL PRIMARY KEY,
                external_event_id VARCHAR(255),
                event_type VARCHAR(100) NOT NULL,
                source VARCHAR(50) NOT NULL,
                payload JSON NOT NULL DEFAULT '{}',
                status VARCHAR(20) NOT NULL DEFAULT 'received',
                http_status INTEGER,
                error_message TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                processed_at DATETIME
            )""")
        )
        statements.append(
            ("index webhook_events external_event_id",
             "CREATE INDEX ix_webhook_events_external_event_id ON webhook_events(external_event_id)")
        )
        statements.append(
            ("index webhook_events event_type",
             "CREATE INDEX ix_webhook_events_event_type ON webhook_events(event_type)")
        )
        statements.append(
            ("index webhook_events source",
             "CREATE INDEX ix_webhook_events_source ON webhook_events(source)")
        )

    # CHRA-1870: Add unique constraint on webhook_events(external_event_id, source)
    # to prevent duplicate webhook processing and TOCTOU races.
    # CHRA-1872: Normalized index name to match the alembic baseline constraint name.
    if "webhook_events" in tables:
        indexes = {idx.get("name") for idx in inspector.get_indexes("webhook_events")}
        # Drop the old mis-named index if it exists (pre-CHRA-1872).
        if "ix_webhook_events_external_source_unique" in indexes:
            statements.append(
                (
                    "drop old mis-named webhook_events unique index",
                    "DROP INDEX IF EXISTS ix_webhook_events_external_source_unique",
                )
            )
            indexes.discard("ix_webhook_events_external_source_unique")
        # Use a unique index for SQLite compatibility (SQLite < 3.35 can't add
        # constraints to existing tables without table rebuild).
        if "uq_webhook_events_external_source" not in indexes:
            statements.append(
                (
                    "add webhook_events unique index on (external_event_id, source)",
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_external_source "
                    "ON webhook_events(external_event_id, source)",
                )
            )

    if not statements:
        log.info("schema is already up to date")
        return 0

    with engine.begin() as conn:
        for description, sql in statements:
            log.info("executing: %s", description)
            conn.execute(text(sql))

    log.info("migration complete")
    return 0


if __name__ == "__main__":
    sys.exit(upgrade())
