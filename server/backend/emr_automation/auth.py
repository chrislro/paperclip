"""Clerk JWT verification for Toca Ficha Dr. cloud API.

Replaces the previous HS256 + werkzeug-password custom auth (v2.6.x).
Decorator signatures unchanged; call sites in routes.py + routes_billing.py
continue to work. Sets `g.user_id` to the internal integer User.id (lazy-
provisioned from Clerk on first sign-in) so existing usage_log + check_usage_limit
code paths keep their integer FK semantics.

Sources:
- Phase 002 plan 02-01 (.planning/phases/002-clerk-migration/ in tocafichadr-extension repo)
- Strategy memo: tocafichadr-extension/docs/STRATEGY-saas.md
- Clerk SDK: https://github.com/clerk/clerk-sdk-python
"""
import os
import logging
import concurrent.futures
from functools import wraps

from flask import request, g, jsonify, copy_current_request_context, current_app

from keychain_helper import keychain_secret

logger = logging.getLogger(__name__)

# Lazy SDK import — only when Clerk is actually configured. Lets unit tests
# that don't exercise auth import this module without requiring the dependency.
_CLERK_CLIENT = None
_CLERK_IMPORT_FAILED = False


def _get_clerk_client():
    """Lazy singleton — initialized on first use, reused for the lifetime of the worker."""
    global _CLERK_CLIENT, _CLERK_IMPORT_FAILED
    if _CLERK_CLIENT is not None:
        return _CLERK_CLIENT
    if _CLERK_IMPORT_FAILED:
        return None

    try:
        from clerk_backend_api import Clerk
    except ImportError:
        logger.error("clerk-backend-api not installed; run `pip install clerk-backend-api`")
        _CLERK_IMPORT_FAILED = True
        return None

    secret = os.environ.get("CLERK_SECRET_KEY")
    if not secret:
        # Try post-rebrand keychain name first, then legacy. Both have been
        # in use at different points: `clerk-secret-key` is the current name
        # (CSO-017 rebrand 2026-05-04), `pedbot-clerk-secret-key` is the
        # pre-rebrand legacy. Without this two-name lookup, a Mini that has
        # the entry under the new name silently 401s every Bearer-authed
        # request because the Clerk client can't be built.
        for keychain_name in ("clerk-secret-key", "pedbot-clerk-secret-key"):
            try:
                secret = keychain_secret(keychain_name)
                if secret:
                    break
            except SystemExit:
                continue  # try next name
        if not secret:
            logger.error(
                "CLERK_SECRET_KEY not in env or Keychain. "
                "Run: security add-generic-password -U -a clerk -s clerk-secret-key -w '<sk_live_...>'"
            )
            _CLERK_IMPORT_FAILED = True
            return None

    _CLERK_CLIENT = Clerk(bearer_auth=secret)
    return _CLERK_CLIENT


def _fetch_clerk_user_email(clerk_user_id):
    """Best-effort fetch of a user's primary email from Clerk's Users API.

    Returns the email string on success, None on any failure (so the
    provisioning path stays survivable when Clerk is unreachable). Used
    only at lazy-provisioning time — one HTTP round-trip per new user.

    The Clerk User model surfaces `email_addresses` (list of EmailAddress
    objects, each with `id` + `email_address`) and `primary_email_address_id`
    pointing at the primary one. Same shape the webhook event uses
    (routes_clerk.py), so the parsing matches.
    """
    if not clerk_user_id:
        return None
    clerk = _get_clerk_client()
    if clerk is None:
        return None
    try:
        # clerk-backend-api: clerk.users.get(user_id=...) returns a User pydantic model.
        user = clerk.users.get(user_id=clerk_user_id)
    except Exception as e:
        logger.warning("clerk users.get failed for %s: %s", clerk_user_id, e)
        return None
    if user is None:
        return None
    primary_id = getattr(user, "primary_email_address_id", None)
    addrs = getattr(user, "email_addresses", None) or []
    # Try primary first.
    if primary_id:
        for a in addrs:
            if getattr(a, "id", None) == primary_id:
                em = getattr(a, "email_address", None)
                if isinstance(em, str) and "@" in em:
                    return em
    # Fallback: first email address with a populated email_address field.
    for a in addrs:
        em = getattr(a, "email_address", None)
        if isinstance(em, str) and "@" in em:
            return em
    return None


def _authorized_parties():
    """Origins that Clerk will accept JWTs from.

    Returns None when CLERK_AUTHORIZED_PARTIES is unset OR explicitly empty
    ('', '-', 'none'). Returning None disables azp claim validation in the
    Clerk SDK — JWT signature + expiration + JWKS issuer still validated.

    Verified 2026-05-11 against production Clerk on clerk.tocafichadr.com.br:
    when `authorized_parties` is configured (a non-empty list), the Clerk
    SDK REQUIRES every token to carry an `azp` claim that matches one of
    the listed values. The @clerk/chrome-extension/background SDK
    (background: true) mints tokens with NO `azp` claim at all, so they
    are rejected with TokenVerificationErrorReason.TOKEN_INVALID_AUTHORIZED_PARTIES
    regardless of what's in the list. Leaving the env unset is therefore
    not just convenient — it's REQUIRED for chrome-extension auth via the
    background SDK. The remaining checks (signature, issuer matches
    https://clerk.tocafichadr.com.br via JWKS, exp/nbf, session active)
    cover security adequately.
    """
    raw = os.environ.get("CLERK_AUTHORIZED_PARTIES", "").strip()
    if not raw or raw.lower() in ("-", "none"):
        return None
    return [p.strip() for p in raw.split(",") if p.strip()]


def _verify_clerk_jwt():
    """Verify the request's bearer token against Clerk JWKS.
    Returns (clerk_user_id, email) on success, (None, None) on failure.
    """
    clerk = _get_clerk_client()
    if clerk is None:
        return None, None
    try:
        parties = _authorized_parties()
        try:
            from clerk_backend_api.security.types import AuthenticateRequestOptions
            # Pass authorized_parties only when configured — passing None to
            # the SDK still triggers the check with an empty allowlist (every
            # token rejected). Omitting the kwarg uses the SDK's "skip azp"
            # default.
            #
            # clock_skew_in_ms=30000 (30s) absorbs typical NTP drift on the
            # Mac Mini host. The SDK default is 5000ms; verified 2026-05-25
            # the Mini was ~6.8s behind time.apple.com which produced
            # TOKEN_NOT_ACTIVE_YET rejections on every Bearer-authed request
            # immediately after a fresh sign-in (the token's `nbf` claim was
            # ~5s in the Mini's future). 30s tolerance is a 6× buffer on
            # what we just measured; trades a small replay-window enlargement
            # (~25s) for resilience to NTP failures.
            opts_kwargs = {"clock_skew_in_ms": 30000}
            if parties:
                opts_kwargs["authorized_parties"] = parties
            options = AuthenticateRequestOptions(**opts_kwargs)
        except ImportError:
            # Unit tests patch the Clerk client without installing the SDK.
            options = {"authorized_parties": parties} if parties else {}

        # The SDK reads Authorization: Bearer <token> from the httpx-shaped request.
        # Flask's `request` is a LocalProxy bound to the request thread — passing
        # it directly to a ThreadPoolExecutor worker raised "Working outside of
        # request context" when the SDK accessed request.headers from the worker.
        # `copy_current_request_context` binds the current request context to the
        # callable so the worker thread can resolve the proxy. Timeout still
        # protects against JWKS-fetch hangs.
        @copy_current_request_context
        def _verify():
            return clerk.authenticate_request(request, options)

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_verify)
                state = future.result(timeout=5)
        except concurrent.futures.TimeoutError:
            logger.error("Clerk JWT verification timed out after 5 s (JWKS fetch hung)")
            return None, None
        if not state.is_signed_in:
            reason = getattr(state, "reason", "unknown")
            # Diagnostic: decode the JWT's azp/iss/sub to see what the SDK is
            # rejecting. Tokens may be sniffed from chrome.storage.local by
            # admin of this Mac Mini only — log is local-only per LGPD note
            # at /api/debug-log. Remove once auth chain is stable.
            azp = iss = sub = "?"
            try:
                auth_hdr = request.headers.get("Authorization", "") or ""
                if auth_hdr.startswith("Bearer "):
                    raw = auth_hdr[7:]
                    parts = raw.split(".")
                    if len(parts) >= 2:
                        import base64, json as _json
                        pad = "=" * ((4 - len(parts[1]) % 4) % 4)
                        decoded = base64.urlsafe_b64decode(parts[1] + pad)
                        claims = _json.loads(decoded)
                        azp = claims.get("azp", "<no-azp>")
                        iss = claims.get("iss", "<no-iss>")
                        sub = (claims.get("sub") or "")[:30]
            except Exception:
                pass
            logger.warning(
                "clerk auth rejected: %s | azp=%r iss=%r sub=%r parties=%r",
                reason, azp, iss, sub, parties,
            )
            return None, None
        # Email extraction from the JWT payload. The 'email' top-level claim
        # is the documented shape when the Clerk dashboard's session token
        # template carries `{{user.primary_email_address}}` (Configure →
        # Sessions → Customize session token). When that template isn't set
        # OR the @clerk/chrome-extension/background SDK omits the claim
        # entirely, we fall back to the more verbose Clerk user shape
        # (`email_addresses[]` + `primary_email_address_id`) that the webhook
        # event format always uses — some session templates surface that
        # whole object as a nested claim. None as last resort lets the
        # caller (_resolve_user_id) hit Clerk's Users API on provisioning.
        payload = getattr(state, "payload", {}) or {}
        email = _extract_email_from_clerk_payload(payload)
        return payload.get("sub"), email
    except Exception as e:
        logger.warning("clerk auth: unexpected error: %s", e)
        return None, None


def _extract_email_from_clerk_payload(payload):
    """Best-effort email extraction from a verified Clerk JWT payload.

    Returns the email string on success, None when no shape we recognize
    holds an email. Never raises. The payload is the dict-shape `state.payload`
    surfaced by clerk_backend_api after `authenticate_request` succeeds.
    """
    if not isinstance(payload, dict):
        return None
    # Path 1: flat `email` claim (the documented session-template path).
    flat = payload.get("email")
    if isinstance(flat, str) and "@" in flat:
        return flat
    # Path 2: `email_address` (alternate flat claim some Clerk templates emit).
    alt = payload.get("email_address")
    if isinstance(alt, str) and "@" in alt:
        return alt
    # Path 3: full User shape — `email_addresses` + `primary_email_address_id`.
    # Mirrors the user.created/updated webhook event shape (routes_clerk.py).
    addrs = payload.get("email_addresses") or []
    primary_id = payload.get("primary_email_address_id")
    if isinstance(addrs, list):
        if primary_id:
            for a in addrs:
                if isinstance(a, dict) and a.get("id") == primary_id:
                    em = a.get("email_address")
                    if isinstance(em, str) and "@" in em:
                        return em
        # Fallback: first email if no primary_id match.
        for a in addrs:
            if isinstance(a, dict):
                em = a.get("email_address")
                if isinstance(em, str) and "@" in em:
                    return em
    return None


def _resolve_user_id(clerk_user_id, email):
    """Map Clerk user ID (string) → internal int User.id. Lazy-provisions on first sign-in
    so the webhook (v3.0.4) is not a hard prereq for basic auth.

    Returns int User.id on success, None on failure.
    """
    if not clerk_user_id:
        return None
    session = None
    try:
        from emr_automation.database import get_session
        from emr_automation.models import User
        from sqlalchemy.exc import IntegrityError

        session = get_session()
        user = session.query(User).filter_by(clerk_user_id=clerk_user_id).first()
        if user is None:
            # Email-resolution order at lazy-provisioning time:
            #   1. Caller-provided email (from JWT claim — see
            #      _extract_email_from_clerk_payload).
            #   2. Clerk Users API lookup as fallback — costs one HTTP round-
            #      trip but only runs once per user (on the very first
            #      authenticated request). Without this, every fresh DB
            #      provisions @unknown.local rows that break billing
            #      receipts, password-reset, plan-upgrade emails, and
            #      manual support lookups. The 2026-05-25 incident was
            #      diagnosed via the @unknown.local placeholder triggering
            #      a 429 paywall against a doctor who had been promoted to
            #      `pro` manually only after the placeholder was noticed.
            #   3. @unknown.local placeholder as absolute last resort —
            #      keeps provisioning survivable when both Clerk SDK and
            #      Users API are unreachable.
            resolved_email = email
            if not resolved_email:
                resolved_email = _fetch_clerk_user_email(clerk_user_id)
            if not resolved_email:
                resolved_email = f"{clerk_user_id}@unknown.local"
                logger.warning(
                    "lazy-provisioning with placeholder email — JWT had no "
                    "email claim and Clerk Users API lookup failed: "
                    "clerk_user_id=%s", clerk_user_id,
                )
            user = User(
                clerk_user_id=clerk_user_id,
                email=resolved_email,
                plan="free",
                # Empty string — works on both pre-v3.0 (NOT NULL) and post-v3.0
                # (NULLable) schemas. Clerk owns password storage; this column is
                # vestigial in the Clerk-only flow and gets dropped in v3.0.4.
                password_hash="",
                trial_ends_at=User.default_trial_end(),
            )
            session.add(user)
            try:
                session.commit()
                logger.info(
                    "lazy-provisioned user from Clerk: clerk_user_id=%s email=%s id=%s",
                    clerk_user_id, user.email, user.id,
                )
            except IntegrityError:
                # Bug 73: a concurrent first-request from the SAME new user won the
                # provisioning race and already inserted the row (clerk_user_id is
                # UNIQUE). get_session() is a thread-local scoped_session, so leaving
                # it in a PendingRollback state here would 500 the route handler's
                # next query. Roll back our failed INSERT and adopt the winner's row.
                session.rollback()
                user = session.query(User).filter_by(clerk_user_id=clerk_user_id).first()
                if user is None:
                    return None
        elif user.email and user.email.endswith("@unknown.local"):
            # Heal an existing placeholder row on the next authenticated
            # request. The Mac Mini DB had `users.id=1` with the placeholder
            # email until 2026-05-25 when it was hand-patched via SQL.
            # Backfilling automatically eliminates that manual step.
            real_email = email or _fetch_clerk_user_email(clerk_user_id)
            if real_email and not real_email.endswith("@unknown.local"):
                logger.info(
                    "backfilling placeholder email: clerk_user_id=%s "
                    "old=%s new=%s", clerk_user_id, user.email, real_email,
                )
                user.email = real_email
                session.commit()
        return user.id
    except Exception as e:
        # Never leave the thread-local scoped session in a failed/PendingRollback
        # state — the route handler reuses the SAME session and would 500 on its
        # next query. Roll back defensively before returning None.
        if session is not None:
            try:
                session.rollback()
            except Exception:
                pass
        logger.error("user provisioning failed for %s: %s", clerk_user_id, e)
        return None


def require_auth(f):
    """Decorator: require valid Clerk-issued JWT in Authorization header."""
    @wraps(f)
    def decorated(*args, **kwargs):
        clerk_user_id, email = _verify_clerk_jwt()
        if not clerk_user_id:
            return jsonify({"error": "Authentication required"}), 401
        user_id = _resolve_user_id(clerk_user_id, email)
        if user_id is None:
            return jsonify({"error": "User provisioning failed"}), 500
        g.user_id = user_id
        g.clerk_user_id = clerk_user_id
        g.email = email
        return f(*args, **kwargs)
    return decorated


def optional_auth(f):
    """Decorator: extract user_id from Clerk JWT if present, but don't require it."""
    @wraps(f)
    def decorated(*args, **kwargs):
        clerk_user_id, email = _verify_clerk_jwt()
        g.user_id = _resolve_user_id(clerk_user_id, email) if clerk_user_id else None
        g.clerk_user_id = clerk_user_id
        g.email = email
        return f(*args, **kwargs)
    return decorated


# ---------------------------------------------------------------------------
# SSE cookie auth (CHRA-2217 / CHRA-2335)
# ---------------------------------------------------------------------------
# EventSource cannot attach an Authorization header, so the same-origin
# dashboard SSE stream (/api/events) is gated by a signed, HttpOnly,
# SameSite=Strict cookie minted when the dashboard index page is served.
# itsdangerous ships with Flask — no new dependency.

SSE_COOKIE = "tfd_sse"
SSE_TTL = 12 * 3600
SSE_SALT = "tfd-sse-v1"


def _sse_serializer():
    """Build the timed serializer used to sign/verify the SSE cookie.

    Keyed on SECRET_KEY (app config first, then env, then a 'dev' fallback so
    local/dev boots without configuration). The salt namespaces this token so
    it can never be confused with any other itsdangerous token in the app.
    """
    from itsdangerous import URLSafeTimedSerializer
    secret = (
        current_app.config.get("SECRET_KEY")
        or os.environ.get("SECRET_KEY")
        or "dev"
    )
    return URLSafeTimedSerializer(secret, salt=SSE_SALT)


def mint_sse_cookie(resp):
    """Attach a signed SSE auth cookie to `resp`.

    HttpOnly (no JS access), SameSite=Strict (never sent cross-site, so a
    third-party page can't open the live patient stream), Secure when the
    request is HTTPS, and scoped to path=/api/events so it is only ever sent
    to the SSE endpoint. Returns the same response for chaining.
    """
    resp.set_cookie(
        SSE_COOKIE,
        _sse_serializer().dumps({"k": "sse"}),
        max_age=SSE_TTL,
        httponly=True,
        samesite="Strict",
        secure=request.is_secure,
        path="/api/events",
    )
    return resp


def _try_bearer_auth() -> bool:
    """Attempt Bearer-token auth (shared EXTENSION_API_KEY or Clerk JWT).

    Extracted from require_extension_or_user so both it and require_sse_auth
    share one code path. Sets the same g.* attributes on success and returns
    True iff the request carried a valid Bearer credential, else False. The
    caller is responsible for initializing the g.* defaults first.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False
    token = auth_header[7:]

    # Path 1: shared extension API key (constant-time compare).
    extension_key = os.environ.get("EXTENSION_API_KEY", "").strip()
    if extension_key and _const_time_eq(token, extension_key):
        g.is_extension = True
        return True

    # Path 2: Clerk-issued JWT.
    clerk_user_id, email = _verify_clerk_jwt()
    if clerk_user_id:
        g.user_id = _resolve_user_id(clerk_user_id, email)
        g.clerk_user_id = clerk_user_id
        g.email = email
        return True

    return False


def require_extension_or_user(f):
    """Decorator for chrome-extension-facing endpoints.

    Accepts EITHER:
      1. A valid Clerk-issued JWT (preferred — sets g.user_id from clerk_user_id lookup), OR
      2. The shared EXTENSION_API_KEY env var (sets g.user_id=None, g.is_extension=True)
         — preserved as escape hatch for self-hosted single-tenant deployments.

    Enforcement is gated by TOCAFICHADR_AUTH_REQUIRED:
      - "true": missing/invalid auth → 401
      - otherwise: optional_auth fallback (deploy-safe default)
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        g.user_id = None
        g.clerk_user_id = None
        g.email = None
        g.is_extension = False

        if _try_bearer_auth():
            return f(*args, **kwargs)

        require_auth_flag = os.environ.get("TOCAFICHADR_AUTH_REQUIRED", "").strip().lower()
        if require_auth_flag in ("true", "1", "yes"):
            return jsonify({
                "error": "Authentication required. Sign in via the extension popup.",
                "code": "AUTH_REQUIRED",
            }), 401

        # Gate is off — preserve optional_auth fallback semantics.
        return f(*args, **kwargs)
    return decorated


def require_sse_auth(f):
    """Decorator for the same-origin SSE stream (/api/events).

    EventSource can't send an Authorization header, so this accepts a signed
    SSE cookie (tfd_sse) in addition to the normal Bearer paths. Order:
      1. Bearer (EXTENSION_API_KEY or Clerk JWT) — for non-browser consumers.
      2. Signed tfd_sse cookie minted by mint_sse_cookie() on the dashboard.
      3. Gate: TOCAFICHADR_AUTH_REQUIRED on → 401; off → back-compat pass-through.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        g.user_id = None
        g.clerk_user_id = None
        g.email = None
        g.is_extension = False

        if _try_bearer_auth():
            return f(*args, **kwargs)

        ck = request.cookies.get(SSE_COOKIE)
        if ck:
            try:
                _sse_serializer().loads(ck, max_age=SSE_TTL)
                return f(*args, **kwargs)
            except Exception:
                pass

        require_auth_flag = os.environ.get("TOCAFICHADR_AUTH_REQUIRED", "").strip().lower()
        if require_auth_flag in ("true", "1", "yes"):
            return jsonify({
                "error": "Authentication required.",
                "code": "AUTH_REQUIRED",
            }), 401

        # Gate off → back-compat pass-through.
        return f(*args, **kwargs)
    return decorated


def _const_time_eq(a: str, b: str) -> bool:
    """Constant-time string comparison to avoid timing side channels on the
    shared EXTENSION_API_KEY check."""
    if len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a, b):
        diff |= ord(x) ^ ord(y)
    return diff == 0
