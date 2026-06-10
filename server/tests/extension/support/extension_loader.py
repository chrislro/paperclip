"""
Loads the unpacked Chrome extension into a Playwright browser context.

Phase 3-C implementation — provides the `extension_context` fixture for E2E tests.
"""

from __future__ import annotations

import pathlib
import tempfile
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.sync_api import BrowserContext, BrowserType

EXTENSION_ROOT = pathlib.Path(__file__).parents[3]  # repo root


def build_context_args(extension_root: pathlib.Path = EXTENSION_ROOT) -> dict:
    """Return browser launch args that load the extension (Chrome/Chromium only)."""
    ext_path = str(extension_root.resolve())
    return {
        "args": [
            f"--disable-extensions-except={ext_path}",
            f"--load-extension={ext_path}",
            "--no-sandbox",
            "--disable-setuid-sandbox",
        ],
        "headless": False,  # MV3 extensions require headed mode
    }


def discover_extension_id(context: "BrowserContext") -> str | None:
    """Return the chrome-extension:// ID for the loaded extension.

    Uses CDP Target.getTargets via a temporary page to find the service-worker
    target whose URL starts with chrome-extension://.  This works for both
    persistent and non-persistent contexts.
    """
    from playwright.sync_api import sync_playwright

    page = context.new_page()
    page.goto("https://example.com")
    page.wait_for_timeout(500)

    cdp = context.new_cdp_session(page)
    targets = cdp.send("Target.getTargets")
    page.close()

    for t in targets.get("targetInfos", []):
        url = t.get("url", "")
        if t.get("type") == "service_worker" and url.startswith("chrome-extension://"):
            # chrome-extension://<id>/background/...
            return url.split("/")[2]
    return None


def new_extension_context(
    browser_type: "BrowserType",
    extension_root: pathlib.Path = EXTENSION_ROOT,
) -> "BrowserContext":
    """Launch Chromium with the unpacked extension and return the context."""
    launch_options = build_context_args(extension_root)
    browser = browser_type.launch(**launch_options)
    context = browser.new_context()
    return context


def new_persistent_extension_context(
    browser_type: "BrowserType",
    extension_root: pathlib.Path = EXTENSION_ROOT,
) -> "BrowserContext":
    """Launch Chromium with a persistent profile and the unpacked extension.

    Persistent contexts are required for navigating to chrome-extension:// URLs
    (e.g. opening the popup HTML directly).  Non-persistent contexts block these
    navigations with ERR_BLOCKED_BY_CLIENT.
    """
    launch_options = build_context_args(extension_root)
    user_data_dir = tempfile.mkdtemp()
    context = browser_type.launch_persistent_context(
        user_data_dir,
        **launch_options,
    )
    return context
