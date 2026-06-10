import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from emr_automation.database import Base
from emr_automation.models import User, UsageLog, Subscription
from emr_automation.billing import check_usage_limit, log_usage, get_subscription, FREE_DAILY_LIMIT, BILLABLE_ACTIONS


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def free_user(db_session):
    user = User(email="free@test.com", plan="free")
    user.set_password("pw")
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def pro_user(db_session):
    user = User(email="pro@test.com", plan="pro")
    user.set_password("pw")
    db_session.add(user)
    db_session.commit()
    return user


@pytest.fixture
def trial_user(db_session):
    user = User(
        email="trial@test.com",
        plan="free",
        trial_ends_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=10),
    )
    user.set_password("pw")
    db_session.add(user)
    db_session.commit()
    return user


class TestUsageLimit:
    @patch("emr_automation.billing.get_session")
    def test_pro_user_unlimited(self, mock_get_session, db_session, pro_user):
        mock_get_session.return_value = db_session
        assert check_usage_limit(pro_user.id) is True

    @patch("emr_automation.billing.get_session")
    def test_trial_user_unlimited(self, mock_get_session, db_session, trial_user):
        mock_get_session.return_value = db_session
        assert check_usage_limit(trial_user.id) is True

    @patch("emr_automation.billing.get_session")
    def test_free_user_within_limit(self, mock_get_session, db_session, free_user):
        mock_get_session.return_value = db_session
        assert check_usage_limit(free_user.id) is True

    @patch("emr_automation.billing.get_session")
    def test_free_user_exceeds_limit(self, mock_get_session, db_session, free_user):
        mock_get_session.return_value = db_session
        for _ in range(FREE_DAILY_LIMIT):
            db_session.add(UsageLog(user_id=free_user.id, action="transcribe"))
        db_session.commit()

        assert check_usage_limit(free_user.id) is False


class TestLogUsage:
    @patch("emr_automation.billing.get_session")
    def test_log_creates_entry(self, mock_get_session, db_session, free_user):
        mock_get_session.return_value = db_session
        log_usage(free_user.id, "transcribe", "ghosp")
        count = db_session.query(UsageLog).filter_by(user_id=free_user.id).count()
        assert count == 1


class TestSoapStreamNotDoubleBilled:
    """CHRA-2423 Bug 38: one side-panel recording records as Phase A
    (/api/transcribe?skip_soap=1 → billed "transcribe") + Phase B
    (/api/soap-stream → "soap_stream"). soap_stream is never a standalone action,
    so counting it double-charged a side-panel recording (2 uses) vs the popup's
    inline path (1 use) for the IDENTICAL operation. It must not count toward the
    daily limit."""

    def test_soap_stream_excluded_from_billable_actions(self):
        assert "transcribe" in BILLABLE_ACTIONS          # Phase A — the recording IS billed
        assert "soap_stream" not in BILLABLE_ACTIONS      # Phase B — not a second charge

    @patch("emr_automation.billing.get_session")
    def test_soap_stream_logs_do_not_count_toward_limit(self, mock_get_session, db_session, free_user):
        mock_get_session.return_value = db_session
        # 4 full recordings, each = 1 transcribe (Phase A) + 1 soap_stream (Phase B).
        for _ in range(FREE_DAILY_LIMIT - 1):
            db_session.add(UsageLog(user_id=free_user.id, action="transcribe"))
            db_session.add(UsageLog(user_id=free_user.id, action="soap_stream"))
        db_session.commit()
        # 4 transcribe < 5 → allowed. Pre-fix, the 4 soap_stream ALSO counted
        # (8 events ≥ 5) and wrongly blocked the doctor after ~2.5 recordings.
        assert check_usage_limit(free_user.id) is True


class TestGetSubscription:
    @patch("emr_automation.billing.get_session")
    def test_get_subscription_free_user(self, mock_get_session, db_session, free_user):
        mock_get_session.return_value = db_session
        result = get_subscription(free_user.id)
        assert result["plan"] == "free"
        assert result["usage_today"] == 0
        assert result["daily_limit"] == FREE_DAILY_LIMIT


class TestPortalSession:
    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_create_portal_session_success(self, mock_get_session, mock_get_stripe, db_session, free_user):
        from emr_automation.billing import create_portal_session

        mock_get_session.return_value = db_session
        # Set up stripe customer id
        free_user.stripe_customer_id = "cus_test_123"
        db_session.commit()

        mock_stripe = MagicMock()
        mock_portal = MagicMock()
        mock_portal.url = "https://billing.stripe.com/session/test_portal_123"
        mock_stripe.billing_portal.Session.create.return_value = mock_portal
        mock_get_stripe.return_value = mock_stripe

        result = create_portal_session(free_user.id, "https://tocafichadr.com.br/")

        assert "error" not in result
        assert result["url"] == "https://billing.stripe.com/session/test_portal_123"
        mock_stripe.billing_portal.Session.create.assert_called_once_with(
            customer="cus_test_123",
            return_url="https://tocafichadr.com.br/",
        )

    @patch("emr_automation.billing.get_session")
    def test_create_portal_session_no_customer(self, mock_get_session, db_session, free_user):
        from emr_automation.billing import create_portal_session

        mock_get_session.return_value = db_session
        result = create_portal_session(free_user.id, "https://tocafichadr.com.br/")

        assert "error" in result
        assert "No Stripe customer record found" in result["error"]

    @patch("emr_automation.billing.get_session")
    def test_create_portal_session_user_not_found(self, mock_get_session, db_session):
        from emr_automation.billing import create_portal_session

        mock_get_session.return_value = db_session
        result = create_portal_session(99999, "https://tocafichadr.com.br/")

        assert "error" in result
        assert "User not found" in result["error"]


class TestWebhookIdempotency:
    """CHRA-1870: Atomic idempotency guard with UNIQUE constraint + TOCTOU protection."""

    @pytest.fixture(autouse=True)
    def _webhook_secret(self, monkeypatch):
        # Bug 40 fail-closed guard rejects an empty signing secret. These tests
        # mock construct_event, so provide an opaque non-empty secret to exercise
        # the processing path (the dedicated empty-secret test lives below).
        monkeypatch.setattr("emr_automation.billing.keychain_secret", lambda name: "whsec_test")

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_duplicate_event_returns_idempotent(self, mock_get_session, mock_get_stripe, db_session, free_user):
        from emr_automation.billing import handle_webhook
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_dup_123",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "metadata": {"user_id": str(free_user.id), "plan": "pro"},
                    "customer": "cus_test",
                    "subscription": "sub_test",
                }
            },
        }
        mock_get_stripe.return_value = mock_stripe

        def _unwrap(result):
            if isinstance(result, tuple):
                return result[0], result[1]
            return result, 200

        # First delivery — should process
        result1, status1 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status1 == 200
        assert result1 == {"status": "ok"}
        subs = db_session.query(Subscription).filter_by(user_id=free_user.id).count()
        assert subs == 1

        # Second delivery — should be idempotent
        result2, status2 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status2 == 200
        assert result2 == {"status": "ok", "idempotent": True}
        subs = db_session.query(Subscription).filter_by(user_id=free_user.id).count()
        assert subs == 1  # No duplicate subscription

        # Exactly one webhook event row
        events = db_session.query(WebhookEvent).filter_by(external_event_id="evt_dup_123").all()
        assert len(events) == 1
        assert events[0].status == "processed"

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_concurrent_processing_returns_concurrent(self, mock_get_session, mock_get_stripe, db_session, free_user):
        from emr_automation.billing import handle_webhook, _acquire_webhook_lock
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_concurrent_456",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "metadata": {"user_id": str(free_user.id), "plan": "pro"},
                    "customer": "cus_test",
                    "subscription": "sub_test",
                }
            },
        }
        mock_get_stripe.return_value = mock_stripe

        def _unwrap(result):
            if isinstance(result, tuple):
                return result[0], result[1]
            return result, 200

        # Simulate another worker already holding the lock
        _acquire_webhook_lock(
            db_session,
            "evt_concurrent_456",
            "stripe",
            "checkout.session.completed",
            {"id": "evt_concurrent_456"},
        )

        # Our worker should see the lock and return concurrent
        result, status = _unwrap(handle_webhook(b'{}', "sig"))
        assert status == 200
        assert result == {"status": "ok", "concurrent": True}
        subs = db_session.query(Subscription).filter_by(user_id=free_user.id).count()
        assert subs == 0  # Business logic never ran

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_invalid_metadata_event_is_ignored_not_retried(self, mock_get_session, mock_get_stripe, db_session, free_user):
        # CHRA-2423 Bug 57: invalid/missing metadata in checkout.session.completed
        # previously raised KeyError/ValueError → HTTP 500 → Stripe retry →
        # CHRA-1871 failed→processing conversion → infinite retry loop.
        # Fixed: unprocessable metadata → status="ignored" + HTTP 200 so Stripe stops.
        from emr_automation.billing import handle_webhook
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_fail_retry_789",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "metadata": {"user_id": "not_an_int"},  # malformed — no plan either
                    "customer": "cus_test",
                    "subscription": "sub_test",
                }
            },
        }
        mock_get_stripe.return_value = mock_stripe

        def _unwrap(result):
            if isinstance(result, tuple):
                return result[0], result[1]
            return result, 200

        # First delivery — unprocessable metadata → ignored (200, not 500)
        result1, status1 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status1 == 200
        assert result1.get("ignored") is True

        # Retry — event is already "ignored" → idempotent 200
        result2, status2 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status2 == 200

        events = db_session.query(WebhookEvent).filter_by(external_event_id="evt_fail_retry_789").all()
        assert len(events) == 1
        assert events[0].status == "ignored"


class TestWebhookFailClosedOnMissingSecret:
    """CHRA-2423 Bug 40: a missing/empty Stripe webhook secret must FAIL CLOSED.

    construct_event() with an empty key verifies HMACs against an empty key —
    which an attacker can compute — so a forged checkout.session.completed could
    grant free Pro. The handler must reject (500) and never parse the event.
    """

    @patch("emr_automation.billing._get_stripe")
    def test_empty_secret_rejects_without_processing(self, mock_get_stripe, monkeypatch):
        from emr_automation.billing import handle_webhook
        monkeypatch.setattr("emr_automation.billing.keychain_secret", lambda name: "")
        monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
        mock_stripe = MagicMock()
        mock_get_stripe.return_value = mock_stripe

        result, status = handle_webhook(
            b'{"id":"evt_forged","type":"checkout.session.completed"}',
            "t=1,v1=deadbeef",
        )
        assert status == 500
        assert "secret" in str(result.get("error", "")).lower()
        # CRITICAL: the forged event must never be parsed/processed.
        mock_stripe.Webhook.construct_event.assert_not_called()


class TestWebhookLogging:
    @pytest.fixture(autouse=True)
    def _webhook_secret(self, monkeypatch):
        monkeypatch.setattr("emr_automation.billing.keychain_secret", lambda name: "whsec_test")

    @patch("emr_automation.database.get_session")
    def test_log_webhook_event_stores_scrubbed_payload(self, mock_get_session, db_session):
        from emr_automation.webhooks import _log_webhook_event
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        payload = {
            "id": "evt_test_123",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test_123",
                    "email": "doctor@example.com",
                    "name": "Dr. Test",
                }
            },
        }
        _log_webhook_event("stripe", "checkout.session.completed", payload, status="processed", http_status=200)

        event = db_session.query(WebhookEvent).first()
        assert event is not None
        assert event.source == "stripe"
        assert event.event_type == "checkout.session.completed"
        assert event.status == "processed"
        assert event.http_status == 200
        # PII should be scrubbed
        assert event.payload["data"]["object"]["email"] == "[REDACTED]"
        assert event.payload["data"]["object"]["name"] == "[REDACTED]"
        # Non-PII should be preserved
        assert event.payload["id"] == "evt_test_123"
        assert event.payload["data"]["object"]["id"] == "cs_test_123"

    @patch("emr_automation.database.get_session")
    def test_log_webhook_event_failed_status(self, mock_get_session, db_session):
        from emr_automation.webhooks import _log_webhook_event
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        payload = {"id": "evt_fail_123", "type": "invoice.payment_failed"}
        _log_webhook_event("stripe", "invoice.payment_failed", payload, status="failed", http_status=500, error_message="DB timeout")

        event = db_session.query(WebhookEvent).first()
        assert event is not None
        assert event.status == "failed"
        assert event.http_status == 500
        assert event.error_message == "DB timeout"
        assert event.processed_at is not None

    @patch("emr_automation.database.get_session")
    def test_log_webhook_event_survives_commit_failure(self, mock_get_session, db_session):
        from emr_automation.webhooks import _log_webhook_event

        # Simulate a session that raises on commit
        class FailingSession:
            def add(self, obj):
                pass
            def commit(self):
                raise RuntimeError("disk full")

        mock_get_session.return_value = FailingSession()
        # Should not raise — the function swallows logging failures
        _log_webhook_event("stripe", "test.event", {"id": "evt_1"}, status="processed", http_status=200)

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_handle_webhook_logs_ignored_event_for_invalid_metadata(self, mock_get_session, mock_get_stripe, db_session, free_user):
        # CHRA-2423 Bug 57: invalid metadata must be "ignored" (200), not "failed"
        # (500). An HTTP 500 return triggers Stripe retries; each retry converts
        # status failed→processing via CHRA-1871, creating an infinite retry loop.
        from emr_automation.billing import handle_webhook
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_test_rollback",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "metadata": {"user_id": "not_an_int"},  # malformed user_id
                    "customer": "cus_test",
                    "subscription": "sub_test",
                }
            },
        }
        mock_get_stripe.return_value = mock_stripe

        payload_bytes = b'{}'
        result = handle_webhook(payload_bytes, "sig")
        # handle_webhook returns a plain dict (200) for ignored events
        assert isinstance(result, dict), f"Expected dict for ignored event, got: {result!r}"
        assert result.get("ignored") is True

        event = db_session.query(WebhookEvent).filter_by(external_event_id="evt_test_rollback").first()
        assert event is not None
        assert event.status == "ignored"
        assert event.http_status == 200


class TestSubscriptionDeletedIdempotency:
    """CHRA-2482: customer.subscription.deleted must be idempotent."""

    @pytest.fixture(autouse=True)
    def _webhook_secret(self, monkeypatch):
        monkeypatch.setattr("emr_automation.billing.keychain_secret", lambda name: "whsec_test")

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_duplicate_subscription_deleted_is_idempotent(self, mock_get_session, mock_get_stripe, db_session, pro_user):
        from emr_automation.billing import handle_webhook
        from emr_automation.models import WebhookEvent, Subscription

        # Set up an active subscription
        sub = Subscription(
            user_id=pro_user.id,
            stripe_subscription_id="sub_del_123",
            plan="pro",
            status="active",
        )
        db_session.add(sub)
        db_session.commit()

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_sub_del_123",
            "type": "customer.subscription.deleted",
            "data": {"object": {"id": "sub_del_123"}},
        }
        mock_get_stripe.return_value = mock_stripe

        def _unwrap(result):
            if isinstance(result, tuple):
                return result[0], result[1]
            return result, 200

        # First delivery — should cancel subscription and downgrade user
        result1, status1 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status1 == 200
        assert result1 == {"status": "ok"}
        assert sub.status == "canceled"
        assert pro_user.plan == "free"

        # Second delivery — should be idempotent, no state change
        result2, status2 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status2 == 200
        assert result2 == {"status": "ok", "idempotent": True}
        # User should still be free (not flip-flopped)
        assert pro_user.plan == "free"

        # Exactly one webhook event row
        events = db_session.query(WebhookEvent).filter_by(external_event_id="evt_sub_del_123").all()
        assert len(events) == 1
        assert events[0].status == "processed"

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_subscription_deleted_unknown_subscription_is_idempotent(self, mock_get_session, mock_get_stripe, db_session, free_user):
        """Deleting a subscription we don't know about should still be idempotent on retry."""
        from emr_automation.billing import handle_webhook
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_sub_del_unknown",
            "type": "customer.subscription.deleted",
            "data": {"object": {"id": "sub_unknown"}},
        }
        mock_get_stripe.return_value = mock_stripe

        def _unwrap(result):
            if isinstance(result, tuple):
                return result[0], result[1]
            return result, 200

        # First delivery — subscription not found, no-op success
        result1, status1 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status1 == 200

        # Second delivery — idempotent
        result2, status2 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status2 == 200
        assert result2 == {"status": "ok", "idempotent": True}

        events = db_session.query(WebhookEvent).filter_by(external_event_id="evt_sub_del_unknown").all()
        assert len(events) == 1
        assert events[0].status == "processed"

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_subscription_deleted_failed_then_retried(self, mock_get_session, mock_get_stripe, db_session, pro_user):
        """CHRA-1871: a failed customer.subscription.deleted must be reprocessable on retry."""
        from emr_automation.billing import handle_webhook, _acquire_webhook_lock
        from emr_automation.models import WebhookEvent, Subscription

        sub = Subscription(
            user_id=pro_user.id,
            stripe_subscription_id="sub_del_retry",
            plan="pro",
            status="active",
        )
        db_session.add(sub)
        db_session.commit()

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_sub_del_retry",
            "type": "customer.subscription.deleted",
            "data": {"object": {"id": "sub_del_retry"}},
        }
        mock_get_stripe.return_value = mock_stripe

        def _unwrap(result):
            if isinstance(result, tuple):
                return result[0], result[1]
            return result, 200

        # Simulate a previous failed attempt
        _acquire_webhook_lock(
            db_session,
            "evt_sub_del_retry",
            "stripe",
            "customer.subscription.deleted",
            {"id": "evt_sub_del_retry"},
        )
        failed_event = db_session.query(WebhookEvent).filter_by(external_event_id="evt_sub_del_retry").first()
        failed_event.status = "failed"
        failed_event.http_status = 500
        db_session.commit()

        # Retry — should claim the failed lock and process
        result, status = _unwrap(handle_webhook(b'{}', "sig"))
        assert status == 200
        assert result == {"status": "ok"}
        assert sub.status == "canceled"
        assert pro_user.plan == "free"

        # Event should now be processed
        event = db_session.query(WebhookEvent).filter_by(external_event_id="evt_sub_del_retry").first()
        assert event.status == "processed"


class TestIgnoredEventIdempotency:
    """CHRA-2482: Unknown/ignored event types must also be idempotent."""

    @pytest.fixture(autouse=True)
    def _webhook_secret(self, monkeypatch):
        monkeypatch.setattr("emr_automation.billing.keychain_secret", lambda name: "whsec_test")

    @patch("emr_automation.billing._get_stripe")
    @patch("emr_automation.billing.get_session")
    def test_duplicate_unknown_event_is_idempotent(self, mock_get_session, mock_get_stripe, db_session):
        from emr_automation.billing import handle_webhook
        from emr_automation.models import WebhookEvent

        mock_get_session.return_value = db_session
        mock_stripe = MagicMock()
        mock_stripe.Webhook.construct_event.return_value = {
            "id": "evt_unknown_001",
            "type": "invoice.payment_succeeded",
            "data": {"object": {"id": "inv_001"}},
        }
        mock_get_stripe.return_value = mock_stripe

        def _unwrap(result):
            if isinstance(result, tuple):
                return result[0], result[1]
            return result, 200

        # First delivery — ignored
        result1, status1 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status1 == 200
        assert result1 == {"status": "ok"}

        # Second delivery — idempotent
        result2, status2 = _unwrap(handle_webhook(b'{}', "sig"))
        assert status2 == 200
        assert result2 == {"status": "ok", "idempotent": True}

        events = db_session.query(WebhookEvent).filter_by(external_event_id="evt_unknown_001").all()
        assert len(events) == 1
        assert events[0].status == "ignored"
