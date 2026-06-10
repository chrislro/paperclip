"""Tests for the v3.0.4 Clerk webhook routes (emr_automation/dashboard/routes_clerk.py)."""
from unittest.mock import patch, MagicMock
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session

from emr_automation.database import Base, reset_engine
from emr_automation.models import User, Subscription, UsageLog, WebhookEvent
from emr_automation import auth as auth_module


@pytest.fixture
def in_memory_db(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionFactory = scoped_session(sessionmaker(bind=engine))
    monkeypatch.setattr("emr_automation.database.get_session", lambda: SessionFactory())
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


def _user_event(event_type, **overrides):
    """Build a minimal Clerk webhook event payload.

    The top-level ``id`` is the Svix message ID (used for webhook idempotency).
    ``data["id"]`` is the Clerk user ID. For test simplicity both default to the
    same value, but callers can override either via ``id=...`` (affects both) or
    ``svix_id=...`` (top-level only).
    """
    data = {
        "id": "user_webhook_001",
        "primary_email_address_id": "idn_001",
        "email_addresses": [{"id": "idn_001", "email_address": "webhook@test.local"}],
        "first_name": "Webhook",
        "last_name": "Tester",
    }
    # Determine the Svix message ID (top-level "id")
    event_id = overrides.pop("svix_id", overrides.get("id", data["id"]))
    data.update(overrides)
    return {"type": event_type, "id": event_id, "data": data}


# ---------------------------------------------------------------------------

class TestWebhookSignatureRequired:

    def test_no_signature_returns_401(self, client):
        r = client.post("/clerk/webhook", json={})
        assert r.status_code == 401
        assert "Invalid signature" in r.get_json().get("error", "")

    def test_unconfigured_secret_returns_401(self, client, monkeypatch):
        monkeypatch.delenv("CLERK_WEBHOOK_SECRET", raising=False)
        r = client.post(
            "/clerk/webhook",
            json={"type": "user.created"},
            headers={"svix-signature": "v1,xxx"},
        )
        assert r.status_code == 401


class TestUserCreatedHandler:

    def test_lazy_provisions_via_webhook(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = _user_event("user.created", id="user_wh_new_001",
                                                      email_addresses=[{"id": "idn_001", "email_address": "fresh@test"}],
                                                      primary_email_address_id="idn_001")
            MockWebhook.return_value = instance
            r = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r.status_code == 200
            sess = in_memory_db()
            u = sess.query(User).filter_by(clerk_user_id="user_wh_new_001").first()
            assert u is not None
            assert u.email == "fresh@test"

    def test_idempotent_on_duplicate_event(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = _user_event("user.created", id="user_wh_dup_001")
            MockWebhook.return_value = instance
            client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            sess = in_memory_db()
            count = sess.query(User).filter_by(clerk_user_id="user_wh_dup_001").count()
            assert count == 1


class TestUserDeletedHandler:

    def test_deletes_user_and_clears_fks(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")

        # Pre-populate: a User with a Subscription + UsageLog
        sess = in_memory_db()
        user = User(clerk_user_id="user_to_delete", email="delete@test", plan="free", password_hash="")
        sess.add(user)
        sess.commit()
        sub = Subscription(user_id=user.id, plan="pro", status="active")
        log = UsageLog(user_id=user.id, action="transcribe")
        sess.add_all([sub, log])
        sess.commit()
        user_id = user.id

        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = _user_event("user.deleted", id="user_to_delete")
            MockWebhook.return_value = instance
            r = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r.status_code == 200

        sess = in_memory_db()
        assert sess.query(User).filter_by(clerk_user_id="user_to_delete").first() is None
        assert sess.query(Subscription).filter_by(user_id=user_id).count() == 0
        assert sess.query(UsageLog).filter_by(user_id=user_id).count() == 0


class TestWebhookIdempotency:
    """CHRA-1870: Atomic idempotency guard with UNIQUE constraint + TOCTOU protection."""

    def test_duplicate_clerk_event_returns_idempotent(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = _user_event("user.created", id="user_wh_idem_001")
            MockWebhook.return_value = instance

            # First delivery
            r1 = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r1.status_code == 200
            assert r1.get_json().get("idempotent") is None
            sess = in_memory_db()
            count = sess.query(User).filter_by(clerk_user_id="user_wh_idem_001").count()
            assert count == 1

            # Second delivery — should be idempotent
            r2 = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r2.status_code == 200
            assert r2.get_json().get("idempotent") is True
            count = sess.query(User).filter_by(clerk_user_id="user_wh_idem_001").count()
            assert count == 1  # Still only one user

            # Exactly one webhook event row
            events = sess.query(WebhookEvent).filter_by(external_event_id="user_wh_idem_001").all()
            assert len(events) == 1
            assert events[0].status == "processed"

    def test_concurrent_clerk_event_returns_concurrent(self, client, in_memory_db, monkeypatch):
        from emr_automation.webhooks import _acquire_webhook_lock
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        sess = in_memory_db()

        # Simulate another worker already holding the lock
        _acquire_webhook_lock(
            sess,
            "user_wh_concurrent_002",
            "clerk",
            "user.created",
            {"id": "user_wh_concurrent_002"},
        )

        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = _user_event("user.created", id="user_wh_concurrent_002")
            MockWebhook.return_value = instance
            r = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r.status_code == 200
            assert r.get_json().get("concurrent") is True
            count = sess.query(User).filter_by(clerk_user_id="user_wh_concurrent_002").count()
            assert count == 0  # Business logic never ran


class TestWebhookEventLogging:

    def test_user_created_logs_webhook_event(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = _user_event("user.created", id="user_wh_log_001")
            MockWebhook.return_value = instance
            r = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r.status_code == 200
            sess = in_memory_db()
            events = sess.query(WebhookEvent).filter_by(source="clerk", event_type="user.created").all()
            assert len(events) == 1
            assert events[0].status == "processed"
            assert events[0].http_status == 200

    def test_ignored_event_logs_webhook_event(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        # Ensure webhooks module uses the same in-memory DB
        monkeypatch.setattr("emr_automation.database.get_session", lambda: in_memory_db())
        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = {"type": "session.created", "data": {}}
            MockWebhook.return_value = instance
            r = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r.status_code == 200
            sess = in_memory_db()
            events = sess.query(WebhookEvent).filter_by(source="clerk", event_type="session.created").all()
            assert len(events) == 1
            assert events[0].status == "ignored"
            assert events[0].http_status == 200


class TestFailedEventRetry:
    """CHRA-1871: Failed webhook events are re-processed on provider retry."""

    def test_failed_event_is_retried(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")

        # Pre-populate a user so user.updated has something to update
        sess = in_memory_db()
        user = User(clerk_user_id="user_retry_001", email="retry@test", plan="free", password_hash="")
        sess.add(user)
        sess.commit()

        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = {
                "type": "user.updated",
                "id": "evt_retry_clerk_001",
                "data": {
                    "id": "user_retry_001",
                    "primary_email_address_id": "idn_001",
                    "email_addresses": [{"id": "idn_001", "email_address": "retry@test"}],
                    "first_name": "Retry",
                    "last_name": "Test",
                },
            }
            MockWebhook.return_value = instance

            with patch("emr_automation.dashboard.routes_clerk._handle_user_updated") as mock_handler:
                # First delivery: handler crashes
                mock_handler.side_effect = RuntimeError("simulated handler crash")
                r1 = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
                assert r1.status_code == 500

                # Retry: same payload should re-process and crash again
                r2 = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
                assert r2.status_code == 500

        sess = in_memory_db()
        events = sess.query(WebhookEvent).filter_by(external_event_id="evt_retry_clerk_001").all()
        assert len(events) == 1
        assert events[0].status == "failed"

    def test_failed_event_retry_succeeds(self, client, in_memory_db, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")

        # Pre-populate a user
        sess = in_memory_db()
        user = User(clerk_user_id="user_retry_002", email="retry2@test", plan="free", password_hash="")
        sess.add(user)
        sess.commit()

        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = {
                "type": "user.updated",
                "id": "evt_retry_clerk_002",
                "data": {
                    "id": "user_retry_002",
                    "primary_email_address_id": "idn_002",
                    "email_addresses": [{"id": "idn_002", "email_address": "retry2@test"}],
                    "first_name": "Retry",
                    "last_name": "Test",
                },
            }
            MockWebhook.return_value = instance

            with patch("emr_automation.dashboard.routes_clerk._handle_user_updated") as mock_handler:
                # First delivery: handler crashes
                mock_handler.side_effect = RuntimeError("simulated handler crash")
                r1 = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
                assert r1.status_code == 500

                # Retry: handler now succeeds (transient issue resolved)
                mock_handler.side_effect = None
                mock_handler.return_value = True
                r2 = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
                assert r2.status_code == 200
                assert r2.get_json().get("type") == "user.updated"

        sess = in_memory_db()
        events = sess.query(WebhookEvent).filter_by(external_event_id="evt_retry_clerk_002").all()
        assert len(events) == 1
        assert events[0].status == "processed"

    def test_concurrent_retry_claim_race(self, client, in_memory_db, monkeypatch):
        """Only one worker should win the race to retry a failed event."""
        from emr_automation.webhooks import _acquire_webhook_lock
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        sess = in_memory_db()

        # Create a failed event row
        _acquire_webhook_lock(
            sess,
            "evt_retry_race_003",
            "clerk",
            "user.created",
            {"id": "evt_retry_race_003"},
        )
        failed = sess.query(WebhookEvent).filter_by(external_event_id="evt_retry_race_003").first()
        failed.status = "failed"
        sess.commit()

        # Worker A claims the retry via atomic UPDATE failed → processing
        record_a, is_new_a = _acquire_webhook_lock(
            sess, "evt_retry_race_003", "clerk", "user.created", {"id": "evt_retry_race_003"}
        )
        assert is_new_a is True
        assert record_a.status == "processing"

        # Worker B tries to claim the same retry — should lose because status
        # is now "processing", not "failed"
        record_b, is_new_b = _acquire_webhook_lock(
            sess, "evt_retry_race_003", "clerk", "user.created", {"id": "evt_retry_race_003"}
        )
        assert is_new_b is False
        assert record_b.status == "processing"  # Worker A already claimed it


class TestIgnoredEvents:

    def test_session_created_returns_200(self, client, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "whsec_test")
        with patch("svix.webhooks.Webhook") as MockWebhook:
            instance = MagicMock()
            instance.verify.return_value = {"type": "session.created", "data": {}}
            MockWebhook.return_value = instance
            r = client.post("/clerk/webhook", json={}, headers={"svix-signature": "fake"})
            assert r.status_code == 200
            assert r.get_json().get("type") == "session.created"


# ---------------------------------------------------------------------------
# Bug 74 (Bug 73 sibling) — _handle_user_created provisioning-race safety
# ---------------------------------------------------------------------------
# Clerk webhooks are at-least-once (Svix redelivers); a user.created can also race
# auth.py's lazy-provisioning. Both do SELECT-then-INSERT on the UNIQUE clerk_user_id.
# The loser's commit raises IntegrityError — which must be caught (rollback + adopt
# the winner), not propagated (which would 500 the webhook AND poison the thread-local
# scoped session for any later query in the request).
class TestUserCreatedProvisioningRace:
    def test_integrity_error_rolls_back_and_adopts_winner(self, monkeypatch):
        from sqlalchemy.exc import IntegrityError
        from emr_automation.dashboard import routes_clerk

        winner = MagicMock()
        winner.id = 99
        winner.email = "w@x.com"
        winner.name = "W X"

        sess = MagicMock()
        # Initial SELECT misses (→ insert path); re-query after rollback finds the
        # row the concurrent winner already committed.
        sess.query.return_value.filter_by.return_value.first.side_effect = [None, winner]
        sess.commit.side_effect = IntegrityError("duplicate clerk_user_id", None, None)
        monkeypatch.setattr("emr_automation.database.get_session", lambda: sess)

        event = {
            "id": "user_race_clerk_001",
            "email_addresses": [{"id": "e1", "email_address": "w@x.com"}],
            "primary_email_address_id": "e1",
            "first_name": "W", "last_name": "X",
        }
        ok = routes_clerk._handle_user_created(event)

        assert ok is True, "race must resolve to success (winner created the row)"
        sess.rollback.assert_called()  # failed INSERT rolled back — session not poisoned
