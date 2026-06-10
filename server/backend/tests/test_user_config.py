"""Tests for the per-user clinical config endpoints (phase 003 plan 03-01).

Covers:
- /api/me/config GET/PATCH require Clerk auth (401 without)
- GET lazy-seeds DEFAULT_RX_TEMPLATES on first call for a new user
- GET is idempotent (no duplicate row on second call)
- PATCH partial-update doesn't clobber unrelated fields
- PATCH validates list types for rx_templates / voices
- PATCH applies length caps for custom_instructions and doctor_name
"""
from unittest.mock import patch, MagicMock
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session

from emr_automation.database import Base, reset_engine
from emr_automation.models import User, UserConfig
from emr_automation import auth as auth_module
from emr_automation.constants import DEFAULT_RX_TEMPLATES


# ---------------------------------------------------------------------------
# Fixtures (mirror test_auth.py / test_routes_clerk.py)
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


def _authed(client, method, path, sub="user_test_001", email="doc@test.local", json=None):
    """Helper: mock Clerk + call client method with Authorization header."""
    with patch.object(auth_module, "_get_clerk_client") as mock_get:
        mock_clerk = MagicMock()
        mock_clerk.authenticate_request.return_value = _mock_clerk_state(
            signed_in=True, sub=sub, email=email
        )
        mock_get.return_value = mock_clerk
        fn = getattr(client, method)
        kwargs = {"headers": {"Authorization": "Bearer good"}}
        if json is not None:
            kwargs["json"] = json
        return fn(path, **kwargs)


# ---------------------------------------------------------------------------
# Auth gating
# ---------------------------------------------------------------------------

class TestAuthRequired:

    def test_get_returns_401_without_bearer(self, client, in_memory_db):
        r = client.get("/api/me/config")
        assert r.status_code == 401
        assert r.get_json().get("error") == "Authentication required"

    def test_patch_returns_401_without_bearer(self, client, in_memory_db):
        r = client.patch("/api/me/config", json={"doctor_name": "X"})
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# GET — lazy seed + idempotency
# ---------------------------------------------------------------------------

class TestGetSeedsAndIsIdempotent:

    def test_get_seeds_defaults_for_new_user(self, client, in_memory_db):
        r = _authed(client, "get", "/api/me/config", sub="user_seed_001")
        assert r.status_code == 200, r.get_data(as_text=True)
        body = r.get_json()
        assert isinstance(body["rx_templates"], list)
        assert len(body["rx_templates"]) == len(DEFAULT_RX_TEMPLATES)
        diagnoses = [t["diagnosis"] for t in body["rx_templates"]]
        assert diagnoses == [
            "Paracetamol",
            "Ibuprofeno",
            "Amoxicilina",
            "Dor de Garganta",
        ]
        assert body["rx_templates"][0]["meds"] == [
            {"medId": "paracetamol", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
            {"medId": "paracetamol_adult", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
        ]
        assert body["rx_templates"][3]["meds"] == [
            {"medId": "amox_pneum", "dose": "", "freq": "", "duration": "7 dias", "when": "", "notes": ""},
            {"medId": "paracetamol", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
            # Bug 71: was the non-existent catalog id "desloratadine"; corrected to
            # "desloratadine_adult" (the entry the catalog actually serves).
            {"medId": "desloratadine_adult", "dose": "", "freq": "", "duration": "", "when": "", "notes": ""},
            {"medId": "ibuprofen", "dose": "", "freq": "", "duration": "", "when": "se dor ou febre", "notes": ""},
        ]
        # Other defaults
        assert body["voices"] == []
        assert body["active_voice_id"] == "voice_padrao"
        assert body["custom_instructions"] == ""
        assert body["doctor_name"] == ""
        assert body["auto_cid"] is True
        assert body["auto_clear_soap"] is True
        assert body["auto_fill_companion"] is True
        assert body["auto_prefill_encaminh"] is True
        assert body["auto_transcribe_on_dictation"] is False

        # One row in DB
        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_seed_001").first()
        assert u is not None
        cfg = sess.query(UserConfig).filter_by(user_id=u.id).first()
        assert cfg is not None

    def test_get_is_idempotent(self, client, in_memory_db):
        r1 = _authed(client, "get", "/api/me/config", sub="user_idem_002")
        r2 = _authed(client, "get", "/api/me/config", sub="user_idem_002")
        assert r1.status_code == r2.status_code == 200
        assert r1.get_json()["rx_templates"] == r2.get_json()["rx_templates"]

        sess = in_memory_db()
        u = sess.query(User).filter_by(clerk_user_id="user_idem_002").first()
        # Exactly one config row
        count = sess.query(UserConfig).filter_by(user_id=u.id).count()
        assert count == 1


# ---------------------------------------------------------------------------
# PATCH — partial update + validation + caps
# ---------------------------------------------------------------------------

class TestPatchUpdates:

    def test_patch_replaces_rx_templates(self, client, in_memory_db):
        new_templates = [
            {"id": "tpl_a", "diagnosis": "Custom", "ageBand": "adulto",
             "body": "Test prescription", "frequency": 0},
        ]
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_patch_001", json={"rx_templates": new_templates})
        assert r.status_code == 200, r.get_data(as_text=True)
        assert r.get_json()["rx_templates"] == new_templates

        # GET reflects the change
        r2 = _authed(client, "get", "/api/me/config", sub="user_patch_001")
        assert r2.get_json()["rx_templates"] == new_templates

    def test_patch_partial_does_not_clobber_other_fields(self, client, in_memory_db):
        # Seed row by GET
        _authed(client, "get", "/api/me/config", sub="user_partial_001")
        # Patch only custom_instructions
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_partial_001",
                    json={"custom_instructions": "Sempre incluir alergias."})
        assert r.status_code == 200
        body = r.get_json()
        # rx_templates still has the 4 defaults
        assert len(body["rx_templates"]) == len(DEFAULT_RX_TEMPLATES)
        assert body["custom_instructions"] == "Sempre incluir alergias."
        # Toggles unchanged
        assert body["auto_cid"] is True

    def test_patch_updates_doctor_name_and_toggles(self, client, in_memory_db):
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_toggles_001",
                    json={"doctor_name": "Dr. Christian", "auto_cid": False,
                          "auto_fill_companion": False,
                          "auto_prefill_encaminh": False,
                          "auto_transcribe_on_dictation": True})
        assert r.status_code == 200
        body = r.get_json()
        assert body["doctor_name"] == "Dr. Christian"
        assert body["auto_cid"] is False
        assert body["auto_clear_soap"] is True  # untouched
        assert body["auto_fill_companion"] is False
        assert body["auto_prefill_encaminh"] is False
        assert body["auto_transcribe_on_dictation"] is True

    def test_patch_updates_voices_and_active_voice_id(self, client, in_memory_db):
        new_voices = [
            {"id": "voice_personal_1", "name": "Meu jeito", "verbosity": "medio",
             "perspective": "primeira-pessoa", "emphases": [],
             "customRules": "Sempre incluir alergias.", "fewShots": []},
        ]
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_voices_001",
                    json={"voices": new_voices, "active_voice_id": "voice_personal_1"})
        assert r.status_code == 200
        body = r.get_json()
        assert body["voices"] == new_voices
        assert body["active_voice_id"] == "voice_personal_1"


class TestPatchValidation:

    def test_patch_rejects_non_array_rx_templates(self, client, in_memory_db):
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_bad_001",
                    json={"rx_templates": "not an array"})
        assert r.status_code == 400
        assert "rx_templates" in r.get_json().get("error", "")

    def test_patch_rejects_non_array_voices(self, client, in_memory_db):
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_bad_002",
                    json={"voices": {"not": "a list"}})
        assert r.status_code == 400
        assert "voices" in r.get_json().get("error", "")

    def test_patch_rejects_non_object_body(self, client, in_memory_db):
        # Send a JSON array instead of an object
        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_clerk = MagicMock()
            mock_clerk.authenticate_request.return_value = _mock_clerk_state(
                signed_in=True, sub="user_bad_003"
            )
            mock_get.return_value = mock_clerk
            r = client.patch(
                "/api/me/config",
                headers={"Authorization": "Bearer good"},
                json=["not", "a", "dict"],
            )
        assert r.status_code == 400


class TestPatchCaps:

    def test_patch_applies_string_length_cap(self, client, in_memory_db):
        long_text = "A" * 6000
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_cap_001",
                    json={"custom_instructions": long_text})
        assert r.status_code == 200
        # Capped at 5000
        assert len(r.get_json()["custom_instructions"]) == 5000

    def test_patch_caps_doctor_name_at_255(self, client, in_memory_db):
        r = _authed(client, "patch", "/api/me/config",
                    sub="user_cap_002",
                    json={"doctor_name": "X" * 300})
        assert r.status_code == 200
        assert len(r.get_json()["doctor_name"]) == 255


# ---------------------------------------------------------------------------
# Bug 75 (Bug 73/74 family) — _get_or_seed_user_config provisioning-race safety
# ---------------------------------------------------------------------------
# /api/me/config GET+PATCH both seed via SELECT-then-INSERT on UserConfig.user_id
# (the PRIMARY KEY). The extension fires the userConfig hydrate concurrently on
# sign-in, so two first-requests for the same new user both SELECT None and both
# INSERT; the loser's commit raises IntegrityError. It must be caught (rollback +
# adopt the winner), not propagated — propagation 500s /api/me/config AND poisons
# the thread-local scoped session.
class TestUserConfigSeedRace:
    def test_integrity_error_rolls_back_and_adopts_winner(self):
        from sqlalchemy.exc import IntegrityError
        from emr_automation.dashboard import routes

        winner = MagicMock()
        sess = MagicMock()
        # Initial SELECT misses (→ seed path); re-query after rollback finds the
        # row the concurrent winner already committed.
        sess.query.return_value.filter_by.return_value.first.side_effect = [None, winner]
        sess.commit.side_effect = IntegrityError("duplicate user_id PK", None, None)

        cfg = routes._get_or_seed_user_config(sess, user_id=7)

        assert cfg is winner, "must adopt the race winner's config row, not raise"
        sess.rollback.assert_called()  # failed INSERT rolled back — session not poisoned
