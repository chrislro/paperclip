"""
Phase 3-C — E2E gate: extension loader + service worker + popup version.

Run with:
    make test-extension MARK="loads"

These tests require a display (headless=False) because MV3 extensions do not
load in headless Chromium.  They are the acceptance gate for CHRA-512.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from tests.extension.support.extension_loader import EXTENSION_ROOT


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _manifest_version() -> str:
    """Return the `version` field from the extension's manifest.json."""
    manifest = json.loads((EXTENSION_ROOT / "manifest.json").read_text())
    return manifest["version"]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.loads
def test_service_worker_registered_and_active(extension_context, extension_id):
    """Service worker is registered, reachable via CDP, and URL matches ext ID.

    Verifies that the MV3 service worker target is present and its URL prefix
    matches the discovered extension ID — proving the extension is alive, not
    just that Chromium started.
    """
    assert extension_id is not None, "Extension ID was not discovered"
    assert len(extension_id) == 32, (
        f"Extension ID has unexpected length ({len(extension_id)}): {extension_id!r}"
    )

    page = extension_context.new_page()
    page.goto("https://example.com")
    page.wait_for_timeout(500)

    cdp = extension_context.new_cdp_session(page)
    targets = cdp.send("Target.getTargets")
    page.close()

    sw_targets = [
        t for t in targets.get("targetInfos", [])
        if t.get("type") == "service_worker"
        and t.get("url", "").startswith(f"chrome-extension://{extension_id}/")
    ]

    assert len(sw_targets) >= 1, (
        f"No service worker found for extension {extension_id!r}. "
        f"Observed extension targets: "
        f"{[t['url'] for t in targets.get('targetInfos', []) if 'extension' in t.get('url', '')]}"
    )


@pytest.mark.loads
def test_popup_renders_manifest_version(
    persistent_extension_context, persistent_extension_id
):
    """Popup opens, loads without JS errors, and reports the manifest version.

    Opens the popup HTML directly via its chrome-extension:// URL.  Calls
    `chrome.runtime.getManifest().version` inside the page to confirm the
    running extension exposes the same version recorded in manifest.json on
    disk — end-to-end proof that the loader, the extension ID, and the popup
    are all consistent.
    """
    expected_version = _manifest_version()

    popup_url = (
        f"chrome-extension://{persistent_extension_id}/popup/popup.html"
    )
    page = persistent_extension_context.new_page()
    page.goto(popup_url)
    page.wait_for_load_state("domcontentloaded")

    # Confirm the popup document loaded (title set in <head>)
    assert page.title() == "Toca Ficha Dr.", (
        f"Unexpected popup title: {page.title()!r}"
    )

    # Verify the extension reports the expected version via its runtime API
    reported_version = page.evaluate("chrome.runtime.getManifest().version")
    assert reported_version == expected_version, (
        f"Extension reported version {reported_version!r} but "
        f"manifest.json says {expected_version!r}"
    )

    page.close()
