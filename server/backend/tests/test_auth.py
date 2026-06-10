"""Tests for the v3.0 Clerk JWKS auth path in emr_automation.auth.

The pre-v3.0 test suite covered HS256 generate_token/decode_token and the
custom /auth/register and /auth/login endpoints. Those are gone now —
clerk_backend_api SDK handles JWT verification, /auth/* routes return 410.

These tests cover the new surface:
- _verify_clerk_jwt mocks the clerk_backend_api SDK
- _resolve_user_id lazy-provisioning + idempotency
- require_auth + optional_auth + require_extension_or_user decorators
- TOCAFICHADR_AUTH_REQUIRED gate behavior
- EXTENSION_API_KEY shared-secret escape hatch
- /auth/login + /auth/refresh return 410 CLERK_MIGRATION
"""
from unittest.mock import patch, MagicMock
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session

from emr_automation.database import Base, reset_engine
from emr_automation import auth as auth_module
from emr_automation.models import User


# ---------------------------------------------------------------------------
# Fixtures
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


def _mock_clerk_state(signed_in=True, sub="user_test_001", email="test@example.com", reason=None):
    state = MagicMock()
    state.is_signed_in = signed_in
    state.payload = {"sub": sub, "email": email} if signed_in else {}
    state.reason = reason
    return state


# ---------------------------------------------------------------------------
# _resolve_user_id — lazy provisioning + idempotency
# ---------------------------------------------------------------------------

class TestResolveUserId:

    def test_returns_none_for_empty_clerk_id(self, in_memory_db):
        assert auth_module._resolve_user_id("", "x@y") is None
        assert auth_module._resolve_user_id(None, "x@y") is None

    def test_lazy_provisions_new_user(self, in_memory_db):
        uid = auth_module._resolve_user_id("user_lazy_001", "newdoc@test.local")
        assert isinstance(uid, int)
        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_lazy_001").first()
        assert u is not None
        assert u.email == "newdoc@test.local"
        assert u.plan == "free"
        assert u.password_hash == ""
        assert u.trial_ends_at is not None, "JIT-provisioned user must get a trial"
        assert u.is_trial_active() is True

    def test_idempotent_on_second_call(self, in_memory_db):
        uid1 = auth_module._resolve_user_id("user_idem_001", "doc@test")
        uid2 = auth_module._resolve_user_id("user_idem_001", "doc@test")
        assert uid1 == uid2
        sess = in_memory_db()
        count = sess.query(User).filter_by(clerk_user_id="user_idem_001").count()
        assert count == 1

    def test_falls_back_to_placeholder_email_when_api_unreachable(self, in_memory_db, monkeypatch):
        # API lookup returns None (e.g. Clerk down or import failed).
        monkeypatch.setattr(auth_module, "_fetch_clerk_user_email", lambda _uid: None)
        uid = auth_module._resolve_user_id("user_noemail_001", None)
        assert uid is not None
        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_noemail_001").first()
        assert u.email == "user_noemail_001@unknown.local"

    def test_uses_api_fallback_when_jwt_email_missing(self, in_memory_db, monkeypatch):
        # JWT carried no email; API returns the real one. New row must NOT
        # be created with the @unknown.local placeholder.
        monkeypatch.setattr(
            auth_module, "_fetch_clerk_user_email",
            lambda uid: "doctor@real.example" if uid == "user_apifb_001" else None,
        )
        uid = auth_module._resolve_user_id("user_apifb_001", None)
        assert uid is not None
        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_apifb_001").first()
        assert u.email == "doctor@real.example"

    def test_jwt_email_preferred_over_api(self, in_memory_db, monkeypatch):
        # When JWT carries email, API should never be consulted.
        api_calls = {"n": 0}
        def _api_should_not_be_called(_uid):
            api_calls["n"] += 1
            return "wrong@from.api"
        monkeypatch.setattr(auth_module, "_fetch_clerk_user_email", _api_should_not_be_called)
        uid = auth_module._resolve_user_id("user_jwtfirst_001", "from.jwt@x.test")
        assert uid is not None
        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_jwtfirst_001").first()
        assert u.email == "from.jwt@x.test"
        assert api_calls["n"] == 0, "API must not be called when JWT had email"

    def test_backfills_placeholder_on_next_signin(self, in_memory_db, monkeypatch):
        # Pre-seed a user with the placeholder email — simulates the
        # 2026-05-25 Mini state. Next sign-in should backfill the real email.
        seed_sess = in_memory_db()
        seed_sess.add(User(
            clerk_user_id="user_backfill_001",
            email="user_backfill_001@unknown.local",
            plan="free",
            password_hash="",
        ))
        seed_sess.commit()
        # Now simulate sign-in with JWT email.
        uid = auth_module._resolve_user_id("user_backfill_001", "doctor@now.real")
        assert uid is not None
        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_backfill_001").first()
        assert u.email == "doctor@now.real", "placeholder must be replaced with real email"

    def test_backfill_uses_api_when_jwt_email_still_missing(self, in_memory_db, monkeypatch):
        # Placeholder row exists; JWT still has no email but API does.
        seed_sess = in_memory_db()
        seed_sess.add(User(
            clerk_user_id="user_apibackfill_001",
            email="user_apibackfill_001@unknown.local",
            plan="free",
            password_hash="",
        ))
        seed_sess.commit()
        monkeypatch.setattr(
            auth_module, "_fetch_clerk_user_email",
            lambda uid: "api.found@x.test" if uid == "user_apibackfill_001" else None,
        )
        auth_module._resolve_user_id("user_apibackfill_001", None)
        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_apibackfill_001").first()
        assert u.email == "api.found@x.test"


# ---------------------------------------------------------------------------
# _extract_email_from_clerk_payload — JWT email extraction across shapes
# ---------------------------------------------------------------------------

class TestExtractEmailFromClerkPayload:

    def test_flat_email_claim(self):
        assert auth_module._extract_email_from_clerk_payload(
            {"sub": "user_x", "email": "doctor@x.test"}
        ) == "doctor@x.test"

    def test_email_address_alt_claim(self):
        assert auth_module._extract_email_from_clerk_payload(
            {"sub": "user_x", "email_address": "doctor@x.test"}
        ) == "doctor@x.test"

    def test_email_addresses_with_primary_id(self):
        payload = {
            "sub": "user_x",
            "primary_email_address_id": "idn_002",
            "email_addresses": [
                {"id": "idn_001", "email_address": "old@x.test"},
                {"id": "idn_002", "email_address": "primary@x.test"},
            ],
        }
        assert auth_module._extract_email_from_clerk_payload(payload) == "primary@x.test"

    def test_email_addresses_no_primary_id_falls_back_to_first(self):
        payload = {
            "sub": "user_x",
            "email_addresses": [
                {"id": "idn_001", "email_address": "first@x.test"},
                {"id": "idn_002", "email_address": "second@x.test"},
            ],
        }
        assert auth_module._extract_email_from_clerk_payload(payload) == "first@x.test"

    def test_returns_none_for_empty_payload(self):
        assert auth_module._extract_email_from_clerk_payload({}) is None
        assert auth_module._extract_email_from_clerk_payload(None) is None
        assert auth_module._extract_email_from_clerk_payload("not a dict") is None

    def test_returns_none_for_garbage_shapes(self):
        # Non-email strings, missing @, wrong types in nested arrays.
        assert auth_module._extract_email_from_clerk_payload(
            {"email": "not_an_email"}
        ) is None
        assert auth_module._extract_email_from_clerk_payload(
            {"email": 123}
        ) is None
        assert auth_module._extract_email_from_clerk_payload(
            {"email_addresses": [{"email_address": "no_at_sign"}]}
        ) is None

    def test_flat_email_wins_over_addresses_array(self):
        # Defensive: when both shapes are present, prefer the flat claim
        # because the session template puts it there explicitly.
        payload = {
            "email": "from.flat@x.test",
            "primary_email_address_id": "idn_001",
            "email_addresses": [
                {"id": "idn_001", "email_address": "from.array@x.test"},
            ],
        }
        assert auth_module._extract_email_from_clerk_payload(payload) == "from.flat@x.test"


# ---------------------------------------------------------------------------
# _fetch_clerk_user_email — Clerk Users API fallback
# ---------------------------------------------------------------------------

class TestFetchClerkUserEmail:

    def test_returns_none_when_clerk_unavailable(self, monkeypatch):
        monkeypatch.setattr(auth_module, "_get_clerk_client", lambda: None)
        assert auth_module._fetch_clerk_user_email("user_x") is None

    def test_returns_none_when_no_clerk_user_id(self):
        assert auth_module._fetch_clerk_user_email("") is None
        assert auth_module._fetch_clerk_user_email(None) is None

    def test_returns_primary_email_when_primary_id_set(self, monkeypatch):
        addr1 = MagicMock(id="idn_001", email_address="old@x.test")
        addr2 = MagicMock(id="idn_002", email_address="primary@x.test")
        user = MagicMock(
            primary_email_address_id="idn_002",
            email_addresses=[addr1, addr2],
        )
        clerk = MagicMock()
        clerk.users.get.return_value = user
        monkeypatch.setattr(auth_module, "_get_clerk_client", lambda: clerk)
        assert auth_module._fetch_clerk_user_email("user_x") == "primary@x.test"

    def test_returns_first_when_no_primary_id(self, monkeypatch):
        addr1 = MagicMock(id="idn_001", email_address="first@x.test")
        addr2 = MagicMock(id="idn_002", email_address="second@x.test")
        user = MagicMock(
            primary_email_address_id=None,
            email_addresses=[addr1, addr2],
        )
        clerk = MagicMock()
        clerk.users.get.return_value = user
        monkeypatch.setattr(auth_module, "_get_clerk_client", lambda: clerk)
        assert auth_module._fetch_clerk_user_email("user_x") == "first@x.test"

    def test_returns_none_on_api_exception(self, monkeypatch):
        clerk = MagicMock()
        clerk.users.get.side_effect = RuntimeError("clerk api down")
        monkeypatch.setattr(auth_module, "_get_clerk_client", lambda: clerk)
        assert auth_module._fetch_clerk_user_email("user_x") is None

    def test_returns_none_on_empty_email_addresses(self, monkeypatch):
        user = MagicMock(
            primary_email_address_id=None,
            email_addresses=[],
        )
        clerk = MagicMock()
        clerk.users.get.return_value = user
        monkeypatch.setattr(auth_module, "_get_clerk_client", lambda: clerk)
        assert auth_module._fetch_clerk_user_email("user_x") is None


# ---------------------------------------------------------------------------
# require_auth / optional_auth via Flask test client
# ---------------------------------------------------------------------------

class TestRequireAuth:

    def test_returns_401_when_no_bearer(self, client, in_memory_db):
        r = client.get("/billing/subscription")
        assert r.status_code == 401
        assert r.get_json().get("error") == "Authentication required"

    def test_returns_401_when_clerk_rejects_token(self, client, in_memory_db):
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state(
                signed_in=False, reason="TOKEN_INVALID"
            )
            mock_get.return_value = mock_clerk
            r = client.get("/billing/subscription", headers={"Authorization": "Bearer junk"})
            assert r.status_code == 401

    def test_passes_with_valid_clerk_jwt(self, client, in_memory_db):
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state(
                signed_in=True, sub="user_real_001", email="real@doc.test"
            )
            mock_get.return_value = mock_clerk
            r = client.get("/billing/subscription", headers={"Authorization": "Bearer good"})
            # auth passed → handler runs (404 means no subscription found, NOT auth failure)
            assert r.status_code != 401, f"got {r.status_code}: {r.get_data(as_text=True)}"
            sess = in_memory_db()
            u = sess.query(User).filter_by(clerk_user_id="user_real_001").first()
            assert u is not None


class TestDashboardAuth:
    """CHRA-2403 / CHRA-2394: the operator dashboard (`/`) must require auth so
    the signed tfd_sse cookie is only minted to authenticated operators, while
    the SSE stream (`/api/events`) keeps the cookie-based @require_sse_auth gate
    so the browser EventSource (which cannot send a Bearer header) still works.

    The stale chra-2394 branch put @require_auth on BOTH routes; that 401s the
    EventSource. We converge main to: @require_auth on `/`, @require_sse_auth on
    `/api/events`.

    ⚠️ The real /api/events generator loops forever — pass-paths are asserted on
       a non-streaming probe, never on the live endpoint (see test_sse_auth.py).
       The end-to-end "authed `/` cookie → SSE stream" operator path is covered
       by test_probe_pass_valid_cookie_gate_on in test_sse_auth.py.
    """

    def test_index_requires_auth(self, client):
        """Anon GET / → 401 and NO tfd_sse cookie is minted. Closes the bypass
        where an anonymous visitor minted a replayable SSE cookie."""
        r = client.get("/")
        assert r.status_code == 401
        assert r.get_json().get("error") == "Authentication required"
        set_cookie = " ".join(r.headers.get_all("Set-Cookie"))
        assert "tfd_sse" not in set_cookie

    def test_index_passes_with_valid_clerk_jwt(self, client, in_memory_db):
        """Authed GET / → 200 dashboard AND mints the signed tfd_sse cookie for
        the operator's same-origin EventSource."""
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state(
                signed_in=True, sub="user_dash_001", email="dash@doc.test"
            )
            mock_get.return_value = mock_clerk
            r = client.get("/", headers={"Authorization": "Bearer good"})
        # auth passed → handler runs (200 with HTML)
        assert r.status_code == 200
        assert b"Toca Ficha Dr." in r.data
        set_cookie = " ".join(r.headers.get_all("Set-Cookie"))
        assert "tfd_sse" in set_cookie

    def test_api_events_requires_auth(self, client, monkeypatch):
        """Gate on + anon GET /api/events → 401 from @require_sse_auth, returned
        before the (infinite) stream runs. We do NOT add @require_auth here —
        that would 401 the browser EventSource, which cannot send a Bearer."""
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        r = client.get("/api/events")
        assert r.status_code == 401
        assert r.get_json().get("code") == "AUTH_REQUIRED"

    def test_api_events_passes_with_valid_clerk_jwt(self, app, in_memory_db, monkeypatch):
        """Gate on + valid Clerk JWT bearer → @require_sse_auth passes. Asserted
        on a non-streaming probe mounted under /api/events because the real
        endpoint streams forever (registered before the first request)."""
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        from emr_automation.auth import require_sse_auth

        @app.route("/api/events/__dash_probe__")
        @require_sse_auth
        def _dash_probe():
            return "ok", 200

        c = app.test_client()
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state(
                signed_in=True, sub="user_dash_002", email="dash2@doc.test"
            )
            mock_get.return_value = mock_clerk
            r = c.get(
                "/api/events/__dash_probe__",
                headers={"Authorization": "Bearer good"},
            )
        assert r.status_code == 200


class TestOptionalAuth:

    def test_health_passes_with_no_auth(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# require_extension_or_user — gate semantics
# ---------------------------------------------------------------------------

class TestRequireExtensionOrUser:

    def test_gate_off_falls_through_with_bad_token(self, client, in_memory_db, monkeypatch):
        monkeypatch.delenv("TOCAFICHADR_AUTH_REQUIRED", raising=False)
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state(signed_in=False)
            mock_get.return_value = mock_clerk
            r = client.post("/api/transcribe", headers={"Authorization": "Bearer junk"})
            # handler-level error (no audio file), NOT auth 401
            assert r.status_code == 400

    def test_gate_on_rejects_bad_token(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state(signed_in=False)
            mock_get.return_value = mock_clerk
            r = client.post("/api/transcribe", headers={"Authorization": "Bearer junk"})
            assert r.status_code == 401
            assert r.get_json().get("code") == "AUTH_REQUIRED"

    def test_extension_api_key_path(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("EXTENSION_API_KEY", "super-secret-shared-key-123")
        monkeypatch.setenv("TOCAFICHADR_AUTH_REQUIRED", "true")
        r = client.post(
            "/api/transcribe",
            headers={"Authorization": "Bearer super-secret-shared-key-123"},
        )
        # extension key path → handler runs (400 missing audio)
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Constant-time eq
# ---------------------------------------------------------------------------

class TestConstantTimeEq:

    def test_equal_strings(self):
        assert auth_module._const_time_eq("abc", "abc") is True

    def test_different_strings(self):
        assert auth_module._const_time_eq("abc", "xyz") is False

    def test_different_lengths(self):
        assert auth_module._const_time_eq("abc", "abcd") is False
        assert auth_module._const_time_eq("", "x") is False


# ---------------------------------------------------------------------------
# Legacy /auth/* return 410 CLERK_MIGRATION
# ---------------------------------------------------------------------------

class TestLegacyAuthRoutes:

    def test_login_returns_410(self, client):
        r = client.post("/auth/login", json={"email": "x", "password": "y"})
        assert r.status_code == 410
        assert r.get_json().get("code") == "CLERK_MIGRATION"

    def test_register_returns_410(self, client):
        r = client.post("/auth/register", json={"email": "x", "password": "y"})
        assert r.status_code == 410

    def test_refresh_returns_410(self, client):
        r = client.post("/auth/refresh", json={"refresh_token": "x"})
        assert r.status_code == 410


# ---------------------------------------------------------------------------
# Bug 73 — _resolve_user_id provisioning-race + session-poisoning safety
# ---------------------------------------------------------------------------
# get_session() is a thread-local scoped_session and clerk_user_id is UNIQUE.
# Two concurrent first-requests from the SAME new user both SELECT None and both
# INSERT; the loser's commit raises IntegrityError. Pre-fix that propagated to the
# broad except, which returned None WITHOUT rolling back — leaving the scoped
# session in a PendingRollback state so the route handler's next query 500s.
# The fix catches IntegrityError (rollback + re-query → adopt the winner) and
# rolls back in the broad except too.
class TestResolveUserIdRace:
    def test_integrity_error_rolls_back_and_adopts_winner(self, monkeypatch):
        from sqlalchemy.exc import IntegrityError

        winner = MagicMock()
        winner.id = 4242
        winner.email = "race@example.com"

        sess = MagicMock()
        # Initial SELECT misses (→ insert path); after rollback, re-query finds
        # the row the concurrent winner already committed.
        sess.query.return_value.filter_by.return_value.first.side_effect = [None, winner]
        sess.commit.side_effect = IntegrityError("duplicate clerk_user_id", None, None)

        monkeypatch.setattr("emr_automation.database.get_session", lambda: sess)

        uid = auth_module._resolve_user_id("user_race_001", "race@example.com")

        assert uid == 4242, "must adopt the race winner's id, not return None"
        sess.rollback.assert_called()  # failed INSERT was rolled back (session not poisoned)

    def test_unexpected_error_rolls_back_session(self, monkeypatch):
        # Any failure must roll back so the reused thread-local session isn't left
        # poisoned for the route handler's next query.
        sess = MagicMock()
        sess.query.side_effect = RuntimeError("db boom")
        monkeypatch.setattr("emr_automation.database.get_session", lambda: sess)

        uid = auth_module._resolve_user_id("user_err_001", "a@b.com")

        assert uid is None
        sess.rollback.assert_called()
