"""
Playwright interaction + network logger for G-HOSP workflow recording.

Captures everything the user does in the browser so Claude can learn to
automate it:
  - Click events  → tag, id, name, text, value, XPath, CSS selector
  - Input / change events → field name, new value, XPath
  - Form submit events
  - Network requests / responses (filtered to g-hosp.com.br by default)

Output: JSONL lines to logs/ghosp_interactions_<timestamp>.jsonl
Each line is a JSON object with at minimum {"ts": "...", "event": "..."}
"""

from __future__ import annotations

import argparse
import configparser
import json
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from emr_automation.constants import DEFAULT_CONFIG, PlaywrightLocators, URLPatterns
from emr_automation.credential_manager import get_credential_manager
from emr_automation.exceptions import AccountLockedError, BadCredentialsError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _default_output_path() -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return Path("logs") / f"ghosp_interactions_{ts}.jsonl"


def _to_serializable(headers: Dict[str, str]) -> Dict[str, str]:
    return {str(k): str(v) for k, v in headers.items()}


def _find_free_cdp_port(start: int = 9222, end: int = 9230) -> int:
    """Find a TCP port in [start, end] not currently bound on 127.0.0.1.

    Chrome's --remote-debugging-port silently fails if the port is taken
    (e.g. by a long-running gstack browser-harness — which on this Mac Mini
    holds :9222 per the project setup — or another Chrome dev session).
    Without this, the logger either times out waiting for CDP or, worse,
    connect_over_cdp attaches to the OTHER Chrome already on 9222 and drives
    the wrong browser. Scan a small range so the logger gets its own instance.
    """
    import socket
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free CDP port in range {start}-{end}")


def _clean_stale_singleton_locks(profile_dir: Path) -> None:
    """Remove SingletonLock if it points to a non-existent process.

    Chrome leaves SingletonLock/Cookie/Socket symlinks behind after a crash;
    they block subsequent launches with the same --user-data-dir until removed.
    """
    lock = profile_dir / "SingletonLock"
    if not lock.is_symlink():
        return
    try:
        target = os.readlink(str(lock))
        pid = int(target.rsplit("-", 1)[-1])  # symlink target: "<host>-<pid>"
        os.kill(pid, 0)  # raises if process gone
    except (OSError, ValueError):
        for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
            try:
                (profile_dir / name).unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# JavaScript injected into every page to capture DOM interactions
# ---------------------------------------------------------------------------
_INTERACTION_JS = r"""
(function () {
    'use strict';

    function getXPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el === document.documentElement) return '/html';
        if (el === document.body) return '/html/body';
        if (el.id) return '//*[@id="' + el.id + '"]';
        var parent = el.parentNode;
        if (!parent || parent.nodeType !== 1) return '/' + el.tagName.toLowerCase();
        var siblings = Array.from(parent.children).filter(function (c) {
            return c.tagName === el.tagName;
        });
        var idx = siblings.indexOf(el) + 1;
        var tag = el.tagName.toLowerCase();
        var suffix = siblings.length > 1 ? '[' + idx + ']' : '';
        return getXPath(parent) + '/' + tag + suffix;
    }

    function getCSSSelector(el) {
        if (!el || !el.tagName) return '';
        if (el.id) return '#' + el.id;
        var tag = el.tagName.toLowerCase();
        var classes = Array.from(el.classList).slice(0, 3).join('.');
        return classes ? tag + '.' + classes : tag;
    }

    function getElementInfo(el) {
        if (!el || !el.tagName) return {};
        var _type = el.getAttribute('type') || '';
        // NEVER capture password-field values into the interaction log. The
        // auto-login fills the EMR password and a session-expiry re-login types
        // it while logging is active; this JSONL persists to disk, so logging the
        // raw value would leak a reusable credential. (Patient data in other
        // fields follows the documented single-tenant local-log posture; a
        // password is a credential and must always be redacted.)
        var _value;
        if (_type.toLowerCase() === 'password') {
            _value = '[redacted-password]';
        } else {
            _value = el.value !== undefined ? String(el.value).substring(0, 500) : '';
        }
        return {
            tag:          el.tagName.toLowerCase(),
            id:           el.id || '',
            name:         el.getAttribute('name') || '',
            class_attr:   el.className || '',
            text:         (el.innerText || el.textContent || '').trim().substring(0, 300),
            value:        _value,
            type:         _type,
            placeholder:  el.getAttribute('placeholder') || '',
            href:         el.getAttribute('href') || '',
            data_id:      el.getAttribute('data-id') || '',
            aria_label:   el.getAttribute('aria-label') || '',
            xpath:        getXPath(el),
            css_selector: getCSSSelector(el),
        };
    }

    function emit(eventType, el, extra) {
        var info = getElementInfo(el);
        info.event      = eventType;
        info.page_url   = window.location.href;
        info.page_title = document.title;
        if (extra) Object.assign(info, extra);
        try {
            window.__logInteraction(info);
        } catch (e) {
            // logInteraction not yet bound — silently drop
        }
    }

    // Debounced input timers — shared across all instrumented documents so
    // typing in a wysihtml5 iframe still coalesces with subsequent edits.
    var inputTimers = new WeakMap();

    function instrumentDocument(doc, frameContext) {
        // Idempotency: every document gets a marker so re-injection (e.g. on
        // SPA navigation, or the periodic retry below) is a no-op.
        if (!doc || doc.__tocafLoggerAttached) return false;
        doc.__tocafLoggerAttached = true;

        var ctx = frameContext || {};
        function emitFromFrame(eventType, el, extra) {
            var combined = Object.assign({}, ctx, extra || {});
            emit(eventType, el, combined);
        }

        doc.addEventListener('click', function (e) {
            emitFromFrame('click', e.target);
        }, true);

        doc.addEventListener('change', function (e) {
            emitFromFrame('change', e.target);
        }, true);

        doc.addEventListener('submit', function (e) {
            emitFromFrame('submit', e.target);
        }, true);

        doc.addEventListener('input', function (e) {
            var el = e.target;
            if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));
            inputTimers.set(el, setTimeout(function () {
                emitFromFrame('input', el);
            }, 800));
        }, true);

        doc.addEventListener('focus', function (e) {
            var el = e.target;
            if (el && el.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
                emitFromFrame('focus', el);
            }
        }, true);

        doc.addEventListener('keydown', function (e) {
            if (['Enter', 'Tab'].includes(e.key)) {
                var el = e.target;
                if (el && el.tagName && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)) {
                    emitFromFrame('keydown_' + e.key.toLowerCase(), el, {key: e.key});
                }
            }
        }, true);
        return true;
    }

    // ------------------------------------------------------------------
    // Iframe coverage
    // ------------------------------------------------------------------
    // G-Hosp uses iframes for the wysihtml5 rich-text SOAP editors and (in
    // some flows) prescription dialogs. DOM events do NOT bubble across
    // frame boundaries even for same-origin iframes — listeners must be
    // attached inside each iframe's contentDocument directly. Strategy:
    // (a) sweep current iframes at load, (b) MutationObserver for new ones,
    // (c) periodic 1s retry for 10s because wysihtml5's contentDocument
    //     becomes accessible on a delay after the iframe is appended.
    function instrumentSameOriginFrames() {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
            var ifr = iframes[i];
            try {
                var idoc = ifr.contentDocument;
                if (!idoc) continue;
                if (idoc.__tocafLoggerAttached) continue;
                var ctx = {
                    iframe_id: ifr.id || '',
                    iframe_name: ifr.getAttribute('name') || '',
                    iframe_class: ifr.className || '',
                    iframe_xpath: getXPath(ifr),
                    in_iframe: true,
                };
                if (instrumentDocument(idoc, ctx)) {
                    emit('iframe_attached', ifr, ctx);
                }
            } catch (e) {
                // Cross-origin iframe — opaque, nothing we can do.
            }
        }
    }

    // Top-level page
    instrumentDocument(document);

    // First sweep — many wysihtml5 frames are already attached when this runs
    instrumentSameOriginFrames();

    // React to dynamically-added iframes (prescription dialog opens lazily)
    try {
        var iframeObserver = new MutationObserver(function () {
            instrumentSameOriginFrames();
        });
        iframeObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
        });
    } catch (e) {}

    // Defensive retry — wysihtml5 sometimes finalizes contentDocument after
    // the MutationObserver fires; re-poll cheaply for 10s.
    var retries = 0;
    var retryInterval = setInterval(function () {
        retries++;
        instrumentSameOriginFrames();
        if (retries >= 10) clearInterval(retryInterval); // 10 × 1s = 10s
    }, 1000);
})();
"""


# ---------------------------------------------------------------------------
# JSONL writer
# ---------------------------------------------------------------------------
class JsonlLogger:
    def __init__(self, output_path: Path):
        self.output_path = output_path
        self._lock = threading.Lock()
        self.output_path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, event: Dict[str, Any]) -> None:
        with self._lock:
            with self.output_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# Config / credential helpers  (mirrors network_logger.py)
# ---------------------------------------------------------------------------

def _normalize_base_url(base_url: str) -> str:
    return base_url.strip().rstrip("/")


def _load_config(config_path: Path) -> configparser.ConfigParser:
    config = configparser.ConfigParser()
    for section, options in DEFAULT_CONFIG.items():
        config[section] = {k: str(v) for k, v in options.items()}
    if config_path.exists():
        config.read(config_path)
    return config


def _resolve_credentials(
    explicit_username: str,
    explicit_password: str,
    config: configparser.ConfigParser,
) -> Tuple[str, str]:
    cli_user = explicit_username.strip()
    cli_pass = explicit_password.strip()
    if cli_user and cli_pass:
        return cli_user, cli_pass
    cfg_user, cfg_pass = get_credential_manager().get_credentials(config=config)
    return (cli_user or cfg_user).strip(), (cli_pass or cfg_pass).strip()


def _is_post_login_url(url: str) -> bool:
    if "/users/sign_in" in url:
        return False
    return any(path in url for path in URLPatterns.POST_LOGIN_PATHS)


def _wait_for_post_login(page, timeout_seconds: int) -> bool:
    deadline = time.monotonic() + max(1, timeout_seconds)
    while time.monotonic() < deadline:
        try:
            if _is_post_login_url(page.url):
                return True
        except Exception:
            pass
        page.wait_for_timeout(300)
    return False


def _wait_for_atendimento_button(page, timeout_seconds: int) -> bool:
    deadline = time.monotonic() + max(1, timeout_seconds)
    while time.monotonic() < deadline:
        for selector in PlaywrightLocators.ATENDIMENTO:
            try:
                page.locator(selector).first.wait_for(state="visible", timeout=300)
                return True
            except Exception:
                continue
    return False


def _auto_login_to_consultations(
    *,
    page,
    base_url: str,
    username: str,
    password: str,
    timeout_seconds: int,
    manual_login_timeout: int,
) -> bool:
    login_url = URLPatterns.login_url(base_url)
    consultations_url = URLPatterns.consultations_url(base_url)
    timeout_ms = max(1, timeout_seconds) * 1000

    print(f"Opening login page: {login_url}")
    page.goto(login_url, wait_until="domcontentloaded", timeout=60000)

    auto_attempted = False
    if username and password:
        try:
            email = page.locator(PlaywrightLocators.LOGIN_EMAIL).first
            pw_field = page.locator(PlaywrightLocators.LOGIN_PASSWORD).first
            submit = page.locator(PlaywrightLocators.LOGIN_SUBMIT).first
            email.wait_for(state="visible", timeout=timeout_ms)
            email.fill(username)
            pw_field.fill(password)
            submit.click()
            auto_attempted = True
            print("Auto-login submitted.")
        except Exception as exc:
            print(f"Auto-login failed: {exc}")
    else:
        print("No credentials found; waiting for manual login.")

    if not _wait_for_post_login(page, timeout_seconds):
        # Devise terminal-failure detection: if we just auto-submitted credentials
        # and they were rejected (or the account is already locked), abort BEFORE
        # the manual-login wait — Devise locks the account after 3 failed attempts
        # and IT must unlock it.
        if auto_attempted:
            try:
                page_text = (page.content() or "").lower()
            except Exception:
                page_text = ""
            if "está bloqueada" in page_text or "account is locked" in page_text:
                raise AccountLockedError(
                    "EMR account is locked. Visit /users/unlock/new or contact IT."
                )
            bad_cred_markers = (
                "senha inválid", "senha invalid", "e-mail ou senha",
                "email ou senha", "invalid email or password",
            )
            if any(m in page_text for m in bad_cred_markers):
                raise BadCredentialsError(
                    "EMR rejected credentials. Halting interaction logger to "
                    "protect against Devise account lockout (locks after 3 strikes)."
                )
        wait_s = max(1, manual_login_timeout)
        if auto_attempted:
            print(f"Auto-login did not complete. Waiting {wait_s}s for manual login...")
        else:
            print(f"Waiting {wait_s}s for manual login...")
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            try:
                if _is_post_login_url(page.url):
                    break
            except Exception:
                pass
            page.wait_for_timeout(1000)
        else:
            print("Login timed out.")
            return False

    if consultations_url not in page.url:
        page.goto(consultations_url, wait_until="domcontentloaded", timeout=60000)
    else:
        page.wait_for_load_state("domcontentloaded", timeout=60000)

    if _wait_for_atendimento_button(page, timeout_seconds):
        print("Consultations page ready.")
    else:
        print("Reached consultations page (Atendimento button not confirmed).")
    return True


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

def run_interaction_logger(
    *,
    base_url: str,
    host_filter: str,
    output_path: Path,
    headless: bool,
    capture_seconds: Optional[int],
    log_all_hosts: bool,
    auto_login: bool,
    username: str,
    password: str,
    timeout_seconds: int,
    manual_login_timeout: int,
    extension_path: str = "",
) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        print(f"Playwright unavailable: {exc}")
        print("Install: pip install playwright && playwright install chromium")
        return 2

    logger = JsonlLogger(output_path)
    request_started_at: Dict[int, float] = {}

    def include_url(url: str) -> bool:
        return log_all_hosts or host_filter.lower() in url.lower()

    def log_event(payload: Dict[str, Any]) -> None:
        if "ts" not in payload:
            payload["ts"] = _timestamp()
        logger.write(payload)

    resolved_ext = Path(extension_path).expanduser().resolve() if extension_path else None
    chrome_process = None

    with sync_playwright() as p:
        if resolved_ext and resolved_ext.is_dir():
            # Launch real Chrome with extension support, connect Playwright via CDP
            profile_dir = Path.home() / ".tocafichadr-chrome-profile-logger"
            user_data_dir = str(profile_dir)
            chrome_binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            if not os.path.exists(chrome_binary):
                print(f"Chrome not found at {chrome_binary}, falling back to Playwright Chromium")
                resolved_ext = None  # fall through to the else branch below

        if resolved_ext and resolved_ext.is_dir():
            # Clean stale Chrome locks + pick a free CDP port so the logger never
            # silently attaches to another Chrome already holding 9222 (e.g.
            # browser-harness on the Mac Mini). See _find_free_cdp_port.
            _clean_stale_singleton_locks(profile_dir)
            try:
                cdp_port = _find_free_cdp_port()
            except RuntimeError as exc:
                print(f"Cannot find a free CDP port: {exc}")
                return 4
            cdp_url = f"http://127.0.0.1:{cdp_port}"
            chrome_args = [
                chrome_binary,
                f"--user-data-dir={user_data_dir}",
                f"--load-extension={resolved_ext}",
                f"--remote-debugging-port={cdp_port}",
                "--start-maximized",
                "--no-first-run",
                "--no-default-browser-check",
            ]
            print(f"Launching Chrome with extension: {resolved_ext} (CDP port {cdp_port})")
            chrome_process = subprocess.Popen(
                chrome_args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Wait for Chrome's CDP endpoint to be ready
            for _ in range(30):
                time.sleep(0.5)
                try:
                    import urllib.request
                    urllib.request.urlopen(f"{cdp_url}/json/version", timeout=2)
                    break
                except Exception:
                    continue
            else:
                print(f"Chrome did not start in time on port {cdp_port}.")
                chrome_process.kill()
                return 4

            browser = p.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0]
        else:
            if extension_path:
                print(f"Warning: extension_path not found, skipping: {extension_path}")
            browser = p.chromium.launch(
                headless=headless,
                args=["--start-maximized"],
            )
            context = browser.new_context(
                ignore_https_errors=True,
                no_viewport=True,
            )

        # Expose Python callback so JS can push interaction events
        def _on_interaction(data: Any) -> None:
            if isinstance(data, dict):
                if "ts" not in data:
                    data["ts"] = _timestamp()
                log_event(data)

        context.expose_function("__logInteraction", _on_interaction)

        # Inject interaction listeners into every page / frame
        context.add_init_script(_INTERACTION_JS)

        # CDP-connected or persistent contexts may already have a page open
        page = context.pages[0] if context.pages else context.new_page()

        # Network: route handler for requests
        def route_handler(route):
            req = route.request
            req_id = id(req)
            request_started_at[req_id] = time.monotonic()
            if include_url(req.url):
                log_event({
                    "event":         "network_request",
                    "id":            req_id,
                    "method":        req.method,
                    "url":           req.url,
                    "resource_type": req.resource_type,
                    "headers":       _to_serializable(req.headers),
                })
            route.continue_()

        def on_response(resp):
            req = resp.request
            req_id = id(req)
            started = request_started_at.pop(req_id, None)
            duration_ms = None if started is None else round((time.monotonic() - started) * 1000, 2)
            if include_url(req.url):
                log_event({
                    "event":         "network_response",
                    "id":            req_id,
                    "method":        req.method,
                    "url":           req.url,
                    "status":        resp.status,
                    "ok":            resp.ok,
                    "resource_type": req.resource_type,
                    "duration_ms":   duration_ms,
                    "content_type":  resp.headers.get("content-type", ""),
                })

        def on_request_failed(req):
            req_id = id(req)
            started = request_started_at.pop(req_id, None)
            duration_ms = None if started is None else round((time.monotonic() - started) * 1000, 2)
            if include_url(req.url):
                log_event({
                    "event":         "network_request_failed",
                    "id":            req_id,
                    "method":        req.method,
                    "url":           req.url,
                    "resource_type": req.resource_type,
                    "duration_ms":   duration_ms,
                    "failure_text":  req.failure or "",
                })

        context.route("**/*", route_handler)
        page.on("response", on_response)
        page.on("requestfailed", on_request_failed)

        # Dialog handler: Playwright auto-dismisses native dialogs
        # (confirm/alert/prompt) when no listener is attached. That silently
        # breaks the user's real workflow — they click a button expecting a
        # confirmation prompt, but the dialog is dismissed before they see it.
        # Log the dialog AND call accept() so the user's "click OK" intent
        # is honored. (If the user genuinely wants Cancel, they should stop
        # the logger first.)
        def on_dialog(dialog):
            try:
                log_event({
                    "event":   "dialog",
                    "type":    dialog.type,
                    "message": dialog.message,
                    "ts":      _timestamp(),
                })
            except Exception:
                pass
            try:
                dialog.accept()
            except Exception:
                pass
        page.on("dialog", on_dialog)
        # Also attach to any future pages/tabs opened in the same context
        def on_new_page(new_page):
            try:
                new_page.on("dialog", on_dialog)
            except Exception:
                pass
        context.on("page", on_new_page)

        try:
            if auto_login:
                ok = _auto_login_to_consultations(
                    page=page,
                    base_url=base_url,
                    username=username,
                    password=password,
                    timeout_seconds=timeout_seconds,
                    manual_login_timeout=manual_login_timeout,
                )
                if not ok:
                    try:
                        browser.close()
                    except Exception:
                        pass
                    if chrome_process:
                        chrome_process.terminate()
                    return 3
            else:
                print(f"Opening: {base_url}")
                page.goto(base_url, wait_until="domcontentloaded", timeout=60000)
        except BadCredentialsError as e:
            print(f"❌ Interaction Logger: credenciais rejeitadas — encerrado para evitar bloqueio da conta (Devise: 3 strikes). {e}")
            try:
                browser.close()
            except Exception:
                pass
            if chrome_process:
                chrome_process.terminate()
            return 4
        except AccountLockedError as e:
            print(f"❌ Interaction Logger: conta EMR bloqueada — encerrado. Contate IT. {e}")
            try:
                browser.close()
            except Exception:
                pass
            if chrome_process:
                chrome_process.terminate()
            return 5
        except KeyboardInterrupt:
            print("Interrupted during login.")
            try:
                browser.close()
            except Exception:
                pass
            if chrome_process:
                chrome_process.terminate()
            return 130

        print(f"\n=== Interaction Logger active ===")
        print(f"Output: {output_path}")
        print(f"Network filter: {'ALL hosts' if log_all_hosts else host_filter}")
        print(f"Logging: clicks, inputs, changes, form submits + network traffic")
        print(f"Work normally in the browser. Press Ctrl+C to stop.\n")

        try:
            if capture_seconds and capture_seconds > 0:
                page.wait_for_timeout(capture_seconds * 1000)
            else:
                while True:
                    page.wait_for_timeout(1000)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                browser.close()
            except Exception:
                pass
            if chrome_process:
                chrome_process.terminate()

    print(f"Session saved to: {output_path}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser(default_url: str, default_config_path: Path) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record all browser interactions + network traffic on G-HOSP."
    )
    parser.add_argument("--config", type=Path, default=default_config_path)
    parser.add_argument("--url", default=default_url)
    parser.add_argument("--host-filter", default="g-hosp.com.br")
    parser.add_argument("--output", type=Path, default=_default_output_path())
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--capture-seconds", type=int, default=None)
    parser.add_argument("--all-hosts", action="store_true")
    parser.add_argument("--no-auto-login", action="store_true")
    parser.add_argument("--username", default="")
    parser.add_argument("--password", default="")
    parser.add_argument("--timeout", type=int, default=None)
    parser.add_argument("--manual-login-timeout", type=int, default=None)
    return parser


def main() -> int:
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--config", type=Path, default=Path("config.ini"))
    pre_args, _ = pre_parser.parse_known_args()

    pre_config = _load_config(pre_args.config)
    default_url = pre_config.get("EMR", "base_url", fallback=DEFAULT_CONFIG["EMR"]["base_url"])

    parser = _build_parser(default_url=default_url, default_config_path=pre_args.config)
    args = parser.parse_args()
    config = _load_config(args.config)

    base_url = _normalize_base_url(
        args.url or config.get("EMR", "base_url", fallback=DEFAULT_CONFIG["EMR"]["base_url"])
    )
    if not base_url:
        parser.error("Missing --url and no default EMR base URL found.")

    timeout_seconds = args.timeout or config.getint("Browser", "timeout", fallback=30)
    manual_login_timeout = (
        args.manual_login_timeout
        or config.getint("Browser", "manual_login_timeout", fallback=120)
    )
    username, password = _resolve_credentials(args.username, args.password, config)

    extension_path = config.get("Browser", "extension_path", fallback="").strip()

    return run_interaction_logger(
        base_url=base_url,
        host_filter=args.host_filter,
        output_path=args.output,
        headless=args.headless,
        capture_seconds=args.capture_seconds,
        log_all_hosts=args.all_hosts,
        auto_login=not args.no_auto_login,
        username=username,
        password=password,
        timeout_seconds=timeout_seconds,
        manual_login_timeout=manual_login_timeout,
        extension_path=extension_path,
    )


if __name__ == "__main__":
    raise SystemExit(main())
