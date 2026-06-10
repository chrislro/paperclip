"""
Fixtures for JSONL replay tests (Phase 3-B).
"""

from __future__ import annotations

import json
import pathlib
import pytest

from tests.extension.support.jsonl_replay import JSONLReplay


@pytest.fixture
def jsonl_replay(page):
    """Return a JSONLReplay instance bound to the current page."""
    def _create(path: pathlib.Path):
        return JSONLReplay(page, path)
    return _create


@pytest.fixture
def sample_recording(tmp_path):
    """Create a minimal sanitized JSONL recording for testing."""
    recording_path = tmp_path / "sample_recording.jsonl"
    
    steps = [
        {
            "type": "navigate",
            "url": "https://example.com/login",
            "timestamp": 1715731200000,
        },
        {
            "type": "wait_for_selector",
            "tag": "input",
            "id": "email",
            "name": "email",
            "css": "input#email.form-control",
            "xpath": "/html/body/div[1]/form/input[1]",
            "timeout": 5000,
            "timestamp": 1715731201000,
        },
        {
            "type": "fill",
            "tag": "input",
            "id": "email",
            "name": "email",
            "css": "input#email.form-control",
            "xpath": "/html/body/div[1]/form/input[1]",
            "value": "test@example.com",
            "timestamp": 1715731202000,
        },
        {
            "type": "click",
            "tag": "button",
            "text": "Login",
            "css": "button.btn-primary",
            "xpath": "/html/body/div[1]/form/button",
            "timestamp": 1715731203000,
        },
        {
            "type": "wait_for_selector",
            "tag": "div",
            "text": "Dashboard",
            "css": "div.dashboard-header",
            "xpath": "/html/body/div[1]/div[1]",
            "timeout": 10000,
            "timestamp": 1715731204000,
        },
    ]
    
    with open(recording_path, "w", encoding="utf-8") as f:
        for step in steps:
            f.write(json.dumps(step) + "\n")
    
    return recording_path
