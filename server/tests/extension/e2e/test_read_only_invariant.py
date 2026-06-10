"""
Phase 3-A — Read-only invariant: g-hosp.com.br must never receive a POST.

Tests in this file are marked `invariant` and run with:

    make test-extension MARK="invariant"
"""

import pytest

from tests.extension.support.network_guard import NetworkGuard


@pytest.mark.invariant
def test_post_to_g_hosp_raises(network_guard: NetworkGuard) -> None:
    """A deliberate POST to g-hosp.com.br raises AssertionError."""
    with pytest.raises(AssertionError, match="Read-only invariant violated"):
        network_guard.check_request("POST", "https://g-hosp.com.br/api/letters")


@pytest.mark.invariant
def test_put_to_g_hosp_raises(network_guard: NetworkGuard) -> None:
    """PUT is a write method and must be blocked."""
    with pytest.raises(AssertionError, match="Read-only invariant violated"):
        network_guard.check_request("PUT", "https://g-hosp.com.br/api/letters/1")


@pytest.mark.invariant
def test_delete_to_g_hosp_raises(network_guard: NetworkGuard) -> None:
    """DELETE is a write method and must be blocked."""
    with pytest.raises(AssertionError, match="Read-only invariant violated"):
        network_guard.check_request("DELETE", "https://g-hosp.com.br/api/letters/1")


@pytest.mark.invariant
def test_patch_to_g_hosp_raises(network_guard: NetworkGuard) -> None:
    """PATCH is a write method and must be blocked."""
    with pytest.raises(AssertionError, match="Read-only invariant violated"):
        network_guard.check_request("PATCH", "https://g-hosp.com.br/api/letters/1")


@pytest.mark.invariant
def test_get_to_g_hosp_does_not_raise(network_guard: NetworkGuard) -> None:
    """GET requests to g-hosp.com.br are read-only and must be allowed."""
    network_guard.check_request("GET", "https://g-hosp.com.br/api/letters")
    network_guard.assert_clean()


@pytest.mark.invariant
def test_post_to_other_host_does_not_raise(network_guard: NetworkGuard) -> None:
    """POST to unrelated hosts must not be blocked by the invariant guard."""
    network_guard.check_request("POST", "https://api.example.com/data")
    network_guard.assert_clean()


@pytest.mark.invariant
def test_post_to_g_hosp_subdomain_raises(network_guard: NetworkGuard) -> None:
    """Subdomains of g-hosp.com.br are also covered by the invariant."""
    with pytest.raises(AssertionError, match="Read-only invariant violated"):
        network_guard.check_request(
            "POST", "https://api.g-hosp.com.br/v1/prescricao"
        )


@pytest.mark.invariant
def test_playwright_page_invariant_smoke(page) -> None:
    """Live Page + NetworkGuard wiring: a fetch() to g-hosp.com.br triggers the guard.

    This is the real integration test that proves pytest-playwright + NetworkGuard
    work together.  We route the request so no actual network hit occurs.
    """
    guard = NetworkGuard(page)

    # Intercept the request so we don't hit the real host
    page.route("https://g-hosp.com.br/anything", lambda route: route.fulfill(
        status=200, body="{}"
    ))

    # Trigger a POST via page.evaluate — this fires the "request" event
    page.evaluate(
        """async () => {
            try {
                await fetch('https://g-hosp.com.br/anything', {method: 'POST'});
            } catch (e) {
                // network failure is fine — we only care that the request was made
            }
        }"""
    )

    with pytest.raises(AssertionError, match="Read-only invariant violated"):
        guard.assert_clean()
