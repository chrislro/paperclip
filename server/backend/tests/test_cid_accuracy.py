import sys
import os
import json
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import cid_accuracy as CA


def _cid_event(value, ts="2026-05-20T10:00:00.000Z", intern_id="99"):
    return {
        "event": "input",
        "id": "intcid_cid_id",
        "value": value,
        "ts": ts,
        "page_url": f"https://prbentogoncalves.g-hosp.com.br/amb/interns?intern_id={intern_id}",
        "css_selector": "#intcid_cid_id",
        "tag": "input",
    }


class TestIsCidCode:
    def test_valid_full(self):
        assert CA.is_cid_code("J20.9") is True

    def test_valid_short(self):
        assert CA.is_cid_code("A09") is True

    def test_valid_letter_suffix(self):
        assert CA.is_cid_code("Z00.1") is True

    def test_partial_typing_rejected(self):
        assert CA.is_cid_code("J") is False
        assert CA.is_cid_code("J2") is False

    def test_empty_rejected(self):
        assert CA.is_cid_code("") is False

    def test_description_text_rejected(self):
        assert CA.is_cid_code("Bronquite aguda") is False


class TestExtractCidInputs:
    def test_extracts_final_value_per_session(self):
        events = [
            _cid_event("J", "2026-05-20T10:00:00.000Z", "5"),
            _cid_event("J20", "2026-05-20T10:00:01.000Z", "5"),
            _cid_event("J20.9", "2026-05-20T10:00:02.000Z", "5"),
        ]
        results = CA.extract_cid_inputs(events)
        # Should capture the final valid CID per intern_id session
        assert len(results) == 1
        assert results[0]["cid_code"] == "J20.9"
        assert results[0]["intern_id"] == "5"

    def test_ignores_partial_typing(self):
        events = [_cid_event("J2", "2026-05-20T10:00:00.000Z", "7")]
        results = CA.extract_cid_inputs(events)
        assert results == []

    def test_multiple_sessions(self):
        events = [
            _cid_event("J20.9", "2026-05-20T10:00:00.000Z", "1"),
            _cid_event("A09", "2026-05-20T11:00:00.000Z", "2"),
        ]
        results = CA.extract_cid_inputs(events)
        codes = {r["cid_code"] for r in results}
        assert codes == {"J20.9", "A09"}


class TestBuildFrequencyReport:
    def test_ranks_by_frequency(self):
        inputs = [
            {"cid_code": "J20.9", "intern_id": "1", "ts": "2026-05-20T10:00:00Z"},
            {"cid_code": "J20.9", "intern_id": "2", "ts": "2026-05-20T11:00:00Z"},
            {"cid_code": "A09",   "intern_id": "3", "ts": "2026-05-20T12:00:00Z"},
        ]
        report = CA.build_frequency_report(inputs)
        assert report[0]["cid_code"] == "J20.9"
        assert report[0]["count"] == 2
        assert report[1]["cid_code"] == "A09"
        assert report[1]["count"] == 1
