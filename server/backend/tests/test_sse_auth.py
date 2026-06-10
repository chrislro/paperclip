"""Tests for require_sse_auth + mint_sse_cookie (CHRA-2217 / CHRA-2335).

The /api/events SSE stream leaks live patient_id, so it is auth-gated. Because
EventSource cannot send an Authorization header, the gate accepts a signed,
HttpOnly, SameSite=Strict cookie (tfd_sse) minted when the dashboard index page
is served — in addition to the normal Bearer paths.

⚠️ The real SSE generator loops forever. NEVER GET /api/events on a pass-path
   or the test hangs. Pass-paths are exercised through a non-streaming probe
   route; the real endpoint is only asserted on the 401 path, where the
   decorator returns *before* the streaming view ever runs.

The probe route is mounted UNDER /api/events (`/api/events/__sse_probe__`)
rather than at the site root, because mint_sse_cookie scopes the cookie to
path=/api/events. A root-level probe would never receive that realistically
scoped cookie (verified: Werkzeug's test client enforces cookie-path matching),
so mounting the probe under the same path lets test_probe_pass_valid_cookie_
gate_on exercise the actual minted cookie end-to-end.
"""
import pytest
from unittest.mock import patch, MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session

from emr_automation.database import Base, reset_engine
from emr_automation import auth as auth_module


def _mock_clerk_state(signed_in=True, sub="user_op_001", email="op@doc.test"):
    """Mirror test_auth.py's helper: a MagicMock Clerk auth state so an
    authenticated GET / can mint the tfd_sse cookie offline. CHRA-2403 made /
    require auth, so the cookie-minting GET / must now be authenticated."""
    state = MagicMock()
    state.is_signed_in = signed_in
    state.payload = {"sub": sub, "email": email} if signed_in else {}
    state.reason = None
    return state


# Probe lives under /api/events so the path-scoped tfd_sse cookie reaches it.
# It returns immediately (no streaming) — safe to GET on pass-paths.
PROBE_PATH = "/api/events/__sse_probe__"


# ---------------------------------------------------------------------------
# Fixtures (mirror test_auth.py)
# ---------------------------------------------------------------------------

@pytest.fixture
def in_memory_db(monkeypatch):
    """Replace get_session with an in-memory SQLite session factory."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionFactory = scoped_session(sessionmaker(bind=engine))

    def _get_session():
        return SessionFactory()

    monkeypatch.setattr("emr_automation.database.get_session", _get_session)
    yield SessionFactory
    SessionFactory.remove()
    reset_engine()


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("ALLOW_MISSING_OPENAI", "1")
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    auth_module._CLERK_CLIENT = None
    auth_module._CLERK_IMPORT_FAILED = False
    from emr_automation.dashboard.app import create_app
    application = create_app()
    application.config["TESTING"] = True
    yield application


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def probe_app(app):
    """`app` plus a non-streaming probe route guarded by require_sse_auth.

    Registered during fixture setup — i.e. BEFORE the first request — so Flask
    accepts the late route addition. Mounted under /api/events so the
    path-scoped SSE cookie is delivered to it.
    """
    from emr_automation.auth import require_sse_auth

    @app.route(PROBE_PATH)
    @require_sse_auth
    def _sse_probe():
        return "ok", 200

    return app


# ---------------------------------------------------------------------------
# Real /api/events endpoint — 401 path only (decorator returns before stream)
# ---------------------------------------------------------------------------

def test_real_events_401_gate_on_no_cookie(client, in_memory_db, monkeypatch):
    """Gate on + no cookie/bearer → 401 from the decorator, before streaming.

    Safe to hit the real endpoint here: require_sse_auth returns the 401
    response without ever invoking the (infinite) generator.
    """
    monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
    r = client.get("/api/events")
    assert r.status_code == 401
    assert r.get_json().get("code") == "AUTH_REQUIRED"


def test_index_mints_cookie(client, in_memory_db):
    """Authed GET / sets the signed tfd_sse cookie, HttpOnly + SameSite=Strict.

    CHRA-2403: / now requires auth (@require_auth), so the cookie is only minted
    to an authenticated operator. The minting GET is authenticated via a mocked
    Clerk JWT; an anonymous GET / 401s and mints nothing (covered by
    TestDashboardAuth.test_index_requires_auth in test_auth.py)."""
    with patch.object(auth_module, "_get_clerk_client") as mock_get:
        mock_clerk = MagicMock()
        mock_clerk.authenticate_request.return_value = _mock_clerk_state()
        mock_get.return_value = mock_clerk
        r = client.get("/", headers={"Authorization": "Bearer good"})
    assert r.status_code == 200
    set_cookie = " ".join(r.headers.get_all("Set-Cookie"))
    assert "tfd_sse" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=Strict" in set_cookie


# ---------------------------------------------------------------------------
# Probe route — pass-paths (never touches the streaming view)
# ---------------------------------------------------------------------------

def test_probe_pass_gate_off(probe_app, in_memory_db, monkeypatch):
    """Gate off → back-compat pass-through even with no credentials."""
    monkeypatch.delenv("TOCAFICHADR_AUTH_REQUIRED", raising=False)
    r = probe_app.test_client().get(PROBE_PATH)
    assert r.status_code == 200


def test_probe_pass_valid_cookie_gate_on(probe_app, in_memory_db, monkeypatch):
    """Gate on + valid minted cookie → pass. End-to-end operator path:

    an authenticated operator loads / (minting tfd_sse), then their same-origin
    EventSource — modelled by the non-streaming probe presenting only the cookie
    — is authorized. This is the CHRA-2403 guarantee that gating / behind
    @require_auth does NOT break the operator's live dashboard stream.

    CHRA-2403: the minting GET / is now authenticated (mocked Clerk JWT); the
    probe request carries only the path-scoped cookie (no bearer).
    """
    monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
    c = probe_app.test_client()
    with patch.object(auth_module, "_get_clerk_client") as mock_get:
        mock_clerk = MagicMock()
        mock_clerk.authenticate_request.return_value = _mock_clerk_state()
        mock_get.return_value = mock_clerk
        r0 = c.get("/", headers={"Authorization": "Bearer good"})  # mints tfd_sse
    assert r0.status_code == 200
    r1 = c.get(PROBE_PATH)     # cookie alone, no bearer — the EventSource path
    assert r1.status_code == 200


def test_probe_401_tampered_cookie_gate_on(probe_app, in_memory_db, monkeypatch):
    """Gate on + tampered cookie → signature check fails → 401."""
    monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
    c = probe_app.test_client()
    c.set_cookie("tfd_sse", "garbage", path="/")
    r = c.get(PROBE_PATH)
    assert r.status_code == 401
    assert r.get_json().get("code") == "AUTH_REQUIRED"


def test_probe_pass_valid_bearer_gate_on(probe_app, in_memory_db, monkeypatch):
    """Gate on + valid EXTENSION_API_KEY bearer → pass (bearer path wins)."""
    monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
    monkeypatch.setenv("EXTENSION_API_KEY", "k")
    c = probe_app.test_client()
    r = c.get(PROBE_PATH, headers={"Authorization": "Bearer k"})
    assert r.status_code == 200
