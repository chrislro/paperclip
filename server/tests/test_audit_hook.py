"""
Phase 3-G — Audit hook + selector-drift telemetry tests.

Verifies that the pytest audit hook writes test outcomes to data/audit.db
and that selector drift is captured when JSONL replay locators fail.

Usage:
    pytest tests/test_audit_hook.py -v
    sqlite3 data/audit.db "SELECT count(*) FROM test_runs WHERE outcome='failed';"
"""

from __future__ import annotations

import json
import sqlite3
import pathlib
import subprocess
import os
import tempfile

import pytest


def _audit_db_path() -> pathlib.Path:
    """Return the path to audit.db."""
    return pathlib.Path(__file__).resolve().parent.parent / "backend" / "data" / "audit.db"


class TestAuditHookRecordsFailures:
    """Intentional-failure tests that verify the audit hook captures them."""

    def test_intentional_failure_writes_audit_row(self):
        """Run a sub-pytest that fails; verify audit.db receives the row."""
        project_root = pathlib.Path(__file__).resolve().parent.parent
        venv_python = project_root / "venv" / "bin" / "python"

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a minimal conftest that loads the audit hook
            conftest = pathlib.Path(tmpdir) / "conftest.py"
            conftest.write_text(
                'import sys\n'
                'sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent / "tests"))\n'
                'pytest_plugins = ["tests.extension.support.audit_hook"]\n'
            )

            # Create a test file with one failing test marked with ghosp_route
            test_file = pathlib.Path(tmpdir) / "test_dummy.py"
            test_file.write_text(
                '''
import pytest

@pytest.mark.ghosp_route("login")
def test_that_fails():
    assert False, "Intentional failure for audit hook verification"
'''
            )

            env = os.environ.copy()
            env["PYTHONPATH"] = str(project_root)

            result = subprocess.run(
                [str(venv_python), "-m", "pytest", str(test_file), "-v", "--capture=no"],
                cwd=str(project_root),
                env=env,
                capture_output=True,
                text=True,
            )

            # The sub-pytest should have 1 failure
            assert result.returncode != 0, f"Sub-pytest unexpectedly passed:\n{result.stdout}\n{result.stderr}"
            assert "1 failed" in result.stdout, f"Expected 1 failed in sub-pytest:\n{result.stdout}"

        # Verify audit.db has the failed row
        db_path = _audit_db_path()
        assert db_path.exists(), f"audit.db not found at {db_path}"

        conn = sqlite3.connect(str(db_path))
        try:
            cursor = conn.execute(
                """
                SELECT test_name, outcome, error_summary, ghosp_route
                FROM test_runs
                WHERE outcome = 'failed'
                ORDER BY id DESC
                LIMIT 1
                """
            )
            row = cursor.fetchone()
            assert row is not None, "No failed test run found in audit.db"
            test_name, outcome, error_summary, ghosp_route = row
            assert "test_that_fails" in test_name
            assert outcome == "failed"
            assert error_summary is not None
            assert "Intentional failure" in error_summary
            assert ghosp_route == "login"
        finally:
            conn.close()

    def test_audit_db_schema_has_test_runs(self):
        """The audit.db schema includes the test_runs table per architecture doc."""
        db_path = _audit_db_path()
        assert db_path.exists(), f"audit.db not found at {db_path}"

        conn = sqlite3.connect(str(db_path))
        try:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='test_runs'"
            )
            assert cursor.fetchone() is not None, "test_runs table missing from audit.db"

            # Verify expected columns exist
            cursor = conn.execute("PRAGMA table_info(test_runs)")
            columns = {row[1] for row in cursor.fetchall()}
            expected = {
                "id",
                "timestamp",
                "test_name",
                "outcome",
                "duration_seconds",
                "trace_path",
                "error_summary",
                "ghosp_route",
                "selector_drift_path",
            }
            assert expected.issubset(columns), f"Missing columns: {expected - columns}"
        finally:
            conn.close()


class TestSelectorDriftTelemetry:
    """Verify selector-drift JSONL is written when replay locators fail."""

    def test_selector_drift_jsonl_written_on_failure(self):
        """When a JSONL replay selector misses, drift is logged to test-artifacts."""
        project_root = pathlib.Path(__file__).resolve().parent.parent
        venv_python = project_root / "venv" / "bin" / "python"

        # Ensure clean state
        drift_path = project_root / "test-artifacts" / "selector-drift.jsonl"
        if drift_path.exists():
            drift_path.unlink()

        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = pathlib.Path(tmpdir) / "test_drift.py"
            test_file.write_text(
                '''
import json
import pathlib
import tempfile
from playwright.sync_api import sync_playwright
from tests.extension.support.jsonl_replay import JSONLReplay, ReplayError
import pytest

def test_replay_failure_triggers_drift():
    with tempfile.TemporaryDirectory() as tmp:
        html_path = pathlib.Path(tmp) / "page.html"
        html_path.write_text("<html><body><p>Hello</p></body></html>")

        recording_path = pathlib.Path(tmp) / "rec.jsonl"
        steps = [
            {"type": "navigate", "url": f"file://{html_path}"},
            {"type": "click", "tag": "button", "id": "missing"},
        ]
        with open(recording_path, "w") as f:
            for step in steps:
                f.write(json.dumps(step) + "\\n")

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            replay = JSONLReplay(page, recording_path)
            try:
                replay.replay()
            except ReplayError:
                pass
            browser.close()

        # Verify drift file was written
        drift = pathlib.Path("test-artifacts") / "selector-drift.jsonl"
        assert drift.exists(), "selector-drift.jsonl was not created"
        lines = drift.read_text().strip().split("\\n")
        assert len(lines) >= 1
        record = json.loads(lines[-1])
        assert record["step_type"] == "click"
        assert any("missing" in s for s in record["selectors_tried"])
'''
            )

            env = os.environ.copy()
            env["PYTHONPATH"] = str(project_root)

            result = subprocess.run(
                [str(venv_python), "-m", "pytest", str(test_file), "-v", "--capture=no"],
                cwd=str(project_root),
                env=env,
                capture_output=True,
                text=True,
            )

            assert result.returncode == 0, f"Drift sub-pytest failed:\n{result.stdout}\n{result.stderr}"

        # Verify the drift file exists and has content
        assert drift_path.exists(), "selector-drift.jsonl was not created"
        lines = drift_path.read_text().strip().split("\n")
        assert len(lines) >= 1
        record = json.loads(lines[-1])
        assert record["step_type"] == "click"
        assert any("missing" in s for s in record["selectors_tried"])
