"""
JSONL-to-Playwright replay converter (Phase 3-B).

Reads interaction recordings in JSONL format and replays them via Playwright.
Each line in the JSONL file is a JSON object representing one user interaction
(event) with the page.

Selector fallback order (Lane C):
  1. visible link text
  2. id
  3. name attribute
  4. CSS class chain
  5. absolute XPath

When all selectors miss, a DOM snapshot diff is generated for debugging.
"""

from __future__ import annotations

import json
import pathlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from playwright.sync_api import Page


class ReplayError(Exception):
    """Raised when a replay step cannot be executed."""

    def __init__(self, message: str, step: dict, dom_diff: str | None = None) -> None:
        super().__init__(message)
        self.step = step
        self.dom_diff = dom_diff


class JSONLReplay:
    """Replay a JSONL interaction recording against a Playwright page."""

    def __init__(self, page: "Page", recording_path: pathlib.Path) -> None:
        self.page = page
        self.recording_path = recording_path
        self.steps: list[dict] = []
        self._load()

    def _load(self) -> None:
        with open(self.recording_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.steps.append(json.loads(line))

    # ------------------------------------------------------------------
    # Selector resolution with fallback
    # ------------------------------------------------------------------

    def _resolve_selector(self, step: dict) -> str:
        """Try selectors in priority order; return the first that matches."""
        selectors = []
        
        # 1. visible link text
        if step.get("text"):
            selectors.append(f"text={step['text']}")
        
        # 2. id
        if step.get("id"):
            selectors.append(f"#{step['id']}")
        
        # 3. name attribute
        if step.get("name"):
            selectors.append(f"[name='{step['name']}']")
        
        # 4. CSS class chain
        if step.get("css"):
            selectors.append(step["css"])
        
        # 5. absolute XPath
        if step.get("xpath"):
            selectors.append(f"xpath={step['xpath']}")
        
        for selector in selectors:
            try:
                # Check if element is visible
                element = self.page.locator(selector).first
                if element.is_visible(timeout=100):
                    return selector
            except Exception:
                continue
        
        # All selectors failed — generate DOM diff
        dom_diff = self._capture_dom_diff(step)
        raise ReplayError(
            f"No selector matched for step: {step.get('type', 'unknown')} on {step.get('tag', 'unknown')}",
            step,
            dom_diff,
        )

    def _capture_dom_diff(self, step: dict) -> str:
        """Capture current DOM state for debugging selector failures."""
        try:
            current_html = self.page.content()
            return f"--- Expected element ---\n{json.dumps(step, indent=2)}\n\n--- Current DOM (first 2000 chars) ---\n{current_html[:2000]}"
        except Exception as e:
            return f"Failed to capture DOM: {e}"

    # ------------------------------------------------------------------
    # Action dispatch
    # ------------------------------------------------------------------

    def _dispatch(self, step: dict) -> None:
        """Execute a single replay step."""
        action = step.get("type", "click")
        selector = self._resolve_selector(step)
        
        if action == "click":
            self.page.click(selector)
        elif action == "fill":
            value = step.get("value", "")
            self.page.fill(selector, value)
        elif action == "navigate":
            url = step.get("url", "about:blank")
            self.page.goto(url)
        elif action == "wait":
            timeout = step.get("timeout", 1000)
            self.page.wait_for_timeout(timeout)
        elif action == "wait_for_selector":
            self.page.wait_for_selector(selector, timeout=step.get("timeout", 10000))
        elif action == "scroll":
            self.page.evaluate("() => window.scrollBy(0, window.innerHeight)")
        elif action == "keypress":
            key = step.get("key", "Enter")
            self.page.press(selector, key)
        else:
            raise ReplayError(f"Unknown action type: {action}", step)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def replay(self, stop_on_error: bool = True) -> list[dict]:
        """Replay all steps. Returns list of failed steps if stop_on_error=False."""
        failures = []
        
        for i, step in enumerate(self.steps):
            try:
                self._dispatch(step)
            except ReplayError as e:
                failure = {
                    "index": i,
                    "step": step,
                    "error": str(e),
                    "dom_diff": e.dom_diff,
                }
                if stop_on_error:
                    raise ReplayError(
                        f"Step {i} failed: {e}",
                        step,
                        e.dom_diff,
                    ) from e
                failures.append(failure)
        
        return failures

    def replay_step(self, index: int) -> None:
        """Replay a single step by index."""
        if index < 0 or index >= len(self.steps):
            raise IndexError(f"Step index {index} out of range (0-{len(self.steps)-1})")
        self._dispatch(self.steps[index])
