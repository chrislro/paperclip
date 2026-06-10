-- test_runs table — added by Phase 3-G (CHRA-516).
-- Idempotent: safe to run against an existing audit.db.
-- Migration is also applied automatically by AuditLogger.__init__

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
);
CREATE INDEX IF NOT EXISTS idx_test_runs_timestamp ON test_runs(timestamp);
CREATE INDEX IF NOT EXISTS idx_test_runs_outcome ON test_runs(outcome);
CREATE INDEX IF NOT EXISTS idx_test_runs_ghosp_route ON test_runs(ghosp_route);
