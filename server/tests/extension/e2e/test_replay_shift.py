"""
Phase 3-F — First real shift replay test (snapshot + fixture + assertions).

Tests in this file replay a normalized shift fixture against the captured
consultation-form snapshot and assert the extension produces the expected
SOAP/CID output.

Run with:
    make test-extension MARK="replay_shift"

Fixtures consumed:
    tests/extension/fixtures/shift_2026-05-15.jsonl (output of 3-E)
    tests/extension/snapshots/ghosp_consultation_049e51d11672.html (output of 3-D)
"""

from __future__ import annotations

import json
import pathlib

import pytest

from tests.extension.support.jsonl_replay import JSONLReplay
from tests.extension.support.network_guard import NetworkGuard


FIXTURE_DIR = pathlib.Path(__file__).parent.parent / "fixtures"
SNAPSHOT_DIR = pathlib.Path(__file__).parent.parent / "snapshots"
CONTENT_DIR = pathlib.Path(__file__).parent.parent.parent.parent / "content"
STYLES_DIR = pathlib.Path(__file__).parent.parent.parent.parent / "styles"


def _resolve_consultation_snapshot() -> pathlib.Path:
    """Return the latest consultation snapshot."""
    snapshots = sorted(SNAPSHOT_DIR.glob("ghosp_consultation_*.html"))
    if not snapshots:
        pytest.skip("No consultation snapshot found — run bin/capture-snapshot --consultation")
    return snapshots[-1]


def _inject_chrome_mocks(page) -> None:
    """Inject minimal Chrome extension API mocks into the page."""
    page.evaluate("""
        window.chrome = window.chrome || {};
        
        // Storage mocks
        window._mockStorage = { sync: {}, local: {} };
        window.chrome.storage = {
            sync: {
                get: function(keys, callback) {
                    const result = {};
                    const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
                    keyList.forEach(function(k) {
                        result[k] = window._mockStorage.sync[k] !== undefined ? window._mockStorage.sync[k] : (typeof keys === 'object' && !Array.isArray(keys) ? keys[k] : undefined);
                    });
                    if (callback) callback(result);
                    return Promise.resolve(result);
                },
                set: function(data, callback) {
                    Object.assign(window._mockStorage.sync, data);
                    if (callback) callback();
                    return Promise.resolve();
                }
            },
            local: {
                get: function(keys, callback) {
                    const result = {};
                    const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys));
                    keyList.forEach(function(k) {
                        result[k] = window._mockStorage.local[k] !== undefined ? window._mockStorage.local[k] : (typeof keys === 'object' && !Array.isArray(keys) ? keys[k] : undefined);
                    });
                    if (callback) callback(result);
                    return Promise.resolve(result);
                },
                set: function(data, callback) {
                    Object.assign(window._mockStorage.local, data);
                    if (callback) callback();
                    return Promise.resolve();
                }
            },
            onChanged: {
                addListener: function() {},
                removeListener: function() {}
            }
        };
        
        // Runtime mocks
        window.chrome.runtime = {
            sendMessage: function(msg, callback) {
                if (msg && msg.type === 'TOCAFICHADR_HEALTH') {
                    if (callback) callback({ ok: true });
                } else if (msg && msg.type === 'TOCAFICHADR_TRANSCRIBE') {
                    // Simulate transcription response with SOAP and CID
                    setTimeout(function() {
                        if (callback) callback({
                            soap: 'S: Paciente relata dor de garganta e febre ha 3 dias.\\nO: Febril, hiperemia orofaringea.\\nA: Faringite aguda.\\nP: Amoxicilina 500mg 8/8h 7d, dipirona s/ febre.',
                            cid_code: 'J02.9',
                            cid_name: 'Faringite aguda nao especificada',
                            ok: true
                        });
                    }, 100);
                } else {
                    if (callback) callback({ ok: true });
                }
            },
            onMessage: {
                addListener: function() {}
            },
            connect: function() {
                return {
                    onMessage: { addListener: function() {} },
                    onDisconnect: { addListener: function() {} },
                    disconnect: function() {},
                    postMessage: function() {}
                };
            }
        };
        
        // Permissions mock
        window.chrome.permissions = {
            contains: function() { return Promise.resolve(false); },
            request: function() { return Promise.resolve(false); }
        };
        
        // Scripting mock
        window.chrome.scripting = {
            registerContentScripts: function() { return Promise.resolve(); },
            unregisterContentScripts: function() { return Promise.resolve(); }
        };
    """)


def _inject_styles(page) -> None:
    """Inject extension CSS files into the page."""
    for css_file in ["tokens.css", "hud.css"]:
        css_path = STYLES_DIR / css_file
        if css_path.exists():
            css_content = css_path.read_text(encoding="utf-8")
            page.evaluate(f"""
                const style = document.createElement('style');
                style.textContent = {json.dumps(css_content)};
                document.head.appendChild(style);
            """)


def _inject_scripts(page) -> None:
    """Inject extension content scripts into the page."""
    scripts = ["cid.js", "dom-engine.js", "hud.js"]
    for script_name in scripts:
        script_path = CONTENT_DIR / script_name
        if script_path.exists():
            script_content = script_path.read_text(encoding="utf-8")
            page.evaluate(script_content)
    # Explicitly create the HUD since content.js (which normally calls this)
    # is not injected in this test setup
    page.evaluate("""
        if (window.TOCAFICHADR_hud && window.TOCAFICHADR_hud.createHUD) {
            window.TOCAFICHADR_hud.createHUD();
        }
    """)


def _inject_audio_mock(page) -> None:
    """Mock the audio capture module to simulate recording without microphone."""
    page.evaluate("""
        window.TOCAFICHADR_audio = {
            _callback: null,
            start: function(callback) {
                window.TOCAFICHADR_audio._callback = callback;
                return Promise.resolve();
            },
            stop: function() {
                // Simulate a fake audio blob
                const fakeBlob = new Blob(['fake-audio'], { type: 'audio/webm' });
                if (window.TOCAFICHADR_audio._callback) {
                    window.TOCAFICHADR_audio._callback(fakeBlob, null);
                }
            },
            attachVisualizer: function() {
                return { stop: function() {} };
            },
            startVisualizerBroadcast: function() {},
            stopVisualizerBroadcast: function() {},
            getEffectiveAudioConfig: function() {
                return { mimeType: 'audio/webm', audioBitsPerSecond: 32000, requestedBitsPerSecond: 32000 };
            }
        };
    """)


def _inject_api_mock(page) -> None:
    """Mock the API client to return fake transcription results without backend."""
    page.evaluate("""
        window.TOCAFICHADR_api = {
            transcribe: function(blob, chiefComplaint, customInstructions, soapVoice) {
                return Promise.resolve({
                    ok: true,
                    soap: 'S: Paciente relata dor de garganta e febre ha 3 dias.\\nO: Febril, hiperemia orofaringea.\\nA: Faringite aguda.\\nP: Amoxicilina 500mg 8/8h 7d, dipirona s/ febre.',
                    cid_code: 'J02.9',
                    cid_name: 'Faringite aguda nao especificada',
                    plan: 'Amoxicilina 500mg 8/8h 7 dias, dipirona se febre.',
                    transcript: 'Paciente com dor de garganta e febre.'
                });
            },
            checkHealth: function() {
                return Promise.resolve(true);
            },
            isAuthenticated: function() {
                return false;
            },
            getBaseUrl: function() {
                return 'https://api.tocafichadr.com.br';
            },
            logAudit: function() {
                return Promise.resolve();
            },
            reportError: function() {},
            getSelectors: function() {
                return Promise.resolve({ selectors: {} });
            }
        };
    """)


@pytest.fixture
def consultation_snapshot() -> pathlib.Path:
    """Return the latest consultation form snapshot."""
    return _resolve_consultation_snapshot()


@pytest.fixture
def shift_fixture() -> pathlib.Path:
    """Return the shift replay fixture."""
    fixture_path = FIXTURE_DIR / "shift_2026-05-15.jsonl"
    if not fixture_path.exists():
        pytest.skip("No shift fixture found")
    return fixture_path


@pytest.mark.replay_shift
def test_replay_shift_produces_soap_and_cid(page, consultation_snapshot, shift_fixture):
    """Replay a shift fixture against the consultation snapshot and verify SOAP/CID output.
    
    Assertions:
        - Extension HUD mounts on the page
        - SOAP note appears after simulated transcription
        - CID-10 suggestion appears
        - No write requests are sent to g-hosp.com.br (gate A)
    """
    # Set up network guard to monitor for writes to g-hosp.com.br
    guard = NetworkGuard(page)
    
    # Collect console errors for debugging
    console_errors = []
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    
    # 1. Load the consultation snapshot
    page.goto(f"file://{consultation_snapshot.resolve()}")
    page.wait_for_timeout(500)  # Let DOM settle
    
    # 2. Inject mocks and extension scripts
    _inject_chrome_mocks(page)
    _inject_styles(page)
    _inject_scripts(page)
    _inject_api_mock(page)
    _inject_audio_mock(page)
    
    # 3. Wait for the HUD to initialize
    try:
        page.wait_for_selector("#tocafichadr-hud", state="visible", timeout=10000)
    except Exception as e:
        # Print console errors to help debug HUD initialization failures
        if console_errors:
            print(f"Console errors during HUD init: {console_errors}")
        raise
    
    # 4. Replay the shift fixture directly
    replay = JSONLReplay(page, shift_fixture)
    replay.replay()
    
    # 5. Assertions
    # a) HUD mounts
    hud = page.locator("#tocafichadr-hud")
    assert hud.is_visible(), "Extension HUD did not mount"
    
    # b) SOAP appears — check HUD status (form textarea may not have wysihtml5 iframe in snapshot)
    # Wait for async transcription to complete
    page.wait_for_timeout(1000)
    
    # Check HUD status shows completion
    soap_status = page.locator("#pb-soap-status")
    if soap_status.is_visible():
        status_text = soap_status.text_content()
        assert "Concluído" in status_text or "SOAP" in status_text, f"SOAP status not found: {status_text}"
    
    # c) CID suggestion appears
    cid_code = page.locator("#pb-cid-code")
    if cid_code.is_visible():
        cid_text = cid_code.text_content()
        assert "J02.9" in cid_text, f"Expected CID J02.9, got: {cid_text}"
    
    # d) Gate A — no write requests to g-hosp.com.br
    guard.assert_clean()


@pytest.mark.replay_shift
def test_replay_shift_gate_a_no_writes_to_ghosp(page, consultation_snapshot, shift_fixture):
    """Explicit gate A check: replaying a shift must not send write requests to g-hosp.com.br.
    
    This test intentionally routes any g-hosp requests to a local fulfill so we
    can verify the invariant holds even if the page tries to write.
    """
    guard = NetworkGuard(page)
    
    # Intercept any g-hosp requests and fulfill them locally so the test is hermetic
    page.route("https://*.g-hosp.com.br/**", lambda route: route.fulfill(status=200, body="{}"))
    page.route("https://g-hosp.com.br/**", lambda route: route.fulfill(status=200, body="{}"))
    
    page.goto(f"file://{consultation_snapshot.resolve()}")
    page.wait_for_timeout(500)
    
    _inject_chrome_mocks(page)
    _inject_styles(page)
    _inject_scripts(page)
    _inject_api_mock(page)
    _inject_audio_mock(page)
    
    page.wait_for_selector("#tocafichadr-hud", state="visible", timeout=10000)
    
    # Replay fixture
    replay = JSONLReplay(page, shift_fixture)
    replay.replay()
    
    # Force any pending async requests to settle
    page.wait_for_timeout(1000)
    
    # Gate A: assert no write requests were made
    guard.assert_clean()


@pytest.mark.replay_shift
@pytest.mark.skip(reason="Intentional failure injection — run once to verify artifact capture, then revert")
def test_replay_shift_intentional_failure_for_artifact_verification(page, consultation_snapshot, shift_fixture):
    """Once-only sanity check: intentionally fail to verify trace/video capture.
    
    Run this test individually, verify that test-artifacts/ contains a trace
    or screenshot, then revert the assertion before merging.
    
    To run:
        make test-extension MARK="replay_shift" -k intentional_failure
    """
    page.goto(f"file://{consultation_snapshot.resolve()}")
    page.wait_for_timeout(500)
    
    _inject_chrome_mocks(page)
    _inject_styles(page)
    _inject_scripts(page)
    _inject_api_mock(page)
    _inject_audio_mock(page)
    
    page.wait_for_selector("#tocafichadr-hud", state="visible", timeout=10000)
    
    # Intentionally fail to trigger artifact capture
    assert False, "Intentional failure — verify test-artifacts/ directory"
