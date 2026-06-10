"""Shared webhook utilities for idempotency and audit logging.

Used by Clerk (routes_clerk.py) and Stripe (billing.py) webhook handlers.
"""
from datetime import datetime, timezone
import logging

from emr_automation.models import WebhookEvent, _scrub_webhook_payload

logger = logging.getLogger(__name__)


def _log_webhook_event(source, event_type, payload, status="received", http_status=None, error_message=None):
    """Persist a webhook event for audit and debugging."""
    try:
        from emr_automation.database import get_session
        session_db = get_session()
        # Extract external event ID from payload if available.
        external_id = payload.get("id") if isinstance(payload, dict) else None
        scrubbed = _scrub_webhook_payload(payload, source)
        event = WebhookEvent(
            external_event_id=external_id,
            event_type=event_type,
            source=source,
            payload=scrubbed,
            status=status,
            http_status=http_status,
            error_message=error_message,
            processed_at=datetime.now(timezone.utc).replace(tzinfo=None) if status in ("processed", "failed", "ignored") else None,
        )
        session_db.add(event)
        session_db.commit()
    except Exception as e:
        # Never fail the webhook response because logging failed.
        logger.warning("webhook_event logging failed for %s %s: %s", source, event_type, e)


def _acquire_webhook_lock(session, external_id, source, event_type, payload):
    """Atomically acquire a processing lock for a webhook event.

    Returns (record, is_new):
      - is_new=True  -> we successfully inserted a "processing" row; caller
                       should process the webhook and then update the record.
      - is_new=False -> another worker already holds the lock (or has finished).
                       Caller should inspect record.status and return early.

    CHRA-1870: Uses a UNIQUE constraint on (external_event_id, source) to
    eliminate the TOCTOU race that exists in a SELECT-then-INSERT pattern.

    CHRA-1871: Failed events are eligible for retry. When a provider retries a
    failed event, the atomic UPDATE status='failed' → 'processing' lets exactly
    one worker claim the retry; others see concurrent and return 200.
    """
    from sqlalchemy.exc import IntegrityError

    if not external_id:
        # Events without an external ID cannot be deduplicated at the DB layer.
        return None, True

    scrubbed = _scrub_webhook_payload(payload, source)
    record = WebhookEvent(
        external_event_id=external_id,
        event_type=event_type,
        source=source,
        payload=scrubbed,
        status="processing",
    )
    session.add(record)
    try:
        session.commit()
        return record, True
    except IntegrityError:
        session.rollback()
        # CHRA-1871: Atomically claim a failed event so the provider retry
        # re-processes instead of being swallowed as idempotent.
        updated = (
            session.query(WebhookEvent)
            .filter(
                WebhookEvent.external_event_id == external_id,
                WebhookEvent.source == source,
                WebhookEvent.status == "failed",
            )
            .update({"status": "processing"}, synchronize_session=False)
        )
        if updated:
            session.commit()
            existing = (
                session.query(WebhookEvent)
                .filter_by(external_event_id=external_id, source=source)
                .first()
            )
            return existing, True
        session.rollback()
        existing = (
            session.query(WebhookEvent)
            .filter_by(external_event_id=external_id, source=source)
            .first()
        )
        return existing, False
