"""
Phase 3-C — Smoke tests with real Chromium + unpacked extension.

Tests in this file require a display (headless=False) because MV3 extensions
do not load in headless Chromium. They are marked `loader` and run with:

    make test-extension MARK="loader"

Live-EMR tests (any test that touches prbentogoncalves.g-hosp.com.br) are
additionally marked `live_emr` and are skipped by default in CI; they can be
run manually on the Mac Mini behind Tailscale:

    make test-extension MARK="live_emr"
"""

from __future__ import annotations

import pytest

from tests.extension.support.network_guard import NetworkGuard


@pytest.mark.loader
def test_extension_loads_without_errors(extension_page):
    """The extension background page loads without console errors."""
    errors = []
    extension_page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    
    # Navigate to a blank page in the extension context
    extension_page.goto("about:blank")
    
    # Give the extension a moment to initialize
    extension_page.wait_for_timeout(500)
    
    # No unexpected errors should have occurred during initialization
    # Filter out known benign errors (e.g., CSP warnings)
    critical_errors = [
        err for err in errors
        if "Content Security Policy" not in err
    ]
    
    assert not critical_errors, f"Extension initialization errors: {critical_errors}"


@pytest.mark.loader
def test_service_worker_is_active(extension_context, extension_id):
    """The service worker is registered and active.

    We verify this via CDP Target.getTargets (Playwright's background_pages
    only works for MV2; MV3 service workers are not exposed there).
    """
    # extension_id is discovered via CDP in the fixture
    assert extension_id is not None, "Extension ID not discovered"
    assert len(extension_id) == 32, f"Unexpected extension ID format: {extension_id}"

    # Open a temporary page to create a CDP session and verify the SW target
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
        f"No service worker found for extension {extension_id}. "
        f"Targets: {[t['url'] for t in targets.get('targetInfos', []) if 'extension' in t.get('url', '')]}"
    )


@pytest.mark.loader
def test_popup_opens(persistent_extension_page, persistent_extension_id):
    """The extension popup HTML loads and renders its title."""
    popup_url = f"chrome-extension://{persistent_extension_id}/popup/popup.html"
    persistent_extension_page.goto(popup_url)
    persistent_extension_page.wait_for_load_state("networkidle")

    # The popup should load without crashing
    assert persistent_extension_page.title() == "Toca Ficha Dr."

    # Verify at least one expected element is present (mode toggle)
    mode_toggle = persistent_extension_page.query_selector("input[name='backendMode']")
    assert mode_toggle is not None, "Popup did not render mode toggle"


@pytest.mark.live_emr
@pytest.mark.skip(reason="Requires G-Hosp credentials; run manually on Mac Mini")
def test_login_succeeds_and_patient_list_visible(extension_page):
    """Smoke test: login to G-Hosp succeeds and patient list is visible.
    
    This test requires valid credentials and network access to
    prbentogoncalves.g-hosp.com.br. It is skipped in CI and must be run
    manually on the Mac Mini behind Tailscale.
    """
    # TODO: Implement with credential injection from environment
    # Navigate to G-Hosp
    extension_page.goto("https://prbentogoncalves.g-hosp.com.br")
    
    # Wait for login form
    extension_page.wait_for_selector("input[type='email']", timeout=10000)
    
    # Fill credentials (from environment variables, not hardcoded)
    # extension_page.fill("input[type='email']", os.environ["GHOSP_TEST_USER"])
    # extension_page.fill("input[type='password']", os.environ["GHOSP_TEST_PASS"])
    # extension_page.click("button[type='submit']")
    
    # Wait for patient list
    # extension_page.wait_for_selector(".patient-list, [data-testid='patient-list']", timeout=30000)
    
    pytest.fail("Not yet implemented — requires credential setup")
