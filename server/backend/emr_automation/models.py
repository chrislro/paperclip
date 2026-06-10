"""SQLAlchemy models for Toca Ficha Dr. Phase 2 cloud backend."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import Column, Integer, String, Float, Boolean, Text, DateTime, ForeignKey, JSON, UniqueConstraint
from werkzeug.security import generate_password_hash, check_password_hash
from emr_automation.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False)
    # password_hash kept for backwards-compat with pre-v3.0 rows; new rows leave it NULL.
    # Will be dropped entirely in v3.0.4 once Clerk migration is verified.
    password_hash = Column(String(255), nullable=True)
    # Clerk migration (v3.0): primary identity link.
    # Nullable during cutover (existing rows have NULL until backfilled by webhook or
    # by a manual UPDATE). Indexed UNIQUE so lookups by Clerk JWT 'sub' are O(log n).
    clerk_user_id = Column(String(255), unique=True, index=True, nullable=True)
    name = Column(String(255))
    plan = Column(String(20), default="free")
    stripe_customer_id = Column(String(255))
    trial_ends_at = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    def set_password(self, password):
        # Retained for legacy self-hosted deployments that haven't migrated to Clerk.
        # Default cloud deployments should not call this — Clerk owns password storage.
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        if not self.password_hash:
            return False
        return check_password_hash(self.password_hash, password)

    def is_trial_active(self):
        if self.trial_ends_at is None:
            return False
        return datetime.now(timezone.utc).replace(tzinfo=None) < self.trial_ends_at

    @staticmethod
    def default_trial_end():
        # 7-day trial — owner-locked launch decision (CHRA-1848). Was 14 days
        # pre-launch; reduced to 7 for the paid CWS launch (cards-only, R$79/mo).
        return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=7)


class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    stripe_subscription_id = Column(String(255), unique=True)
    plan = Column(String(20), nullable=False)
    status = Column(String(20), nullable=False)
    current_period_end = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))


class UsageLog(Base):
    __tablename__ = "usage_logs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    action = Column(String(50), nullable=False)
    emr_name = Column(String(50))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))


class SelectorConfig(Base):
    __tablename__ = "selector_configs"

    id = Column(Integer, primary_key=True)
    emr_name = Column(String(50), nullable=False)
    emr_version = Column(String(20))
    selectors = Column(JSON, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    is_active = Column(Boolean, default=True)


class AuditTrail(Base):
    __tablename__ = "audit_trail"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    action_type = Column(String(50))
    duration_seconds = Column(Float)
    success = Column(Boolean)
    error_message = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))


class IdempotentOperation(Base):
    """Tracks idempotent API calls to prevent duplicate provider billing.

    Client generates an operation_id (UUID v4) per user action and sends it
    as the X-Operation-Id header. The backend stores the result keyed by
    (user_id, operation_id) so retries return the cached response instead of
    calling the provider again.
    """
    __tablename__ = "idempotent_operations"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    operation_id = Column(String(64), nullable=False, index=True)
    endpoint = Column(String(100), nullable=False)
    status = Column(String(20), nullable=False, default="in_progress")
    # response_body stores the JSON-serialized result (must NOT contain PHI).
    response_body = Column(Text)
    provider = Column(String(50))
    duration_ms = Column(Integer)
    error_code = Column(String(50))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))
    completed_at = Column(DateTime)
    # TTL: operations older than 24h can be cleaned up.
    expires_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24))

    __table_args__ = (
        # UNIQUE (user_id, operation_id) enforces the idempotency guarantee at the
        # DB level: two concurrent requests with the same X-Operation-Id cannot both
        # insert an in_progress row and both run the (provider-billed) operation.
        # The @idempotent decorator catches the resulting IntegrityError and re-queries.
        # Bug 69 — this constraint was DOCUMENTED here but never actually declared, so
        # the "prevent duplicate provider billing" guarantee in the class docstring
        # was unenforced. Mirrors WebhookEvent's uq_webhook_events_external_source.
        # NOTE: create_all() adds this only to NEW databases; an existing production
        # table needs a one-off migration to add the constraint (de-dupe any existing
        # rows first).
        UniqueConstraint("user_id", "operation_id", name="uq_idempotent_user_op"),
        {"sqlite_autoincrement": True},
    )


def _scrub_webhook_payload(payload, source):
    """Redact PII from webhook payloads before persistence.

    CSO-003 / LGPD compliance: webhook audit logs must not retain
    identifiable personal data (emails, names, phone numbers, addresses).
    Structural fields (ids, types, timestamps, amounts) are preserved
    so events remain debuggable without exposing PHI/PII.
    """
    if not isinstance(payload, dict):
        return {}

    scrubbed = {}
    pii_keys = {
        # Clerk
        "email_addresses", "first_name", "last_name", "phone_numbers",
        "username", "gender", "birthday", "image_url", "profile_image_url",
        "public_metadata", "private_metadata", "unsafe_metadata",
        # Stripe
        "email", "name", "phone", "address", "shipping", "billing_details",
        "payment_method", "payment_method_details", "customer_details",
        "receipt_email", "description",
    }

    for key, value in payload.items():
        if key in pii_keys:
            scrubbed[key] = "[REDACTED]"
        elif isinstance(value, dict):
            scrubbed[key] = _scrub_webhook_payload(value, source)
        elif isinstance(value, list):
            scrubbed[key] = [
                _scrub_webhook_payload(item, source) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            scrubbed[key] = value

    return scrubbed


class WebhookEvent(Base):
    """Audit log for incoming webhooks from Clerk, Stripe, and other providers.

    Stores the raw payload, processing status, and any errors so webhook
    delivery issues can be debugged without relying on provider dashboards.

    LGPD / PII note: payload is scrubbed by _scrub_webhook_payload before
    storage.  A 30-day retention is recommended; implement cleanup via a
    periodic job or cron that DELETEs rows older than 30 days.
    """
    __tablename__ = "webhook_events"

    id = Column(Integer, primary_key=True)
    # Provider-defined event ID (e.g., Stripe's evt_xxx or Svix's msg_xxx).
    external_event_id = Column(String(255), index=True)
    # Event type: user.created, checkout.session.completed, etc.
    event_type = Column(String(100), nullable=False, index=True)
    # Source provider: clerk, stripe, etc.
    source = Column(String(50), nullable=False, index=True)
    # Scrubbed payload (JSON) — PII redacted, structural fields retained.
    payload = Column(JSON, nullable=False, default=dict)
    # Processing status: received, processed, failed, ignored.
    status = Column(String(20), nullable=False, default="received")
    # HTTP status code returned to the provider.
    http_status = Column(Integer)
    # Error message if processing failed.
    error_message = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), nullable=False)
    processed_at = Column(DateTime)

    __table_args__ = (
        # UNIQUE constraint prevents duplicate webhook events from the same provider.
        # SQLite and PostgreSQL both allow multiple NULL values in a UNIQUE column,
        # so events without an external_event_id (rare) are not constrained.
        UniqueConstraint("external_event_id", "source", name="uq_webhook_events_external_source"),
    )


class UserConfig(Base):
    """Per-user clinical configuration. One row per User.

    Holds prescription templates, SOAP voices, custom instructions, doctor
    name, and behavioral toggles. Server is authoritative; client treats
    `chrome.storage.local[config_<uid>]` as a read-through cache wiped on
    signout.

    Lazy creation: a row is created by GET /api/me/config on first access
    for a new user, seeded with DEFAULT_RX_TEMPLATES.

    Phase 003 (2026-05-10) replaces chrome.storage.sync.prescriptionTemplates
    et al. with this account-linked storage so doctors carry their library
    across devices and shared hospital Chrome profiles.
    """
    __tablename__ = "user_configs"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    rx_templates = Column(JSON, nullable=False, default=list)
    # voices stores PERSONAL voice profiles only; built-ins are reconstructed
    # client-side at load time. active_voice_id can reference either a builtin
    # ("voice_padrao", "voice_conciso", "voice_detalhado") or a personal id.
    voices = Column(JSON, nullable=False, default=list)
    active_voice_id = Column(String(64), nullable=False, default="voice_padrao")
    custom_instructions = Column(Text, nullable=False, default="")
    doctor_name = Column(String(255), nullable=False, default="")
    auto_cid = Column(Boolean, nullable=False, default=True)
    auto_clear_soap = Column(Boolean, nullable=False, default=True)
    auto_fill_companion = Column(Boolean, nullable=False, default=True)
    auto_prefill_encaminh = Column(Boolean, nullable=False, default=True)
    auto_transcribe_on_dictation = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), onupdate=lambda: datetime.now(timezone.utc).replace(tzinfo=None), nullable=False)
