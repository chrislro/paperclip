import sys
import os
import json
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import calibrate_timings as CT


def _req(method, url, ts_start="2026-05-20T10:00:00.000Z", req_id=1):
    return {"event": "network_request", "id": req_id, "method": method, "url": url, "ts": ts_start}


def _resp(req_id, duration_ms, ts="2026-05-20T10:00:01.000Z", status=200):
    return {"event": "network_response", "id": req_id, "status": status,
            "duration_ms": duration_ms, "ts": ts}


class TestDetectEndpoint:
    def test_prescription_save(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/matmeds"
        assert CT.detect_endpoint("POST", url) == "prescription_save"

    def test_prescription_save_receitas(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/interns/123/receitas"
        assert CT.detect_endpoint("POST", url) == "prescription_save"

    def test_discharge_save(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/interns/1234"
        assert CT.detect_endpoint("PATCH", url) == "discharge_save"

    def test_discharge_save_put(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/interns/9876"
        assert CT.detect_endpoint("PUT", url) == "discharge_save"

    def test_cid_autocomplete(self):
        url = "https://prbentogoncalves.g-hosp.com.br/amb/autocomplete_cid?q=J20"
        assert CT.detect_endpoint("GET", url) == "cid_autocomplete"

    def test_unknown_returns_none(self):
        assert CT.detect_endpoint("GET", "https://prbentogoncalves.g-hosp.com.br/assets/app.css") is None


class TestPercentiles:
    def test_median(self):
        durations = [100.0, 200.0, 300.0, 400.0, 500.0]
        assert CT.percentile(durations, 50) == 300.0

    def test_p95_small_sample(self):
        durations = [100.0, 200.0]
        # With 2 values, linear interpolation gives 195.0 (100 + 0.95*100)
        assert CT.percentile(durations, 95) == 195.0

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            CT.percentile([], 50)


class TestAnalyzeEvents:
    def test_pairs_request_and_response(self):
        events = [
            _req("POST", "https://prbentogoncalves.g-hosp.com.br/amb/matmeds", req_id=1),
            _resp(1, duration_ms=800.0),
            _req("POST", "https://prbentogoncalves.g-hosp.com.br/amb/matmeds", req_id=2),
            _resp(2, duration_ms=1200.0),
        ]
        results = CT.analyze_events(events)
        assert "prescription_save" in results
        assert results["prescription_save"]["count"] == 2
        assert results["prescription_save"]["p50"] == pytest.approx(1000.0, abs=200)

    def test_failed_requests_excluded(self):
        events = [
            _req("PATCH", "https://prbentogoncalves.g-hosp.com.br/amb/interns/99", req_id=3),
            _resp(3, duration_ms=500.0, status=500),
        ]
        results = CT.analyze_events(events)
        # 500 responses should be excluded
        assert results.get("discharge_save", {}).get("count", 0) == 0

    def test_empty_events(self):
        assert CT.analyze_events([]) == {}
