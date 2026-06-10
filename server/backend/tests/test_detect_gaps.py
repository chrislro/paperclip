import json
import sqlite3
import sys
import os
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
import detect_gaps as DG


def _ev(event, css, page_url, ts, **kw):
    return dict(event=event, css_selector=css, page_url=page_url, ts=ts,
                tag=kw.get("tag", ""), href=kw.get("href", ""),
                id=kw.get("id_", ""), text=kw.get("text", ""))


BASE_URL = "https://prbentogoncalves.g-hosp.com.br/amb/interns?intern_id="


class TestExtractInternId:
    def test_query_param(self):
        url = f"{BASE_URL}12345"
        assert DG.extract_intern_id(url) == "12345"

    def test_path_based(self):
        url = "https://prbentogoncalves.g-hosp.com.br/pr/interns/67890/prconsultas"
        assert DG.extract_intern_id(url) == "67890"

    def test_non_patient_page_returns_none(self):
        assert DG.extract_intern_id("https://prbentogoncalves.g-hosp.com.br/prconsultas") is None


class TestSplitSessions:
    def test_single_session(self):
        events = [
            _ev("click", "#foo", f"{BASE_URL}100", "2026-05-20T10:00:00.000Z"),
            _ev("click", "#bar", f"{BASE_URL}100", "2026-05-20T10:01:00.000Z"),
        ]
        sessions = DG.split_sessions(events)
        assert len(sessions) == 1
        assert sessions[0]["intern_id"] == "100"
        assert len(sessions[0]["events"]) == 2

    def test_two_sessions(self):
        events = [
            _ev("click", "#a", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z"),
            _ev("click", "#b", f"{BASE_URL}2", "2026-05-20T10:05:00.000Z"),
            _ev("click", "#c", f"{BASE_URL}2", "2026-05-20T10:06:00.000Z"),
        ]
        sessions = DG.split_sessions(events)
        assert len(sessions) == 2
        assert sessions[0]["intern_id"] == "1"
        assert sessions[1]["intern_id"] == "2"
        assert len(sessions[1]["events"]) == 2

    def test_non_patient_events_attached_to_last_session(self):
        events = [
            _ev("click", "#a", f"{BASE_URL}5", "2026-05-20T10:00:00.000Z"),
            _ev("click", "#b", "https://prbentogoncalves.g-hosp.com.br/prconsultas",
                "2026-05-20T10:02:00.000Z"),
        ]
        sessions = DG.split_sessions(events)
        assert len(sessions) == 1
        assert len(sessions[0]["events"]) == 2


class TestIsKnownAutomated:
    def test_save_button_is_known(self):
        ev = _ev("click", "#submit_pranamnese", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z",
                 id_="submit_pranamnese")
        assert DG.is_known_automated(ev) is True

    def test_random_nav_link_is_not_gap(self):
        ev = _ev("click", "a.botao", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z",
                 href="/prconsultas", tag="a")
        # Navigation to list page should be excluded
        assert DG.is_nav_click(ev) is True

    def test_unknown_click_is_gap(self):
        ev = _ev("click", "a.custom-button", f"{BASE_URL}1", "2026-05-20T10:00:00.000Z",
                 href="/amb/some_custom_action", tag="a")
        assert DG.is_known_automated(ev) is False
        assert DG.is_nav_click(ev) is False


class TestBuildGapReport:
    def test_report_shape(self):
        sessions = [
            {
                "intern_id": "42",
                "start_ts": "2026-05-20T10:00:00.000Z",
                "end_ts": "2026-05-20T10:10:00.000Z",
                "events": [
                    _ev("click", "#submit_pranamnese", f"{BASE_URL}42",
                        "2026-05-20T10:01:00.000Z", id_="submit_pranamnese"),
                    _ev("click", "a.some-unknown", f"{BASE_URL}42",
                        "2026-05-20T10:02:00.000Z", href="/amb/unknown_action"),
                ],
            }
        ]
        report = DG.build_gap_report(sessions)
        assert "gap_candidates" in report
        assert "total_sessions" in report
        assert report["total_sessions"] == 1
        # The unknown click should be a gap candidate
        assert len(report["gap_candidates"]) >= 1
        # The save button click should NOT be in gaps
        gap_selectors = [g["css_selector"] for g in report["gap_candidates"]]
        assert "#submit_pranamnese" not in gap_selectors
