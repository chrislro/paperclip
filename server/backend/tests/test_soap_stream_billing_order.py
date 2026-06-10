"""CHRA-2423 Bug 45 — /api/soap-stream must log usage + observability BEFORE [DONE].

The side-panel service worker aborts the streaming fetch the instant it receives
the `data: [DONE]` frame (service-worker.src.js: on '[DONE]' it calls
`port.disconnect()` → `port.onDisconnect` → `aborter.abort()`). That closes the
connection before the Flask generator can resume, so ANY statement placed after
`yield "data: [DONE]\\n\\n"` is unreachable on the happy path.

Pre-fix, the success-path `log_usage(user_id, "soap_stream")` and
`_log_model_observability("soap_stream_observability", final_payload)` sat AFTER
the [DONE] yield → the Phase-B audit row was never written and the success-path
model observability was never logged (only the error path logged). Same mechanism
as the sibling Pediatrics repo's a3ee672 (there it was a free-tier daily-limit
bypass because soap-stream billed "transcribe"; here soap_stream is non-billable
per Bug 38, so the impact is lost observability/audit rather than a bypass).

A behavioural test can't catch this: Flask's test client drains the generator
fully (no abort), so the orphaned calls DO run under test even on the buggy code.
This is therefore a source-ordering tripwire — it fails if the success-path
logging is ever moved back below the [DONE] yield.
"""
import re
from pathlib import Path

ROUTES = (
    Path(__file__).resolve().parents[1]
    / "emr_automation" / "dashboard" / "routes.py"
).read_text()


def _soap_stream_source() -> str:
    """Isolate the api_soap_stream function body so we don't match [DONE] in the
    module-level docstring/comments or in any other route."""
    start = ROUTES.index("def api_soap_stream(")
    # Next top-level decorator/def marks the end of this function.
    m = re.search(r"\n@bp\.route\(|\n@require_|\ndef ", ROUTES[start + 1:])
    end = start + 1 + m.start() if m else len(ROUTES)
    return ROUTES[start:end]


def test_usage_and_observability_logged_before_done_frame():
    src = _soap_stream_source()

    done_idx = src.find('yield "data: [DONE]\\n\\n"')
    usage_idx = src.find('log_usage(user_id, "soap_stream")')
    obs_idx = src.find(
        '_log_model_observability("soap_stream_observability", final_payload)'
    )

    assert done_idx != -1, "the [DONE] terminator frame must exist"
    assert usage_idx != -1, "success-path log_usage(soap_stream) must exist"
    assert obs_idx != -1, "success-path _log_model_observability(final_payload) must exist"

    # The SW aborts on [DONE]; both success-path side effects must run before it.
    assert usage_idx < done_idx, (
        "log_usage(soap_stream) must run BEFORE the [DONE] yield — the SW aborts "
        "the fetch on [DONE], so a call after it is unreachable (Bug 45)"
    )
    assert obs_idx < done_idx, (
        "_log_model_observability(final_payload) must run BEFORE the [DONE] yield "
        "— otherwise success-path observability is silently dropped (Bug 45)"
    )
