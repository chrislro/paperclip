"""
Pytest hook for auditing test runs into data/audit.db (Phase 3-G).

Usage: add to conftest.py:
    pytest_plugins = ["tests.extension.support.audit_hook"]

Or rely on pytest automatic discovery if this file is on the PYTHONPATH.
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
import time
from datetime import datetime
from typing import Any, Dict, Optional

import pytest


def _get_audit_db_path() -> pathlib.Path:
    """Resolve the audit.db path relative to the project root."""
    # This file lives at tests/extension/support/audit_hook.py
    return pathlib.Path(__file__).resolve().parent.parent.parent.parent / "backend" / "data" / "audit.db"


def _get_test_artifacts_dir() -> pathlib.Path:
    """Resolve the test-artifacts directory."""
    return pathlib.Path(__file__).resolve().parent.parent.parent.parent / "test-artifacts"


def _ensure_test_runs_table(conn: sqlite3.Connection) -> None:
    """Idempotently create the test_runs table (defensive against stale DBs)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS test_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            test_name TEXT NOT NULL,
            outcome TEXT NOT NULL,
            duration_seconds REAL,
            trace_path TEXT,
            error_summary TEXT,
            ghosp_route TEXT,
            selector_drift_path TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_test_runs_timestamp ON test_runs(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_test_runs_outcome ON test_runs(outcome)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_test_runs_ghosp_route ON test_runs(ghosp_route)")


def _insert_test_run(
    db_path: pathlib.Path,
    test_name: str,
    outcome: str,
    duration_seconds: Optional[float] = None,
    trace_path: Optional[str] = None,
    error_summary: Optional[str] = None,
    ghosp_route: Optional[str] = None,
    selector_drift_path: Optional[str] = None,
) -> int:
    """Write a test run row to audit.db. Returns the inserted row id."""
    conn = sqlite3.connect(str(db_path), timeout=30)
    try:
        _ensure_test_runs_table(conn)
        cursor = conn.execute(
            """
            INSERT INTO test_runs
                (timestamp, test_name, outcome, duration_seconds,
                 trace_path, error_summary, ghosp_route, selector_drift_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                datetime.now().isoformat(),
                test_name,
                outcome,
                duration_seconds,
                trace_path,
                error_summary,
                ghosp_route,
                selector_drift_path,
            ),
        )
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


# ------------------------------------------------------------------
# Pytest hooks
# ------------------------------------------------------------------

_test_start_times: Dict[str, float] = {}


def pytest_runtest_setup(item: pytest.Item) -> None:
    """Record the start time of each test."""
    _test_start_times[item.nodeid] = time.time()


def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo[Any]) -> None:
    """After each test call, write the result to audit.db."""
    if call.when != "call":
        return

    start = _test_start_times.pop(item.nodeid, None)
    duration = (time.time() - start) if start else None

    # Determine outcome
    if call.excinfo is None:
        outcome = "passed"
    else:
        outcome = "failed"

    # Extract ghosp_route from custom marker if present
    ghosp_route: Optional[str] = None
    marker = item.get_closest_marker("ghosp_route")
    if marker:
        ghosp_route = marker.args[0] if marker.args else None

    # Build error summary from exception info
    error_summary: Optional[str] = None
    trace_path: Optional[str] = None
    if call.excinfo is not None:
        exc_type = call.excinfo.type.__name__ if call.excinfo.type else "Unknown"
        exc_value = str(call.excinfo.value)
        error_summary = f"{exc_type}: {exc_value[:500]}"
        # If the test has a trace artifact, reference it
        trace_dir = _get_test_artifacts_dir() / "traces"
        if trace_dir.exists():
            candidate = trace_dir / f"{item.nodeid.replace('/', '_').replace('::', '_')}.zip"
            if candidate.exists():
                trace_path = str(candidate)

    # Check for selector drift artifact
    selector_drift_path: Optional[str] = None
    drift_file = _get_test_artifacts_dir() / "selector-drift.jsonl"
    if drift_file.exists():
        # Only associate if drift was written during this test run
        # We use a simple heuristic: drift file mtime is within the last minute
        mtime = datetime.fromtimestamp(drift_file.stat().st_mtime)
        if (datetime.now() - mtime).total_seconds() < 60:
            selector_drift_path = str(drift_file)

    db_path = _get_audit_db_path()
    if db_path.exists():
        try:
            _insert_test_run(
                db_path=db_path,
                test_name=item.nodeid,
                outcome=outcome,
                duration_seconds=duration,
                trace_path=trace_path,
                error_summary=error_summary,
                ghosp_route=ghosp_route,
                selector_drift_path=selector_drift_path,
            )
        except Exception as exc:
            # Never fail a test because the audit hook broke
            import warnings
            warnings.warn(f"audit_hook: failed to write test run: {exc}", RuntimeWarning)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Clean up any orphaned start times."""
    _test_start_times.clear()
