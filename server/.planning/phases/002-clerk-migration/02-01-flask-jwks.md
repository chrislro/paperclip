# Plan 02-01 — Flask JWKS verify

> **Repo**: `Pediatrics/` (cross-repo work; this plan is a coordination artifact in the extension repo)
> **Effort**: 1-2 h
> **Blocks**: 02-02, 02-04
> **Blocked by**: 02-00 (need `CLERK_JWKS_URL`, `CLERK_SECRET_KEY`, dev extension ID)

## Goal

Replace the HS256 verify path in `Pediatrics/emr_automation/auth.py` with a Clerk JWKS verify path. Keep all decorator names + signatures stable so call sites in `routes.py`, `routes_billing.py` need zero changes during the cutover.

## Files changed

| File | Change | LOC delta |
|------|--------|-----------|
| `Pediatrics/requirements.txt` | + `clerk-backend-api>=1.0.0` | +1 |
| `Pediatrics/emr_automation/auth.py` | Rewrite — drop HS256 logic, use Clerk SDK `authenticate_request()` | -120 / +60 |
| `Pediatrics/emr_automation/dashboard/routes_auth.py` | DELETE — Clerk hosts the auth UI | -82 |
| `Pediatrics/emr_automation/dashboard/app.py` | Drop `auth_bp` blueprint registration | -1 |
| `Pediatrics/emr_automation/keychain_helper.py` | Add `pedbot-clerk-secret-key` lookup | +5 |
| `Pediatrics/.env.example` | Document `CLERK_*` env vars | +5 |
| `Pediatrics/emr_automation/models.py` | Add `clerk_user_id VARCHAR(255) UNIQUE NULLABLE`; drop `password_hash` (alembic migration) | +2 / -1 |
| `Pediatrics/alembic/versions/<new>_add_clerk_user_id.py` | New migration | +30 |

Net: **~250 LOC removed, ~100 LOC added**.

## New `auth.py` shape

```python
"""Clerk JWT verification for Toca Ficha Dr. cloud API."""
import os
import logging
from functools import wraps

from flask import request, g, jsonify
from clerk_backend_api import Clerk
from clerk_backend_api.security import authenticate_request
from clerk_backend_api.security.types import AuthenticateRequestOptions

from keychain_helper import keychain_secret

logger = logging.getLogger(__name__)

_CLERK_CLIENT = None


def _get_clerk_client():
    """Lazy singleton — initialized on first use, reused for the lifetime of the worker."""
    global _CLERK_CLIENT
    if _CLERK_CLIENT is None:
        secret = os.environ.get("CLERK_SECRET_KEY")
        if not secret:
            try:
                secret = keychain_secret("pedbot-clerk-secret-key")
            except SystemExit:
                raise RuntimeError(
                    "CLERK_SECRET_KEY not in env or Keychain. "
                    "Set via `security add-generic-password -s pedbot-clerk-secret-key -a clerk -w '<sk_live_...>'`"
                )
        _CLERK_CLIENT = Clerk(bearer_auth=secret)
    return _CLERK_CLIENT


def _authorized_parties():
    """Origins that Clerk will accept JWTs from. Extended at deploy time."""
    raw = os.environ.get(
        "CLERK_AUTHORIZED_PARTIES",
        # Sensible defaults — chrome-extension origins added per-deployment
        "https://api.tocafichadr.com.br,https://prbentogoncalves.g-hosp.com.br",
    )
    return [p.strip() for p in raw.split(",") if p.strip()]


def _verify_clerk_jwt():
    """Verify the request's bearer token against Clerk JWKS.
    Returns (user_id, email) on success, (None, None) on failure.
    Logs the failure reason at WARNING for diagnostic purposes."""
    try:
        clerk = _get_clerk_client()
        # The SDK reads Authorization: Bearer <token> from the request directly.
        state = clerk.authenticate_request(
            request,
            AuthenticateRequestOptions(authorized_parties=_authorized_parties()),
        )
        if not state.is_signed_in:
            logger.warning("clerk auth: %s", state.reason)
            return None, None
        # Custom session token claim — see CLERK_DASHBOARD_SETUP step 2.
        email = state.payload.get("email")
        return state.payload.get("sub"), email
    except Exception as e:
        logger.warning("clerk auth: unexpected error: %s", e)
        return None, None


def require_auth(f):
    """Decorator: require valid Clerk-issued JWT in Authorization header."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id, email = _verify_clerk_jwt()
        if not user_id:
            return jsonify({"error": "Authentication required"}), 401
        g.user_id = user_id
        g.email = email
        return f(*args, **kwargs)
    return decorated


def optional_auth(f):
    """Decorator: extract user_id from Clerk JWT if present, but don't require it."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id, email = _verify_clerk_jwt()
        g.user_id = user_id
        g.email = email
        return f(*args, **kwargs)
    return decorated


def require_extension_or_user(f):
    """Decorator for chrome-extension-facing endpoints.

    Accepts EITHER:
      1. A valid Clerk-issued JWT (preferred — sets g.user_id from sub claim), OR
      2. The shared EXTENSION_API_KEY env var (sets g.user_id=None, g.is_extension=True)
         — preserved as escape hatch for self-hosted single-tenant deployments.

    Enforcement is gated by TOCAFICHADR_AUTH_REQUIRED:
      - If "true": missing/invalid auth → 401
      - Otherwise: optional_auth fallback (deploy-safe default)
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        g.user_id = None
        g.email = None
        g.is_extension = False

        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]

            # Path 1: shared extension API key (constant-time compare)
            extension_key = os.environ.get("EXTENSION_API_KEY", "").strip()
            if extension_key and _const_time_eq(token, extension_key):
                g.is_extension = True
                return f(*args, **kwargs)

            # Path 2: Clerk-issued JWT
            user_id, email = _verify_clerk_jwt()
            if user_id:
                g.user_id = user_id
                g.email = email
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


def _const_time_eq(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    diff = 0
    for x, y in zip(a, b):
        diff |= ord(x) ^ ord(y)
    return diff == 0
```

**What's gone**: `generate_token`, `generate_refresh_token`, `decode_token`, `_get_secret`. Clerk handles all token issuance and rotation.

## Migration step

```python
# Pediatrics/alembic/versions/<timestamp>_add_clerk_user_id.py
def upgrade():
    op.add_column('users', sa.Column('clerk_user_id', sa.String(255), unique=True, nullable=True))
    op.create_index('ix_users_clerk_user_id', 'users', ['clerk_user_id'], unique=True)
    # password_hash kept NULLABLE for now (drop in v3.0.4 after webhook backfill verifies)
    op.alter_column('users', 'password_hash', nullable=True)
```

## Cutover sequence

1. Deploy Flask change first (Mac Mini): `git pull` + `pip install clerk-backend-api` + `launchctl kickstart -k`. Old extension still works (Bearer token still goes through, but Clerk JWT path will reject the old HS256 — falls through to `EXTENSION_API_KEY` if set, else 401 if `TOCAFICHADR_AUTH_REQUIRED=true`).
2. Set `TOCAFICHADR_AUTH_REQUIRED=false` for cutover window so old extension keeps functioning if user hasn't updated yet.
3. Smoke `/api/health` (no auth) and `/api/transcribe` with a valid Clerk JWT (curl with token from a manual Clerk SignIn).
4. Once 02-02 + 02-03 land and extension is updated, flip `TOCAFICHADR_AUTH_REQUIRED=true`.
5. Once dual-deploy verified, delete `routes_auth.py` and the `auth_bp` registration.

## Verification (acceptance tests)

```bash
# 1. Bad token rejected
curl -H "Authorization: Bearer not-a-real-token" \
  https://api.tocafichadr.com.br/api/transcribe -d '{}'
# Expected: 401, body {"error": "Authentication required..."}

# 2. Old HS256 token from v2.6.x rejected
curl -H "Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9..." \
  https://api.tocafichadr.com.br/api/transcribe -d '{}'
# Expected: 401 (different JWT signature; not a Clerk-issued token)

# 3. Valid Clerk JWT accepted
TOKEN=$(curl ... clerk-frontend-api ...)  # via Clerk SignIn flow
curl -H "Authorization: Bearer $TOKEN" \
  https://api.tocafichadr.com.br/api/transcribe -F audio=@test.webm
# Expected: 200 with transcription

# 4. EXTENSION_API_KEY path still works
curl -H "Authorization: Bearer $EXTENSION_API_KEY" \
  https://api.tocafichadr.com.br/api/transcribe -F audio=@test.webm
# Expected: 200 (g.is_extension=True branch)

# 5. /auth/login is gone
curl https://api.tocafichadr.com.br/auth/login -d '{"email":"x","password":"y"}'
# Expected: 404
```

## Rollback

If JWKS verify breaks production:

1. Set `TOCAFICHADR_AUTH_REQUIRED=false` (already the default — no env var change needed).
2. Set `EXTENSION_API_KEY=<temporary key>` so extension can still post.
3. Update extension `popup.html` config to send `EXTENSION_API_KEY` until Clerk path is fixed.

This rollback path is single-environment-variable; Mac Mini SSH only.

## Out of scope

- Stripe webhook reconciliation (02-04).
- Removing `password_hash` column (02-04 with backfill).
- `routes_billing.py` decorator update (covered by `require_auth` signature stability — no change needed).

## Commit message template

```
feat(auth): Clerk JWKS verification (v3.0.1)

Replace HS256 token issue/verify with Clerk-issued JWTs verified against
Clerk JWKS via clerk-backend-api SDK. Keeps decorator signatures stable;
require_auth/optional_auth/require_extension_or_user unchanged from
caller's perspective.

- Drop generate_token / generate_refresh_token / decode_token (Clerk
  handles issuance and rotation)
- Drop routes_auth.py (Clerk hosts /sign-in, /sign-up, /reset-password)
- Add clerk_user_id column to users table (alembic migration)
- TOCAFICHADR_AUTH_REQUIRED gate preserved for safe cutover

Net: -250 LOC, +100 LOC.

Refs: phase 002 plan 02-01.
```
