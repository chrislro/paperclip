"""Stripe billing integration for Toca Ficha Dr. cloud API."""
import os
import logging
from datetime import datetime, date, timezone

from emr_automation.database import get_session
from emr_automation.models import User, Subscription, UsageLog
from keychain_helper import keychain_secret

logger = logging.getLogger(__name__)

FREE_DAILY_LIMIT = 5
# CHRA-2423 Bug 38 — one consultation must count as ONE billable use.
# The v3.1.1 side-panel split records as Phase A (/api/transcribe?skip_soap=1,
# billed as "transcribe") followed by Phase B (/api/soap-stream). "soap_stream"
# is NEVER a standalone action — it is always the SOAP continuation of a
# transcribe that was already billed — so counting it double-charged side-panel
# recordings (2 uses) versus the popup's inline path (1 use) for the IDENTICAL
# operation. Dropped it so billing is consistent across surfaces.
# NOTE (owner decision pending): the rarer fallback path (/api/soap-stream errors
# → side panel retries /api/format-soap) still bills transcribe + format_soap = 2.
# Whether to also drop "format_soap" depends on whether it is ever a standalone
# billable SOAP call. Flagged on PR #100; left billable for now (conservative).
BILLABLE_ACTIONS = (
    "transcribe",
    "format_soap",
    "format_atestado_letter",
    "suggest_cid",
)


def _get_stripe():
    import stripe

    try:
        stripe.api_key = keychain_secret("pedbot-stripe-secret-key")
    except SystemExit:
        stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
    return stripe


def create_portal_session(user_id, return_url):
    """Create a Stripe Customer Portal session for managing subscriptions."""
    s = _get_stripe()
    session_db = get_session()
    user = session_db.query(User).get(user_id)
    if not user:
        return {"error": "User not found"}
    if not user.stripe_customer_id:
        return {"error": "No Stripe customer record found"}

    portal = s.billing_portal.Session.create(
        customer=user.stripe_customer_id,
        return_url=return_url,
    )
    return {"url": portal.url}


def create_checkout_session(user_id, plan, success_url, cancel_url):
    """Create a Stripe Checkout session for subscription."""
    s = _get_stripe()
    session_db = get_session()
    user = session_db.query(User).get(user_id)

    def _price_id(key: str):
        try:
            return keychain_secret(f"pedbot-stripe-{key}-price-id")
        except SystemExit:
            return os.environ.get(f"STRIPE_{key.upper()}_PRICE_ID", "")

    price_id_map = {
        "pro": _price_id("pro"),
        "hospital": _price_id("hospital"),
    }
    price_id = price_id_map.get(plan)
    if not price_id:
        return {"error": f"Unknown plan: {plan}"}

    checkout = s.checkout.Session.create(
        customer_email=user.email if user else None,
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        mode="subscription",
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"user_id": str(user_id), "plan": plan},
    )
    return {"url": checkout.url, "session_id": checkout.id}


from emr_automation.webhooks import _acquire_webhook_lock, _log_webhook_event


def handle_webhook(payload, sig_header):
    """Process a Stripe webhook event."""
    s = _get_stripe()
    try:
        webhook_secret = keychain_secret("pedbot-stripe-webhook-secret")
    except SystemExit:
        webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

    if not (webhook_secret or "").strip():
        # Fail CLOSED. construct_event() with an empty secret verifies the HMAC
        # against an empty key — which an attacker can compute, letting them forge
        # events (e.g. checkout.session.completed → free Pro). Never process a
        # webhook we cannot actually authenticate. 500 so Stripe retries and the
        # misconfiguration surfaces, instead of silently accepting forgeries.
        logger.error("Stripe webhook secret not configured — rejecting (fail closed)")
        return {"error": "Webhook secret not configured"}, 500

    try:
        event = s.Webhook.construct_event(payload, sig_header, webhook_secret)
    except (ValueError, s.error.SignatureVerificationError) as e:
        logger.error("Stripe webhook verification failed: %s", e)
        return {"error": "Invalid signature"}, 400

    session_db = get_session()
    event_type = event.get("type", "")
    event_data = event.get("data", {}).get("object", {})

    external_id = event.get("id")

    # CHRA-1870: Atomic idempotency guard. Try to insert a "processing" row.
    # The UNIQUE constraint on (external_event_id, source) guarantees that only
    # one worker can win the race. This eliminates the TOCTOU vulnerability in
    # the previous SELECT-then-INSERT pattern.
    lock_record, is_new = _acquire_webhook_lock(
        session_db, external_id, "stripe", event_type, event
    )
    if not is_new:
        if lock_record and lock_record.status in ("processed", "failed", "ignored"):
            return {"status": "ok", "idempotent": True}
        # Another worker is currently processing this event.
        return {"status": "ok", "concurrent": True}

    try:
        if event_type == "checkout.session.completed":
            data = event["data"]["object"]
            metadata = data.get("metadata") or {}
            user_id_raw = metadata.get("user_id")
            plan = metadata.get("plan")
            if not user_id_raw or not plan:
                # Stripe Dashboard test events and misconfigured checkout sessions
                # can arrive with empty metadata. A KeyError here marks the record
                # "failed", which triggers the CHRA-1871 failed→processing retry
                # path on each subsequent Stripe delivery, creating an infinite
                # retry loop until the event ages out (72 h). Mark "ignored" and
                # return 200 so Stripe stops retrying.
                logger.warning(
                    "checkout.session.completed missing user_id/plan metadata — "
                    "marking ignored (event_id=%s)",
                    event.get("id", "?"),
                )
                if lock_record:
                    lock_record.status = "ignored"
                    lock_record.http_status = 200
                    lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    session_db.commit()
                return {"status": "ok", "ignored": True}
            try:
                user_id = int(user_id_raw)
            except (ValueError, TypeError):
                # Malformed user_id (e.g. non-integer string) is equally
                # unprocessable — same "ignored" path, same reasoning.
                logger.warning(
                    "checkout.session.completed invalid user_id=%r — "
                    "marking ignored (event_id=%s)",
                    user_id_raw, event.get("id", "?"),
                )
                if lock_record:
                    lock_record.status = "ignored"
                    lock_record.http_status = 200
                    lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    session_db.commit()
                return {"status": "ok", "ignored": True}

            user = session_db.query(User).get(user_id)
            if user:
                user.plan = plan
                user.stripe_customer_id = data.get("customer")

            sub = Subscription(
                user_id=user_id,
                stripe_subscription_id=data.get("subscription"),
                plan=plan,
                status="active",
            )
            session_db.add(sub)
            session_db.commit()

        elif event_type == "customer.subscription.deleted":
            data = event["data"]["object"]
            sub = session_db.query(Subscription).filter_by(
                stripe_subscription_id=data["id"]
            ).first()
            if sub:
                sub.status = "canceled"
                user = session_db.query(User).get(sub.user_id)
                if user:
                    user.plan = "free"
                session_db.commit()

        else:
            # Ignored event type — update lock record and return.
            if lock_record:
                lock_record.status = "ignored"
                lock_record.http_status = 200
                lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                session_db.commit()
            else:
                _log_webhook_event("stripe", event_type, event, status="ignored", http_status=200)
            return {"status": "ok"}

        # Success path — update lock record to "processed".
        if lock_record:
            lock_record.status = "processed"
            lock_record.http_status = 200
            lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session_db.commit()
        else:
            _log_webhook_event("stripe", event_type, event, status="processed", http_status=200)

        return {"status": "ok"}
    except Exception as e:
        logger.exception("Stripe webhook handler error for %s: %s", event_type, e)
        # Rollback any dirty session so the failure update can commit cleanly.
        try:
            session_db.rollback()
        except Exception:
            pass
        if lock_record:
            lock_record.status = "failed"
            lock_record.http_status = 500
            lock_record.error_message = str(e)
            lock_record.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            try:
                session_db.commit()
            except Exception as inner:
                logger.warning("Failed to update webhook lock record to failed: %s", inner)
        else:
            _log_webhook_event("stripe", event_type, event, status="failed", http_status=500, error_message=str(e))
        return {"error": "handler exception"}, 500


def get_subscription(user_id):
    """Get subscription status and usage for a user."""
    session_db = get_session()
    user = session_db.query(User).get(user_id)
    if not user:
        return {"error": "User not found"}

    sub = session_db.query(Subscription).filter_by(
        user_id=user_id, status="active"
    ).first()

    today_count = session_db.query(UsageLog).filter(
        UsageLog.user_id == user_id,
        UsageLog.action.in_(BILLABLE_ACTIONS),
        # Use UTC date (not local date) — UsageLog.created_at is stored as naive
        # UTC; date.today() returns the server's local calendar date (BRT = UTC-3),
        # causing the window to be off by 3 h and free-tier quota to reset early.
        UsageLog.created_at >= datetime.combine(datetime.now(timezone.utc).date(), datetime.min.time()),
    ).count()

    return {
        "plan": user.plan,
        "trial_active": user.is_trial_active(),
        "trial_ends_at": user.trial_ends_at.isoformat() if user.trial_ends_at else None,
        "subscription": {
            "status": sub.status if sub else None,
            "current_period_end": sub.current_period_end.isoformat() if sub and sub.current_period_end else None,
        } if sub else None,
        "usage_today": today_count,
        "daily_limit": None if user.plan != "free" or user.is_trial_active() else FREE_DAILY_LIMIT,
    }


def check_usage_limit(user_id):
    """Return True if user can make another API call."""
    session_db = get_session()
    user = session_db.query(User).get(user_id)
    if not user:
        return False

    if user.plan in ("pro", "hospital") or user.is_trial_active():
        return True

    today_count = session_db.query(UsageLog).filter(
        UsageLog.user_id == user_id,
        UsageLog.action.in_(BILLABLE_ACTIONS),
        # Use UTC date (not local date) — UsageLog.created_at is stored as naive
        # UTC; date.today() returns the server's local calendar date (BRT = UTC-3),
        # causing the window to be off by 3 h and free-tier quota to reset early.
        UsageLog.created_at >= datetime.combine(datetime.now(timezone.utc).date(), datetime.min.time()),
    ).count()

    return today_count < FREE_DAILY_LIMIT


def log_usage(user_id, action, emr_name="ghosp"):
    """Log an API usage event."""
    session_db = get_session()
    log = UsageLog(user_id=user_id, action=action, emr_name=emr_name)
    session_db.add(log)
    session_db.commit()
