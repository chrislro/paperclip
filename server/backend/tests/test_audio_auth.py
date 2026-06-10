"""Tests for /api/audio/* auth gating (CHRA-2336, CHRA-2217 follow-up).

The audio endpoints are dangerous when unauthenticated: /api/audio/start
captures the host microphone, /api/audio/stop runs billable transcription,
and /api/audio/insert injects arbitrary text into the live EMR page. Before
this fix all four were wide open — verified live on production (status=200,
start/stop/insert reached their handlers) while sibling routes 401'd.

These are normal fetch() endpoints (not EventSource), so they take the
codebase-standard @require_extension_or_user gate: Bearer EXTENSION_API_KEY
or Clerk JWT, enforcement keyed on TOCAFICHADR_AUTH_REQUIRED. The tfd_sse
cookie is deliberately NOT accepted here — it is path-scoped to /api/events
and never reaches these routes.
"""

from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session

from emr_automation.database import Base, reset_engine
from emr_automation import auth as auth_module


def _mock_clerk_state(signed_in=True, sub="user_audio_001", email="audio@doc.test"):
    state = MagicMock()
    state.is_signed_in = signed_in
    state.payload = {"sub": sub, "email": email} if signed_in else {}
    state.reason = None if signed_in else "mocked-rejection"
    return state


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


# ---------------------------------------------------------------------------
# Gate on — anonymous requests must 401 before the handler runs
# ---------------------------------------------------------------------------

class TestAudioAuthGateOn:

    def test_status_401_anon(self, client, monkeypatch):
        """Anon GET /api/audio/status → 401. Pre-fix this returned 200 with
        live recorder state to anyone who could reach the tunnel."""
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        r = client.get("/api/audio/status")
        assert r.status_code == 401
        assert r.get_json().get("code") == "AUTH_REQUIRED"

    def test_start_401_anon(self, client, monkeypatch):
        """Anon POST /api/audio/start → 401, recorder never touched. Pre-fix
        an anonymous request could switch on the host microphone."""
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        r = client.post("/api/audio/start")
        assert r.status_code == 401
        assert r.get_json().get("code") == "AUTH_REQUIRED"

    def test_stop_401_anon(self, client, monkeypatch):
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        r = client.post("/api/audio/stop")
        assert r.status_code == 401
        assert r.get_json().get("code") == "AUTH_REQUIRED"

    def test_insert_401_anon(self, client, monkeypatch):
        """Anon POST /api/audio/insert → 401 before any body parsing. Pre-fix
        this injected attacker text into the focused EMR field (400 'note is
        required' proved the handler ran)."""
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        r = client.post("/api/audio/insert", json={"note": "attacker text"})
        assert r.status_code == 401
        assert r.get_json().get("code") == "AUTH_REQUIRED"


# ---------------------------------------------------------------------------
# Gate on — authenticated paths reach the handler
# ---------------------------------------------------------------------------

class TestAudioAuthPassPaths:

    def test_status_passes_with_extension_key(self, client, monkeypatch):
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        monkeypatch.setenv("EXTENSION_API_KEY", "k")
        r = client.get(
            "/api/audio/status", headers={"Authorization": "Bearer k"}
        )
        # handler ran: recorder.status() always returns a JSON dict
        assert r.status_code == 200

    def test_insert_passes_with_valid_clerk_jwt(self, client, in_memory_db, monkeypatch):
        """Valid Clerk JWT → handler runs. 400 'note is required' (not 401)
        proves auth passed and the handler-level validation fired."""
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state()
            mock_get.return_value = mock_clerk
            r = client.post(
                "/api/audio/insert",
                json={},
                headers={"Authorization": "Bearer good"},
            )
        assert r.status_code == 400
        assert "note is required" in r.get_json().get("error", "")

    def test_sse_cookie_does_not_authorize_audio(self, client, in_memory_db, monkeypatch):
        """The tfd_sse cookie must NOT open the audio endpoints: it is minted
        for the path-scoped EventSource only. A client presenting only that
        cookie (no bearer) still 401s here."""
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state()
            mock_get.return_value = mock_clerk
            r0 = client.get("/", headers={"Authorization": "Bearer good"})  # mints tfd_sse
        assert r0.status_code == 200
        r1 = client.get("/api/audio/status")  # cookie alone, no bearer
        assert r1.status_code == 401


# ---------------------------------------------------------------------------
# Gate off — deploy-safe back-compat pass-through
# ---------------------------------------------------------------------------

class TestAudioAuthGateOff:

    def test_status_passes_anon_gate_off(self, client, monkeypatch):
        """Gate off → back-compat pass-through, matching every other
        @require_extension_or_user route."""
        monkeypatch.delenv("TOCAFICHADR_AUTH_REQUIRED", raising=False)
        r = client.get("/api/audio/status")
        assert r.status_code == 200
