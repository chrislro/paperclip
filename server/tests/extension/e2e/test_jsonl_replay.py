"""
Phase 3-B — JSONL replay tests.

Tests in this file verify the JSONL-to-Playwright replay converter.
They are marked `replay` and run with:

    make test-extension MARK="replay"
"""

from __future__ import annotations

import json
import pathlib

import pytest

from tests.extension.support.jsonl_replay import JSONLReplay, ReplayError


@pytest.mark.replay
def test_replay_loads_jsonl(jsonl_replay, sample_recording):
    """The replay converter loads a JSONL file and has the expected steps."""
    replay = jsonl_replay(sample_recording)
    assert len(replay.steps) == 5
    assert replay.steps[0]["type"] == "navigate"


@pytest.mark.replay
def test_replay_navigate_step(page, jsonl_replay, sample_recording):
    """A navigate step changes the page URL."""
    replay = jsonl_replay(sample_recording)
    replay.replay_step(0)
    assert page.url == "https://example.com/login"


@pytest.mark.replay
def test_replay_fill_step(page, jsonl_replay, tmp_path):
    """A fill step enters text into a form field."""
    # Create a simple HTML page for the test
    html_path = tmp_path / "test_form.html"
    html_path.write_text("""
    <html>
    <body>
        <form>
            <input id="email" name="email" class="form-control" />
            <button class="btn-primary">Login</button>
        </form>
    </body>
    </html>
    """)
    
    recording_path = tmp_path / "fill_test.jsonl"
    steps = [
        {"type": "navigate", "url": f"file://{html_path}"},
        {"type": "fill", "tag": "input", "id": "email", "value": "test@example.com"},
    ]
    with open(recording_path, "w") as f:
        for step in steps:
            f.write(json.dumps(step) + "\n")
    
    replay = jsonl_replay(recording_path)
    replay.replay()
    
    value = page.evaluate("() => document.getElementById('email').value")
    assert value == "test@example.com"


@pytest.mark.replay
def test_replay_selector_fallback_order(page, jsonl_replay, tmp_path):
    """The replay tries selectors in the correct priority order."""
    html_path = tmp_path / "fallback_test.html"
    html_path.write_text("""
    <html>
    <body>
        <a id="link1" href="#">Click Me</a>
    </body>
    </html>
    """)
    
    recording_path = tmp_path / "fallback_test.jsonl"
    steps = [
        {"type": "navigate", "url": f"file://{html_path}"},
        # Should match by text first, then id, etc.
        {"type": "click", "tag": "a", "text": "Click Me", "id": "link1"},
    ]
    with open(recording_path, "w") as f:
        for step in steps:
            f.write(json.dumps(step) + "\n")
    
    replay = jsonl_replay(recording_path)
    # Should not raise — selector resolution succeeds
    replay.replay()


@pytest.mark.replay
def test_replay_fails_loud_on_missing_selector(page, jsonl_replay, tmp_path):
    """When no selector matches, the replay fails with a DOM diff."""
    html_path = tmp_path / "missing_test.html"
    html_path.write_text("<html><body><p>Hello</p></body></html>")
    
    recording_path = tmp_path / "missing_test.jsonl"
    steps = [
        {"type": "navigate", "url": f"file://{html_path}"},
        {"type": "click", "tag": "button", "id": "nonexistent", "text": "Missing"},
    ]
    with open(recording_path, "w") as f:
        for step in steps:
            f.write(json.dumps(step) + "\n")
    
    replay = jsonl_replay(recording_path)
    
    with pytest.raises(ReplayError) as exc_info:
        replay.replay()
    
    assert "No selector matched" in str(exc_info.value)
    assert exc_info.value.dom_diff is not None
