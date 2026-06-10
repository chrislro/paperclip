"""CHRA-2423 Bug 68 — CID `confidence` from the LLM must be coerced to float.

`transcribe_audio` decides whether to accept the speculative (chief-complaint-only)
CID with:

    spec_confidence = spec_cid.get("confidence", 0) or 0
    spec_accepted = spec_confidence >= _CID_SPECULATIVE_CONFIDENCE_THRESHOLD

`spec_cid` is the LLM's parsed JSON. `response_format=json_object` guarantees valid
JSON but NOT that `confidence` is numeric — models sometimes emit "0.85" (string) or
"alta". In Python 3, `"0.85" >= 0.7` raises TypeError, which propagates out of
transcribe_audio and fails the whole request — the doctor loses a recorded
consultation to an intermittent model formatting quirk.

The fix normalizes `confidence` to float inside `_attach_cid_observability`, the
single choke point every CID result (lookup / Groq / OpenAI / empty) passes through.
"""
from emr_automation.extension_api import (
    _attach_cid_observability,
    _CID_SPECULATIVE_CONFIDENCE_THRESHOLD,
)


def _conf(raw):
    """Run a raw LLM dict through the choke point and read back confidence."""
    out = _attach_cid_observability({"cid_code": "J00", "confidence": raw}, {}, 0.1)
    return out["confidence"]


def test_string_confidence_is_coerced_to_float():
    assert _conf("0.85") == 0.85
    assert isinstance(_conf("0.85"), float)


def test_numeric_confidence_passes_through_unchanged():
    assert _conf(0.99) == 0.99
    assert _conf(1) == 1.0


def test_nonnumeric_confidence_becomes_zero_not_crash():
    # "alta"/garbage → 0.0, which is BELOW threshold → safe re-run, never accepted
    # on an unparseable value.
    assert _conf("alta") == 0.0
    assert _conf(None) == 0.0
    assert _conf("") == 0.0


def test_missing_confidence_key_is_left_absent():
    # The empty-failure CID result is `{}`; we must not invent a confidence key —
    # the call site's `.get("confidence", 0)` handles absence.
    out = _attach_cid_observability({}, {"provider": "none"}, 0.1)
    assert "confidence" not in out


def test_threshold_comparison_no_longer_raises_on_string_confidence():
    """The actual Bug 68 failure: this comparison TypeErrored pre-fix when the
    LLM returned a string. After coercion it is a plain float comparison."""
    out = _attach_cid_observability({"confidence": "0.9"}, {}, 0.1)
    spec_confidence = out.get("confidence", 0) or 0
    # Pre-fix spec_confidence would be the str "0.9" and this line raised TypeError.
    assert (spec_confidence >= _CID_SPECULATIVE_CONFIDENCE_THRESHOLD) is True
    # And a low string confidence stays correctly below threshold.
    low = _attach_cid_observability({"confidence": "0.3"}, {}, 0.1)
    low_conf = low.get("confidence", 0) or 0
    assert (low_conf >= _CID_SPECULATIVE_CONFIDENCE_THRESHOLD) is False
