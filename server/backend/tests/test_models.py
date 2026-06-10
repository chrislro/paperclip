import pytest
from datetime import datetime, timedelta, timezone
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from emr_automation.database import Base
from emr_automation.models import User, Subscription, UsageLog, SelectorConfig, AuditTrail, WebhookEvent


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


class TestUserModel:
    def test_create_user_with_password(self, session):
        user = User(email="doc@test.com", name="Dr. Test")
        user.set_password("secret123")
        session.add(user)
        session.commit()

        found = session.query(User).filter_by(email="doc@test.com").first()
        assert found is not None
        assert found.name == "Dr. Test"
        assert found.plan == "free"
        assert found.check_password("secret123") is True
        assert found.check_password("wrong") is False

    def test_trial_active(self, session):
        user = User(email="trial@test.com", trial_ends_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=14))
        user.set_password("pw")
        session.add(user)
        session.commit()

        assert user.is_trial_active() is True

    def test_trial_expired(self, session):
        user = User(email="expired@test.com", trial_ends_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1))
        user.set_password("pw")
        session.add(user)
        session.commit()

        assert user.is_trial_active() is False

    def test_default_trial_end(self):
        # Owner-locked 7-day trial (CHRA-1848). Allow a small clock margin.
        end = User.default_trial_end()
        delta_days = (end - datetime.now(timezone.utc).replace(tzinfo=None)).days
        assert 6 <= delta_days <= 7


class TestSubscriptionModel:
    def test_create_subscription(self, session):
        user = User(email="sub@test.com")
        user.set_password("pw")
        session.add(user)
        session.commit()

        sub = Subscription(
            user_id=user.id,
            stripe_subscription_id="sub_test_123",
            plan="pro",
            status="active",
        )
        session.add(sub)
        session.commit()

        found = session.query(Subscription).filter_by(user_id=user.id).first()
        assert found.plan == "pro"
        assert found.status == "active"

    def test_stripe_subscription_id_unique(self, session):
        """stripe_subscription_id must be unique across subscriptions."""
        from sqlalchemy.exc import IntegrityError

        user1 = User(email="sub1@test.com")
        user1.set_password("pw")
        session.add(user1)
        session.commit()

        user2 = User(email="sub2@test.com")
        user2.set_password("pw")
        session.add(user2)
        session.commit()

        sub1 = Subscription(
            user_id=user1.id,
            stripe_subscription_id="sub_dupe_123",
            plan="pro",
            status="active",
        )
        session.add(sub1)
        session.commit()

        sub2 = Subscription(
            user_id=user2.id,
            stripe_subscription_id="sub_dupe_123",
            plan="pro",
            status="active",
        )
        session.add(sub2)
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


class TestUsageLogModel:
    def test_create_usage_log(self, session):
        user = User(email="usage@test.com")
        user.set_password("pw")
        session.add(user)
        session.commit()

        log = UsageLog(user_id=user.id, action="transcribe", emr_name="ghosp")
        session.add(log)
        session.commit()

        assert session.query(UsageLog).count() == 1


class TestSelectorConfigModel:
    def test_create_selector_config(self, session):
        config = SelectorConfig(
            emr_name="ghosp",
            emr_version="2024",
            selectors={"soap_editors": ".wysihtml5-sandbox"},
            is_active=True,
        )
        session.add(config)
        session.commit()

        found = session.query(SelectorConfig).filter_by(emr_name="ghosp").first()
        assert found.selectors["soap_editors"] == ".wysihtml5-sandbox"


class TestAuditTrailModel:
    def test_create_audit_trail(self, session):
        trail = AuditTrail(
            action_type="finalize",
            duration_seconds=5.2,
            success=True,
        )
        session.add(trail)
        session.commit()

        assert session.query(AuditTrail).count() == 1
        assert session.query(AuditTrail).first().success is True


class TestWebhookEventModel:
    def test_create_webhook_event(self, session):
        event = WebhookEvent(
            external_event_id="evt_test_123",
            event_type="user.created",
            source="clerk",
            payload={"id": "user_123", "email": "[REDACTED]"},
            status="processed",
            http_status=200,
        )
        session.add(event)
        session.commit()

        found = session.query(WebhookEvent).filter_by(external_event_id="evt_test_123").first()
        assert found is not None
        assert found.event_type == "user.created"
        assert found.source == "clerk"
        assert found.status == "processed"
        assert found.http_status == 200

    def test_webhook_event_default_status(self, session):
        event = WebhookEvent(
            event_type="checkout.session.completed",
            source="stripe",
            payload={"id": "cs_test_123"},
        )
        session.add(event)
        session.commit()

        found = session.query(WebhookEvent).first()
        assert found.status == "received"

    def test_webhook_event_unique_constraint(self, session):
        """Duplicate (external_event_id, source) must raise IntegrityError."""
        from sqlalchemy.exc import IntegrityError

        event1 = WebhookEvent(
            external_event_id="evt_dup_001",
            event_type="user.created",
            source="clerk",
            payload={"id": "user_1"},
            status="processed",
        )
        session.add(event1)
        session.commit()

        event2 = WebhookEvent(
            external_event_id="evt_dup_001",
            event_type="user.updated",
            source="clerk",
            payload={"id": "user_2"},
            status="received",
        )
        session.add(event2)
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

    def test_jit_provisioning_sets_trial(self, session):
        """Users created via JIT provisioning must get a trial period."""
        user = User(
            clerk_user_id="user_jit_001",
            email="jit@test.com",
            plan="free",
            password_hash="",
            trial_ends_at=User.default_trial_end(),
        )
        session.add(user)
        session.commit()

        found = session.query(User).filter_by(clerk_user_id="user_jit_001").first()
        assert found is not None
        assert found.trial_ends_at is not None
        assert found.is_trial_active() is True


class TestScrubWebhookPayload:
    def test_scrubs_clerk_pii(self, session):
        from emr_automation.models import _scrub_webhook_payload

        payload = {
            "id": "evt_123",
            "type": "user.created",
            "data": {
                "id": "user_123",
                "email_addresses": [{"id": "em_1", "email_address": "doctor@example.com"}],
                "first_name": "John",
                "last_name": "Doe",
                "phone_numbers": [{"id": "ph_1", "phone_number": "+5511999999999"}],
                "username": "johndoe",
                "gender": "male",
                "birthday": "1980-01-01",
                "image_url": "https://example.com/avatar.jpg",
            },
        }
        scrubbed = _scrub_webhook_payload(payload, "clerk")

        assert scrubbed["data"]["email_addresses"] == "[REDACTED]"
        assert scrubbed["data"]["first_name"] == "[REDACTED]"
        assert scrubbed["data"]["last_name"] == "[REDACTED]"
        assert scrubbed["data"]["phone_numbers"] == "[REDACTED]"
        assert scrubbed["data"]["username"] == "[REDACTED]"
        assert scrubbed["data"]["gender"] == "[REDACTED]"
        assert scrubbed["data"]["birthday"] == "[REDACTED]"
        assert scrubbed["data"]["image_url"] == "[REDACTED]"
        # Non-PII preserved
        assert scrubbed["id"] == "evt_123"
        assert scrubbed["type"] == "user.created"
        assert scrubbed["data"]["id"] == "user_123"

    def test_scrubs_stripe_pii(self, session):
        from emr_automation.models import _scrub_webhook_payload

        payload = {
            "id": "evt_stripe_123",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test",
                    "email": "doctor@example.com",
                    "name": "Dr. Test",
                    "phone": "+5511999999999",
                    "address": {"city": "São Paulo", "country": "BR"},
                    "shipping": {"name": "Dr. Test", "address": {}},
                    "customer_details": {"email": "doctor@example.com", "name": "Dr. Test"},
                    "receipt_email": "doctor@example.com",
                    "description": "Payment for Dr. Test",
                }
            },
        }
        scrubbed = _scrub_webhook_payload(payload, "stripe")

        obj = scrubbed["data"]["object"]
        assert obj["email"] == "[REDACTED]"
        assert obj["name"] == "[REDACTED]"
        assert obj["phone"] == "[REDACTED]"
        assert obj["address"] == "[REDACTED]"
        assert obj["shipping"] == "[REDACTED]"
        assert obj["customer_details"] == "[REDACTED]"
        assert obj["receipt_email"] == "[REDACTED]"
        assert obj["description"] == "[REDACTED]"
        # Non-PII preserved
        assert obj["id"] == "cs_test"
        assert scrubbed["id"] == "evt_stripe_123"

    def test_scrubs_nested_lists(self, session):
        from emr_automation.models import _scrub_webhook_payload

        payload = {
            "data": [
                {"email": "a@example.com", "id": "1"},
                {"email": "b@example.com", "id": "2"},
            ]
        }
        scrubbed = _scrub_webhook_payload(payload, "stripe")
        assert scrubbed["data"][0]["email"] == "[REDACTED]"
        assert scrubbed["data"][0]["id"] == "1"
        assert scrubbed["data"][1]["email"] == "[REDACTED]"
        assert scrubbed["data"][1]["id"] == "2"

    def test_empty_payload(self, session):
        from emr_automation.models import _scrub_webhook_payload

        assert _scrub_webhook_payload(None, "clerk") == {}
        assert _scrub_webhook_payload("not a dict", "clerk") == {}
        assert _scrub_webhook_payload({}, "clerk") == {}
