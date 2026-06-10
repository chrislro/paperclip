"""
Shared fixtures for the Toca Ficha Dr. extension test suite.

Phases:
  3-A  — network_guard (this file, no real browser needed)
  3-B  — JSONL replay fixtures
  3-C  — extension_context (real Chromium + unpacked extension)
  3-D  — snapshot capture
"""

from __future__ import annotations

import json
import pathlib

import pytest

from tests.extension.support.network_guard import NetworkGuard
from tests.extension.support.extension_loader import (
    discover_extension_id,
    new_extension_context,
    new_persistent_extension_context,
)
from tests.extension.support.jsonl_replay import JSONLReplay


# ----------------------------------------------------------------------
# Phase 3-A — Network Guard
# ----------------------------------------------------------------------

@pytest.fixture
def network_guard() -> NetworkGuard:
    """Return a NetworkGuard not attached to any browser page.

    Sufficient for invariant tests (phase 3-A). Phase 3-C will override
    this fixture with one that passes a real Playwright page.
    """
    return NetworkGuard()


# ----------------------------------------------------------------------
# Phase 3-C — Extension Context
# ----------------------------------------------------------------------

@pytest.fixture(scope="session")
def browser_type(playwright):
    """Return the Chromium browser type (required for MV3 extensions)."""
    return playwright.chromium


@pytest.fixture
def extension_context(browser_type):
    """Launch Chromium with the unpacked extension loaded.

    Yields a Playwright BrowserContext. The browser is launched in headed
    mode because headless Chromium does not support MV3 extensions.
    """
    context = new_extension_context(browser_type)
    yield context
    context.close()


@pytest.fixture
def extension_page(extension_context):
    """Return a new page in the extension context."""
    page = extension_context.new_page()
    yield page
    page.close()


@pytest.fixture
def extension_id(extension_context):
    """Discover and return the extension ID via CDP.

    The ID is derived from the extension path and is stable for a given
    checkout on a given machine.
    """
    ext_id = discover_extension_id(extension_context)
    if ext_id is None:
        pytest.fail("Could not discover extension ID — is the extension loaded?")
    return ext_id


@pytest.fixture
def persistent_extension_context(browser_type):
    """Launch Chromium with a persistent profile + unpacked extension.

    Required for tests that navigate to chrome-extension:// URLs (e.g.
    opening the popup directly).  Non-persistent contexts block these
    navigations with ERR_BLOCKED_BY_CLIENT.
    """
    context = new_persistent_extension_context(browser_type)
    yield context
    context.close()


@pytest.fixture
def persistent_extension_id(persistent_extension_context):
    """Discover and return the extension ID from the persistent context."""
    ext_id = discover_extension_id(persistent_extension_context)
    if ext_id is None:
        pytest.fail("Could not discover extension ID from persistent context")
    return ext_id


@pytest.fixture
def persistent_extension_page(persistent_extension_context):
    """Return a new page in the persistent extension context."""
    page = persistent_extension_context.new_page()
    yield page
    page.close()


# ----------------------------------------------------------------------
# Phase 3-B — JSONL Replay
# ----------------------------------------------------------------------

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
