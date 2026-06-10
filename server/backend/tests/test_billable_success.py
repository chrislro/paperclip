"""CHRA-2423 Bug 37 — free-tier doctors were charged for FAILED operations.

The billable routes (/api/transcribe, /api/suggest-cid, /api/format-soap,
/api/format-atestado-letter) called _log_billable_usage() UNCONDITIONALLY after
the work. But the extension_api functions catch their own errors and RETURN an
error dict / non-2xx ``status_code`` instead of raising — so a failed
transcription / SOAP / CID / atestado (OpenAI timeout, "audio too small" 400,
etc.) still consumed one of the user's FREE_DAILY_LIMIT daily uses.

The fix gates each _log_billable_usage() behind _is_billable_success(result).
This module pins both the decision logic and the wiring at all four sites.
"""
import re
from pathlib import Path

from emr_automation.dashboard.routes import _is_billable_success

ROUTES_SRC = (
    Path(__file__).resolve().parents[1] / "emr_automation" / "dashboard" / "routes.py"
).read_text()

BILLABLE_ACTIONS = ("transcribe", "suggest_cid", "format_soap", "format_atestado_letter")


class TestIsBillableSuccess:
    def test_error_payload_is_not_billable(self):
        assert _is_billable_success({"error": "OpenAI timeout"}) is False

    def test_non_2xx_status_code_is_not_billable(self):
        assert _is_billable_success({"status_code": 400}) is False
        assert _is_billable_success({"status_code": 500}) is False

    def test_success_is_billable(self):
        assert _is_billable_success({"formatted_soap": "S: ..."}) is True
        assert _is_billable_success({"status_code": 200, "cid_code": "J06.9"}) is True

    def test_unexpected_shape_fails_open(self):
        # Never silently stop counting legitimate usage on an unexpected shape.
        assert _is_billable_success("not-a-dict") is True
        assert _is_billable_success({}) is True


class TestBillableRoutesGateUsage:
    """Every _log_billable_usage() for a billable action must be gated by
    _is_billable_success(result) — otherwise charge-on-failure returns."""

    def test_all_billable_actions_present(self):
        logged = set(re.findall(r'_log_billable_usage\("([a-z_]+)"\)', ROUTES_SRC))
        for action in BILLABLE_ACTIONS:
            assert action in logged, f"{action} billable log call missing"

    def test_each_billable_log_is_guarded_by_success_check(self):
        for action in BILLABLE_ACTIONS:
            guarded = re.search(
                r"if _is_billable_success\(result\):\s*\n\s*_log_billable_usage\(\""
                + action
                + r"\"\)",
                ROUTES_SRC,
            )
            assert guarded, (
                f'_log_billable_usage("{action}") is not gated by '
                f"_is_billable_success(result) — charge-on-failure regression"
            )
