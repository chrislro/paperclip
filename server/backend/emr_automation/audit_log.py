"""
Structured audit logging for EMR Automation.

Logs every automated action to a SQLite database for compliance,
debugging, and operational visibility.
"""

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional


class AuditLogger:
    """
    Thread-safe audit logger backed by SQLite.

    Every automated action records: timestamp, patient_id, action_type,
    template_used, success/failure, physician_id, duration, and details.

    Usage:
        audit = AuditLogger()
        audit.log_action(
            action_type="prescription",
            patient_id="12345",
            template_used="Gastroenterite 1",
            success=True,
            duration_seconds=4.2,
        )
    """

    _CREATE_TABLE = """
        CREATE TABLE IF NOT EXISTS audit_log (
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
        )
    """

    _CREATE_INDEX = """
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_log(patient_id);
        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action_type);
    """

    _CREATE_TEST_RUNS_TABLE = """
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

    _CREATE_TEST_RUNS_INDEX = """
        CREATE INDEX IF NOT EXISTS idx_test_runs_timestamp ON test_runs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_test_runs_outcome ON test_runs(outcome);
        CREATE INDEX IF NOT EXISTS idx_test_runs_ghosp_route ON test_runs(ghosp_route);
    """

    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            data_dir = Path(__file__).resolve().parent.parent / "data"
            data_dir.mkdir(exist_ok=True)
            db_path = str(data_dir / "audit.db")

        self._db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(self._CREATE_TABLE)
            conn.executescript(self._CREATE_INDEX)
            conn.execute(self._CREATE_TEST_RUNS_TABLE)
            conn.executescript(self._CREATE_TEST_RUNS_INDEX)
            # WAL mode for better concurrent read/write
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self._db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=30000")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _run_with_retry(self, operation):
        """Retry transient SQLite lock errors with small backoff."""
        last_err = None
        for attempt in range(5):
            try:
                return operation()
            except sqlite3.OperationalError as err:
                last_err = err
                if "locked" not in str(err).lower():
                    raise
                time.sleep(0.2 * (attempt + 1))
        if last_err is not None:
            raise last_err
        return None

    def log_action(
        self,
        action_type: str,
        patient_id: Optional[str] = None,
        template_used: Optional[str] = None,
        success: bool = True,
        physician_id: Optional[str] = None,
        details: Optional[str] = None,
        duration_seconds: Optional[float] = None,
        error_message: Optional[str] = None,
    ) -> int:
        """
        Record an automated action.

        Returns:
            The row ID of the inserted record.
        """
        def _op():
            with self._lock:
                with self._connect() as conn:
                    cursor = conn.execute(
                        """
                        INSERT INTO audit_log
                            (timestamp, patient_id, action_type, template_used,
                             success, physician_id, details, duration_seconds, error_message)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            datetime.now().isoformat(),
                            patient_id,
                            action_type,
                            template_used,
                            1 if success else 0,
                            physician_id,
                            details,
                            duration_seconds,
                            error_message,
                        ),
                    )
                    return cursor.lastrowid

        return self._run_with_retry(_op)

    def log_manual_action(
        self,
        patient_id: Optional[str],
        action_tags: List[str],
        notes: str
    ) -> int:
        """
        Log a manual action reported by the user.
        """
        details = json.dumps({
            "tags": action_tags,
            "notes": notes
        }, ensure_ascii=False)
        
        return self.log_action(
            action_type="manual_entry",
            patient_id=patient_id,
            success=True,
            details=details,
            duration_seconds=0
        )

    def get_recent(self, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
        """Get recent audit entries, newest first."""
        def _op():
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
                return [dict(row) for row in rows]

        return self._run_with_retry(_op)

    def get_by_patient(self, patient_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Get audit entries for a specific patient."""
        def _op():
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT * FROM audit_log WHERE patient_id = ? ORDER BY id DESC LIMIT ?",
                    (patient_id, limit),
                ).fetchall()
                return [dict(row) for row in rows]

        return self._run_with_retry(_op)

    def get_by_action(self, action_type: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Get audit entries for a specific action type."""
        def _op():
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT * FROM audit_log WHERE action_type = ? ORDER BY id DESC LIMIT ?",
                    (action_type, limit),
                ).fetchall()
                return [dict(row) for row in rows]

        return self._run_with_retry(_op)

    def get_today(self) -> List[Dict[str, Any]]:
        """Get all audit entries from today."""
        today = datetime.now().strftime("%Y-%m-%d")
        def _op():
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT * FROM audit_log WHERE timestamp >= ? ORDER BY id DESC",
                    (today,),
                ).fetchall()
                return [dict(row) for row in rows]

        return self._run_with_retry(_op)

    def get_summary(self, days: int = 7) -> Dict[str, Any]:
        """
        Get a summary of audit data for the last N days.

        Returns dict with total counts, success rate, and breakdown by action type.
        """
        since = (datetime.now() - timedelta(days=days)).isoformat()
        def _op():
            with self._connect() as conn:
                total = conn.execute(
                    "SELECT COUNT(*) FROM audit_log WHERE timestamp >= ?", (since,)
                ).fetchone()[0]

                success = conn.execute(
                    "SELECT COUNT(*) FROM audit_log WHERE timestamp >= ? AND success = 1",
                    (since,),
                ).fetchone()[0]

                by_action = conn.execute(
                    """
                    SELECT action_type,
                           COUNT(*) as count,
                           SUM(success) as successes,
                           AVG(duration_seconds) as avg_duration
                    FROM audit_log
                    WHERE timestamp >= ?
                    GROUP BY action_type
                    ORDER BY count DESC
                    """,
                    (since,),
                ).fetchall()

                by_patient = conn.execute(
                    """
                    SELECT patient_id, COUNT(*) as count
                    FROM audit_log
                    WHERE timestamp >= ? AND patient_id IS NOT NULL
                    GROUP BY patient_id
                    ORDER BY count DESC
                    LIMIT 10
                    """,
                    (since,),
                ).fetchall()
                return total, success, by_action, by_patient

        total, success, by_action, by_patient = self._run_with_retry(_op)

        return {
            "period_days": days,
            "total_actions": total,
            "success_count": success,
            "failure_count": total - success,
            "success_rate": (success / total * 100) if total > 0 else 0,
            "by_action": [
                {
                    "action": row["action_type"],
                    "count": row["count"],
                    "successes": row["successes"],
                    "avg_duration": round(row["avg_duration"] or 0, 2),
                }
                for row in by_action
            ],
            "top_patients": [
                {"patient_id": row["patient_id"], "count": row["count"]}
                for row in by_patient
            ],
        }

    def export_json(self, filepath: Optional[str] = None, days: int = 30) -> str:
        """
        Export audit data as JSON file.

        Returns:
            Path to the exported file.
        """
        if filepath is None:
            data_dir = Path(self._db_path).parent
            filepath = str(
                data_dir / f"audit_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            )

        since = (datetime.now() - timedelta(days=days)).isoformat()
        def _op():
            with self._connect() as conn:
                return conn.execute(
                    "SELECT * FROM audit_log WHERE timestamp >= ? ORDER BY id",
                    (since,),
                ).fetchall()

        rows = self._run_with_retry(_op)

        data = {
            "exported_at": datetime.now().isoformat(),
            "period_days": days,
            "total_records": len(rows),
            "records": [dict(row) for row in rows],
        }

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)

        return filepath


# Global audit logger instance
_audit_logger: Optional[AuditLogger] = None
_audit_lock = threading.Lock()


def get_audit_logger(db_path: Optional[str] = None) -> AuditLogger:
    """Get or create the global AuditLogger instance."""
    global _audit_logger
    with _audit_lock:
        if _audit_logger is None:
            _audit_logger = AuditLogger(db_path)
        return _audit_logger
