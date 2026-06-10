"""
Read-only invariant guard for g-hosp.com.br.

Intercepts Playwright page requests (when a page is provided) and exposes
check_request() for direct invariant assertions in unit-style tests.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.parse import urlsplit

if TYPE_CHECKING:
    from playwright.sync_api import Page, Request

READ_ONLY_HOSTS: frozenset[str] = frozenset({"g-hosp.com.br"})


class NetworkGuard:
    """Monitors network requests and enforces the read-only invariant."""

    def __init__(self, page: "Page | None" = None) -> None:
        self._violations: list[str] = []
        if page is not None:
            page.on("request", self._on_request)

    # ------------------------------------------------------------------
    # Playwright event handler
    # ------------------------------------------------------------------

    def _on_request(self, request: "Request") -> None:
        self._record(request.method, request.url)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def check_request(self, method: str, url: str) -> None:
        """Raise AssertionError immediately if the request violates the invariant."""
        self._record(method, url)
        self._flush()

    def assert_clean(self) -> None:
        """Call at the end of a test to surface any accumulated violations."""
        self._flush()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _record(self, method: str, url: str) -> None:
        if method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            host = (urlsplit(url).hostname or "").lower()
            if host and any(host == h or host.endswith("." + h) for h in READ_ONLY_HOSTS):
                self._violations.append(f"{method.upper()} {url}")

    def _flush(self) -> None:
        if self._violations:
            msgs = self._violations.copy()
            self._violations.clear()
            raise AssertionError(
                f"Read-only invariant violated: {msgs[0]}"
                + (f" (and {len(msgs) - 1} more)" if len(msgs) > 1 else "")
            )
