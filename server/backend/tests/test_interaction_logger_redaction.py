"""CHRA-2423 Bug 44 — the interaction logger must NOT capture password values.

interaction_logger.py injects JS (`getElementInfo`) that records `el.value` for
every click/input into a JSONL file on disk. Without a `type=password` guard, the
EMR password (filled by auto-login / typed on session-expiry re-login while
logging is active) would be persisted in plaintext — a reusable-credential leak.

The instrumentation is injected JS, not directly unit-testable in Python, so this
is a source tripwire that fails if the password redaction is removed.
"""
import re
from pathlib import Path

SRC = (
    Path(__file__).resolve().parents[1] / "emr_automation" / "interaction_logger.py"
).read_text()


def test_getelementinfo_redacts_password_values():
    m = re.search(r"function getElementInfo\(el\)\s*\{.*?\n    \}", SRC, re.DOTALL)
    assert m, "getElementInfo not found in the injected instrumentation"
    body = m.group(0)
    # The capture must branch on a password type and emit a redaction marker
    # instead of the raw value.
    assert re.search(r"===\s*'password'", body), \
        "getElementInfo must check for type === 'password'"
    assert "redacted-password" in body, \
        "password fields must be replaced with a redaction marker, not the raw value"
    # And the raw-value capture must NOT be unconditional anymore.
    assert "_value" in body, "the value should be computed via a guarded variable, not inlined unconditionally"
