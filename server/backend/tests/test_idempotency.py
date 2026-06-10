"""Tests for durable idempotency (PR 3B)."""
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import scoped_session, sessionmaker
from unittest.mock import patch, MagicMock

from emr_automation.database import Base, reset_engine
from emr_automation.models import User, IdempotentOperation
import emr_automation.auth as auth_module


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


def _make_user(sess, email, clerk_id):
    u = User(email=email, clerk_user_id=clerk_id)
    sess.add(u)
    sess.commit()
    return u


def _mock_clerk_auth(clerk_user_id, email="test@example.com"):
    mock_client = MagicMock()
    state = MagicMock()
    state.is_signed_in = True
    state.payload = {"sub": clerk_user_id, "email": email}
    state.reason = None
    mock_client.authenticate_request.return_value = state
    return mock_client


class TestIdempotentDecorator:
    def test_no_header_runs_normally(self, client):
        with patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock()), \
                patch("emr_automation.dashboard.routes.suggest_cid") as mock_suggest:
            mock_suggest.return_value = {"cid_code": "Z00.0", "confidence": 0.8}
            resp = client.post("/api/suggest-cid", json={"soap_text": "test", "chief_complaint": ""})

        assert resp.status_code == 200
        assert resp.get_json()["cid_code"] == "Z00.0"

    def test_duplicate_completed_returns_cached(self, client, in_memory_db):
        sess = in_memory_db()
        op_id = str(uuid.uuid4())
        u = _make_user(sess, "idem_cached@example.com", "idem_cached_001")

        record = IdempotentOperation(
            user_id=u.id,
            operation_id=op_id,
            endpoint="suggest-cid",
            status="completed",
            response_body=json.dumps({"ok": True, "cached": True}),
            completed_at=datetime.now(timezone.utc).replace(tzinfo=None),
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        )
        sess.add(record)
        sess.commit()

        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_get.return_value = _mock_clerk_auth("idem_cached_001", "idem_cached@example.com")
            resp = client.post(
                "/api/suggest-cid",
                json={"soap_text": "test", "chief_complaint": ""},
                headers={"X-Operation-Id": op_id, "Authorization": "Bearer test-jwt-token"},
            )
            assert resp.status_code == 200
            data = resp.get_json()
            assert data.get("cached") is True

    def test_in_progress_returns_409(self, client, in_memory_db):
        sess = in_memory_db()
        op_id = str(uuid.uuid4())
        u = _make_user(sess, "idem_inprog@example.com", "idem_inprog_001")

        record = IdempotentOperation(
            user_id=u.id,
            operation_id=op_id,
            endpoint="suggest-cid",
            status="in_progress",
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        )
        sess.add(record)
        sess.commit()

        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_get.return_value = _mock_clerk_auth("idem_inprog_001", "idem_inprog@example.com")
            resp = client.post(
                "/api/suggest-cid",
                json={"soap_text": "test", "chief_complaint": ""},
                headers={"X-Operation-Id": op_id, "Authorization": "Bearer test-jwt-token"},
            )
            assert resp.status_code == 409
            data = resp.get_json()
            assert "em andamento" in data.get("error", "").lower()

    def test_failed_allows_retry(self, client, in_memory_db):
        sess = in_memory_db()
        op_id = str(uuid.uuid4())
        u = _make_user(sess, "idem_fail@example.com", "idem_fail_001")

        record = IdempotentOperation(
            user_id=u.id,
            operation_id=op_id,
            endpoint="suggest-cid",
            status="failed",
            error_code="TimeoutError",
            completed_at=datetime.now(timezone.utc).replace(tzinfo=None),
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        )
        sess.add(record)
        sess.commit()

        with patch.object(auth_module, "_get_clerk_client") as mock_get:
            mock_get.return_value = _mock_clerk_auth("idem_fail_001", "idem_fail@example.com")
            resp = client.post(
                "/api/suggest-cid",
                json={"soap_text": "test", "chief_complaint": ""},
                headers={"X-Operation-Id": op_id, "Authorization": "Bearer test-jwt-token"},
            )
            # Should not return 409 (in_progress) or 200 (cached)
            assert resp.status_code not in (200, 409)
            # Old failed record should be deleted and replaced with a new one
            records = sess.query(IdempotentOperation).filter_by(operation_id=op_id).all()
            assert len(records) == 1
            assert records[0].status in ("completed", "failed")

    # CHRA-2423 Bug 39: the model-backed routes RETURN error payloads / non-2xx
    # codes instead of raising, so they reach the decorator's success path. Such
    # responses must be recorded as "failed" (retryable), NOT cached as
    # "completed" — otherwise a transient error is pinned for the 24h TTL and a
    # retry with the same X-Operation-Id can never succeed.
    def test_error_payload_200_recorded_failed_not_completed(self, client, in_memory_db):
        sess = in_memory_db()
        op_id = str(uuid.uuid4())
        _make_user(sess, "idem_errpayload@example.com", "idem_errpayload_001")
        with patch.object(auth_module, "_get_clerk_client") as mock_get, \
                patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock()), \
                patch("emr_automation.dashboard.routes.suggest_cid",
                      return_value={"error": "transient provider failure"}):
            mock_get.return_value = _mock_clerk_auth("idem_errpayload_001", "idem_errpayload@example.com")
            client.post(
                "/api/suggest-cid",
                json={"soap_text": "paciente com febre", "chief_complaint": ""},
                headers={"X-Operation-Id": op_id, "Authorization": "Bearer test-jwt-token"},
            )
        rec = sess.query(IdempotentOperation).filter_by(operation_id=op_id).one()
        assert rec.status == "failed", "a 200-with-error payload must not be cached as completed"

    def test_non_2xx_response_recorded_failed_not_completed(self, client, in_memory_db):
        sess = in_memory_db()
        op_id = str(uuid.uuid4())
        _make_user(sess, "idem_4xx@example.com", "idem_4xx_001")
        with patch.object(auth_module, "_get_clerk_client") as mock_get, \
                patch("emr_automation.dashboard.routes._get_openai_client", return_value=MagicMock()):
            mock_get.return_value = _mock_clerk_auth("idem_4xx_001", "idem_4xx@example.com")
            resp = client.post(
                "/api/suggest-cid",
                json={"chief_complaint": ""},  # missing soap_text (the billable guard may 4xx/429 first)
                headers={"X-Operation-Id": op_id, "Authorization": "Bearer test-jwt-token"},
            )
        # Whatever non-2xx fires (guard 429 or the 400 validation), it must not be cached.
        assert resp.status_code >= 400
        rec = sess.query(IdempotentOperation).filter_by(operation_id=op_id).one()
        assert rec.status == "failed", "a non-2xx response must not be cached as completed"


class TestIdempotencyUniqueConstraint:
    """CHRA-2423 Bug 69 — the (user_id, operation_id) UNIQUE constraint that the
    model docstring promises ("prevent duplicate provider billing") was documented
    but never declared. Without it, two concurrent requests with the same
    X-Operation-Id both SELECT None, both INSERT an in_progress row, and both run
    the billable provider call — defeating idempotency. These tests prove the
    constraint now exists (fails pre-fix) and that a same-key conflict is rejected
    at the DB level so the decorator's IntegrityError guard can catch the race."""

    def test_duplicate_user_op_insert_is_rejected(self, in_memory_db):
        from sqlalchemy.exc import IntegrityError

        sess = in_memory_db()
        op_id = str(uuid.uuid4())
        u = _make_user(sess, "idem_uq@example.com", "idem_uq_001")

        sess.add(IdempotentOperation(
            user_id=u.id, operation_id=op_id, endpoint="transcribe", status="in_progress",
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        ))
        sess.commit()

        # Second insert with the SAME (user_id, operation_id) must violate the
        # unique constraint. Pre-fix this committed cleanly and the row count was 2.
        sess.add(IdempotentOperation(
            user_id=u.id, operation_id=op_id, endpoint="transcribe", status="in_progress",
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        ))
        with pytest.raises(IntegrityError):
            sess.commit()
        sess.rollback()

        rows = sess.query(IdempotentOperation).filter_by(user_id=u.id, operation_id=op_id).all()
        assert len(rows) == 1, "the unique constraint must keep exactly one row per (user, op)"

    def test_same_op_id_different_users_is_allowed(self, in_memory_db):
        # The constraint is scoped to (user_id, operation_id): two different users
        # may legitimately generate the same UUID, and that must not collide.
        sess = in_memory_db()
        op_id = str(uuid.uuid4())
        u1 = _make_user(sess, "idem_uqA@example.com", "idem_uqA_001")
        u2 = _make_user(sess, "idem_uqB@example.com", "idem_uqB_001")
        sess.add(IdempotentOperation(
            user_id=u1.id, operation_id=op_id, endpoint="transcribe", status="in_progress",
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        ))
        sess.add(IdempotentOperation(
            user_id=u2.id, operation_id=op_id, endpoint="transcribe", status="in_progress",
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        ))
        sess.commit()  # must NOT raise
        assert sess.query(IdempotentOperation).filter_by(operation_id=op_id).count() == 2
