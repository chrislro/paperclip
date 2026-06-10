-- Sanitized schema dump from /Users/admin/Dev/Pediatrics/data/audit.db.
-- Contains schema only, no rows or PHI.

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    patient_id TEXT,
    action_type TEXT NOT NULL,
    template_used TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    physician_id TEXT,
    details TEXT,
    duration_seconds REAL,
    error_message TEXT
);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_patient ON audit_log(patient_id);
CREATE INDEX idx_audit_action ON audit_log(action_type);
