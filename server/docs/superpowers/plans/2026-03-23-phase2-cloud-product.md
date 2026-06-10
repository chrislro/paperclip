# Phase 2: Cloud API + Monetizable Product — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the Flask backend to the cloud, add authentication and billing, and publish the Chrome extension to the Chrome Web Store so other doctors can install and pay for it.

**Architecture:** Same thin Chrome extension from Phase 1, but pointing to `api.tocafichadr.com.br` instead of `localhost:5050`. Backend adds JWT auth, Stripe billing, PostgreSQL database, and per-EMR selector config storage. Extension adds login flow, auth headers, and usage indicator.

**Tech Stack:** Python 3.11 (Flask), PostgreSQL (Neon or self-hosted), PyJWT, Stripe API, Docker, Railway/Fly.io

**Spec:** `docs/superpowers/specs/2026-03-23-tocafichadr-automation-platform-design.md` (Sections 5.1-5.7, 6.1-6.3)

**Prerequisite:** Phase 1 must be complete and working on real shifts.

---

## File Structure

### New Backend Files (Pediatrics/emr_automation/)

| File | Responsibility | Status |
|------|---------------|--------|
| `auth.py` | JWT registration, login, token refresh, middleware decorator | Create |
| `billing.py` | Stripe checkout, webhooks, subscription status, usage metering | Create |
| `models.py` | SQLAlchemy models (users, subscriptions, usage_logs, selector_configs, audit_trail) | Create |
| `database.py` | PostgreSQL connection, session management, migration helpers | Create |
| `dashboard/routes_auth.py` | Auth blueprint (/auth/register, /auth/login, /auth/refresh) | Create |
| `dashboard/routes_billing.py` | Billing blueprint (/billing/checkout, /billing/webhook, /billing/subscription) | Create |
| `tests/test_auth.py` | Auth module tests | Create |
| `tests/test_billing.py` | Billing module tests | Create |
| `tests/test_models.py` | Database model tests | Create |
| `Dockerfile.cloud` | Cloud-optimized Dockerfile (no Playwright/Tkinter/pynput) | Create |
| `docker-compose.cloud.yml` | Cloud stack: Flask + PostgreSQL + Redis (optional) | Create |
| `alembic/` | Database migration directory | Create |

### Modified Backend Files

| File | Change |
|------|--------|
| `dashboard/app.py` | Register auth + billing blueprints, configure PostgreSQL, add JWT middleware |
| `dashboard/routes.py` | Add `@require_auth` decorator to API routes (optional, skipped if no auth header) |
| `audit_log.py` | Add PostgreSQL adapter alongside SQLite |
| `selector_config.py` | Add PostgreSQL backend alongside JSON file backend |

### Modified Extension Files (pedbot-extension/)

| File | Change |
|------|--------|
| `manifest.json` | Add cloud API domain to host_permissions |
| `content/api-client.js` | Add Authorization header, token refresh logic |
| `content/hud.js` | Add login status indicator, usage badge |
| `popup/popup.html` | Add login/register form, plan display, backend toggle |
| `popup/popup.js` | Add auth flow, plan status display |

---

## Task 1: Database Models + PostgreSQL Setup

**Files:**
- Create: `Pediatrics/emr_automation/database.py`
- Create: `Pediatrics/emr_automation/models.py`
- Create: `Pediatrics/tests/test_models.py`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/admin/Dev/Pediatrics
source "venv 2/bin/activate"
pip install sqlalchemy psycopg2-binary alembic
pip freeze | grep -E "sqlalchemy|psycopg2|alembic" >> requirements.txt
```

- [ ] **Step 2: Write failing tests for models**

Tests for: User creation with password hashing, Subscription creation linked to user, UsageLog creation, SelectorConfig creation with JSONB selectors, AuditTrail creation. Use SQLite in-memory for test database.

- [ ] **Step 3: Run tests to verify they fail**

```bash
python -m pytest tests/test_models.py -v
```

- [ ] **Step 4: Implement database.py**

- `get_engine(db_url)` — creates SQLAlchemy engine (defaults to `DATABASE_URL` env var, falls back to SQLite)
- `get_session()` — returns scoped session
- `init_db()` — creates all tables
- Support both PostgreSQL (production) and SQLite (development/testing)

- [ ] **Step 5: Implement models.py**

SQLAlchemy models matching the spec schema:
- `User` — id, email, password_hash, name, plan (default "free"), stripe_customer_id, trial_ends_at (default: created_at + 14 days), created_at. Methods: `set_password(pw)`, `check_password(pw)` using `werkzeug.security`, `is_trial_active() -> bool`
- `Subscription` — id, user_id (FK), stripe_subscription_id, plan, status, current_period_end, created_at
- `UsageLog` — id, user_id (FK), action, emr_name, created_at
- `SelectorConfig` — id, emr_name, emr_version, selectors (JSON), created_by (FK), created_at, is_active
- `AuditTrail` — id, user_id (FK), action_type, duration_seconds, success, error_message, created_at

- [ ] **Step 6: Run tests to verify they pass**

- [ ] **Step 7: Commit**

```bash
git add emr_automation/database.py emr_automation/models.py tests/test_models.py requirements.txt
git commit -m "feat: add SQLAlchemy models and database module for Phase 2"
```

---

## Task 2: JWT Authentication

**Files:**
- Create: `Pediatrics/emr_automation/auth.py`
- Create: `Pediatrics/emr_automation/dashboard/routes_auth.py`
- Create: `Pediatrics/tests/test_auth.py`

- [ ] **Step 1: Install dependencies**

```bash
pip install PyJWT bcrypt
```

- [ ] **Step 2: Write failing tests**

Tests:
- `test_register_creates_user_with_trial` — POST /auth/register with email+password, assert 201 + JWT returned + user has `trial_ends_at` set 14 days in future
- `test_register_rejects_duplicate_email` — register same email twice, assert 409
- `test_login_returns_jwt` — register then login, assert JWT in response
- `test_login_rejects_wrong_password` — register then login with bad password, assert 401
- `test_protected_route_rejects_no_token` — GET /api/status without Authorization header, assert 401
- `test_protected_route_accepts_valid_token` — GET /api/status with valid JWT, assert 200
- `test_refresh_returns_new_token` — POST /auth/refresh with valid refresh token, assert new JWT
- `test_forgot_password_sends_reset` — POST /auth/forgot-password with valid email, assert 200 (mock email send)
- `test_reset_password_with_valid_token` — POST /auth/reset-password with valid token + new password, assert login works with new password

- [ ] **Step 3: Implement auth.py**

- `generate_token(user_id, expires_hours=24) -> str` — JWT with user_id, exp, iat
- `generate_refresh_token(user_id, expires_days=30) -> str` — longer-lived JWT
- `decode_token(token) -> dict` — validates and decodes JWT, raises on expired/invalid
- `require_auth(f)` — Flask decorator that extracts JWT from `Authorization: Bearer <token>`, sets `g.user_id`. Returns 401 if missing/invalid.
- `optional_auth(f)` — Same but doesn't reject if no token (for Phase 1 compatibility)

Secret key from `JWT_SECRET` env var or Flask `app.secret_key`.

- [ ] **Step 4: Implement routes_auth.py**

Blueprint `auth_bp` with prefix `/auth`:
- `POST /auth/register` — validates email+password, creates User with 14-day Pro trial (`trial_ends_at = now + 14 days`), returns JWT + refresh token
- `POST /auth/login` — validates credentials, returns JWT + refresh token
- `POST /auth/refresh` — validates refresh token, returns new JWT
- `POST /auth/forgot-password` — validates email exists, generates time-limited reset token (stored in DB or JWT with 1h expiry), sends reset link via email. **Note:** Requires email sending — use `resend` or `smtplib` with Gmail SMTP for MVP.
- `POST /auth/reset-password` — validates reset token + new password, updates user password hash

- [ ] **Step 5: Register blueprint in app.py**

In `create_app()`, add:
```python
from emr_automation.dashboard.routes_auth import auth_bp
app.register_blueprint(auth_bp)
```

- [ ] **Step 6: Add `@optional_auth` to existing API routes**

In `routes.py`, add `@optional_auth` decorator to: `/api/transcribe`, `/api/suggest-cid`, `/api/format-soap`, `/api/selectors`, `/api/dosages`. This makes auth optional (Phase 1 still works without auth) but captures `user_id` when present.

- [ ] **Step 7: Run tests**

```bash
python -m pytest tests/test_auth.py -v
```

- [ ] **Step 8: Commit**

```bash
git add emr_automation/auth.py emr_automation/dashboard/routes_auth.py emr_automation/dashboard/app.py emr_automation/dashboard/routes.py tests/test_auth.py requirements.txt
git commit -m "feat: add JWT authentication with register/login/refresh"
```

---

## Task 3: Stripe Billing

**Files:**
- Create: `Pediatrics/emr_automation/billing.py`
- Create: `Pediatrics/emr_automation/dashboard/routes_billing.py`
- Create: `Pediatrics/tests/test_billing.py`

- [ ] **Step 1: Install stripe**

```bash
pip install stripe
```

- [ ] **Step 2: Write failing tests**

Tests (with mocked Stripe API):
- `test_create_checkout_session` — POST /billing/create-checkout, assert Stripe session URL returned
- `test_webhook_subscription_created` — simulate Stripe webhook, assert Subscription created in DB
- `test_webhook_subscription_deleted` — simulate webhook, assert plan reverted to "free"
- `test_get_subscription_status` — GET /billing/subscription, assert plan and usage returned
- `test_free_plan_usage_limit` — log 5 transcribe actions, assert 6th returns 429

- [ ] **Step 3: Implement billing.py**

- `create_checkout_session(user_id, plan, success_url, cancel_url) -> str` — creates Stripe Checkout session, returns URL
- `handle_webhook(payload, sig_header) -> dict` — processes Stripe events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.deleted`, `invoice.payment_succeeded`
- `get_subscription(user_id) -> dict` — returns plan, status, usage today, period end
- `check_usage_limit(user_id) -> bool` — returns True if user can make more API calls. Logic: if user has active Pro/Hospital subscription OR `trial_ends_at > now()`, unlimited. If free plan: 5 transcriptions/day.
- `log_usage(user_id, action, emr_name)` — inserts UsageLog row
- `is_trial_active(user_id) -> bool` — checks if user's 14-day trial is still active

Stripe keys from env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_HOSPITAL_PRICE_ID`

- [ ] **Step 4: Implement routes_billing.py**

Blueprint `billing_bp` with prefix `/billing`:
- `POST /billing/create-checkout` — requires auth, creates Stripe session
- `POST /billing/webhook` — verifies Stripe signature, processes event
- `GET /billing/subscription` — requires auth, returns subscription status + usage

- [ ] **Step 5: Add usage metering to API routes**

In `routes.py`, add usage check **before** processing the request (not after, to avoid wasting OpenAI API costs):
```python
# At the TOP of api_transcribe(), BEFORE calling transcribe_audio():
if g.get("user_id"):
    from emr_automation.billing import check_usage_limit, log_usage
    if not check_usage_limit(g.user_id):
        return jsonify({"error": "Daily limit reached", "upgrade": True}), 429

# ... process transcription ...

# AFTER successful transcription, log usage:
if g.get("user_id"):
    log_usage(g.user_id, "transcribe", request.form.get("emr", "ghosp"))
```

- [ ] **Step 6: Run tests**

```bash
python -m pytest tests/test_billing.py -v
```

- [ ] **Step 7: Commit**

```bash
git add emr_automation/billing.py emr_automation/dashboard/routes_billing.py tests/test_billing.py requirements.txt
git commit -m "feat: add Stripe billing with checkout, webhooks, usage metering"
```

---

## Task 4: Selector Config — PostgreSQL Backend

**Files:**
- Modify: `Pediatrics/emr_automation/selector_config.py`
- Create: `Pediatrics/tests/test_selector_config_db.py`

- [ ] **Step 1: Write failing tests**

Tests:
- `test_load_selectors_from_db` — insert SelectorConfig row, load by emr_name, assert matches
- `test_db_fallback_to_json` — no DB row, falls back to JSON file
- `test_save_selectors_to_db` — save new config, load it back

- [ ] **Step 2: Extend selector_config.py**

Add:
- `load_selectors_from_db(emr_name) -> Optional[dict]` — queries SelectorConfig table for latest active config
- `save_selectors_to_db(emr_name, version, selectors, user_id) -> int` — inserts new config row
- Modify `load_selectors()` to try DB first, then fall back to JSON file

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git add emr_automation/selector_config.py tests/test_selector_config_db.py
git commit -m "feat: add PostgreSQL backend for selector configs"
```

---

## Task 5: Cloud Deployment Configuration

**Files:**
- Create: `Pediatrics/Dockerfile.cloud`
- Create: `Pediatrics/docker-compose.cloud.yml`
- Create: `Pediatrics/.env.example.cloud`

- [ ] **Step 1: Create Dockerfile.cloud**

Based on existing Dockerfile but:
- No Playwright, Tkinter, pynput, pyaudio dependencies
- Only Flask + API dependencies
- Entry point: `gunicorn emr_automation.dashboard.app:create_app() --bind 0.0.0.0:5050`
- Install gunicorn

- [ ] **Step 2: Create docker-compose.cloud.yml**

Services:
- `api` — builds from Dockerfile.cloud, ports 5050, env vars from `.env`
- `db` — postgres:16, volume for persistence, port 5432

- [ ] **Step 3: Create .env.example.cloud**

```
DATABASE_URL=postgresql://tocafichadr:password@db:5432/tocafichadr
JWT_SECRET=change-me-to-random-string
OPENAI_API_KEY=sk-...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_HOSPITAL_PRICE_ID=price_...
```

- [ ] **Step 4: Test locally with docker-compose**

```bash
cd /Users/admin/Dev/Pediatrics
docker-compose -f docker-compose.cloud.yml up --build
curl http://localhost:5050/api/health
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.cloud docker-compose.cloud.yml .env.example.cloud
git commit -m "feat: add cloud deployment config (Docker + PostgreSQL)"
```

---

## Task 6: Extension — Auth Flow + Cloud Toggle

**Files:**
- Modify: `pedbot-extension/manifest.json`
- Modify: `pedbot-extension/content/api-client.js`
- Modify: `pedbot-extension/popup/popup.html`
- Modify: `pedbot-extension/popup/popup.js`
- Modify: `pedbot-extension/content/hud.js`

- [ ] **Step 1: Update manifest.json**

Add cloud API domain to host_permissions:
```json
"host_permissions": [
  "*://prbentogoncalves.g-hosp.com.br/*",
  "http://localhost:5050/*",
  "https://api.tocafichadr.com.br/*"
]
```

- [ ] **Step 2: Add auth to api-client.js**

Add:
- `setToken(jwt)` / `getToken()` — stores in closure + chrome.storage.local
- `login(email, password) -> Promise<{token, refresh_token}>` — POST /auth/login
- `register(email, password, name) -> Promise<{token, refresh_token}>` — POST /auth/register
- `refreshToken() -> Promise<{token}>` — POST /auth/refresh
- Modify `request()` to add `Authorization: Bearer <token>` header when token is set
- Auto-refresh token on 401 response (one retry)

- [ ] **Step 3: Add login form to popup**

Update `popup/popup.html`:
- Add "Backend" toggle: Local / Cloud radio buttons
- Add login section (hidden when Local selected): email, password, login/register buttons
- Add plan status display: current plan, usage count, upgrade link
- Add logout button

Update `popup/popup.js`:
- Backend toggle switches `apiBaseUrl` between localhost and cloud URL
- Login flow: calls `api.login()`, stores token, shows plan status
- Register flow: calls `api.register()`, stores token
- On popup open: check stored token, show login form or plan status

- [ ] **Step 4: Add auth status to HUD**

Modify `hud.js`:
- Show user name + plan badge next to connection dot (when authenticated)
- Show usage count for free plan users (e.g., "3/5 today")

- [ ] **Step 5: Test both modes**

1. Set backend to "Local" — all features work without auth (Phase 1 mode)
2. Set backend to "Cloud" — login required, auth headers sent, plan status shown

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/Dev/pedbot-extension
git add manifest.json content/api-client.js content/hud.js popup/popup.html popup/popup.js
git commit -m "feat: add auth flow, cloud toggle, plan status to extension"
```

---

## Task 7: Chrome Web Store Preparation

**Files:**
- Create: `pedbot-extension/icons/icon16.png`
- Create: `pedbot-extension/icons/icon48.png`
- Create: `pedbot-extension/icons/icon128.png`
- Create: `pedbot-extension/PRIVACY_POLICY.md`
- Create: `pedbot-extension/store/description.txt`
- Create: `pedbot-extension/store/screenshots/` (directory)

- [ ] **Step 1: Create PNG icons**

Create proper PNG icons at 16x16, 48x48, 128x128 pixels. Design: stethoscope + robot icon in emerald green (#10b981) on transparent background.

- [ ] **Step 2: Write privacy policy**

`PRIVACY_POLICY.md` in Portuguese covering:
- What data is collected (user accounts, usage counts)
- What data is NOT collected (patient names, audio files, SOAP notes)
- How audio is processed (transient: sent to API, transcribed, discarded)
- OpenAI data processing agreement
- LGPD compliance statement
- Contact information

This will be hosted at `tocafichadr.com.br/privacidade` for Chrome Web Store listing.

- [ ] **Step 3: Write store description**

Portuguese description for Chrome Web Store:
- What Toca Ficha Dr. does (EMR automation for pediatric consultations)
- Key features (voice transcription, SOAP formatting, CID suggestion, one-click finalization)
- Supported EMR (G-Hosp)
- Pricing (free tier + pro)

- [ ] **Step 4: Capture screenshots**

Take screenshots of:
- HUD panel on G-Hosp page
- Recording state
- CID suggestion
- Settings popup

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Dev/pedbot-extension
git add icons/ PRIVACY_POLICY.md store/
git commit -m "feat: add Chrome Web Store assets (icons, privacy policy, description)"
```

---

## Task 8: Deploy to Cloud

- [ ] **Step 1: Choose deployment platform**

Recommended: Railway (easiest) or Fly.io (best latency for Brazil).

For Railway:
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway add --plugin postgresql
```

For Fly.io:
```bash
fly launch --region gru  # São Paulo
fly postgres create
```

- [ ] **Step 2: Set environment variables**

Set all vars from `.env.example.cloud` in the deployment platform.

- [ ] **Step 3: Deploy**

```bash
# Railway
railway up

# Or Fly.io
fly deploy
```

- [ ] **Step 4: Verify deployment**

```bash
curl https://api.tocafichadr.com.br/api/health
```

- [ ] **Step 5: Configure Stripe webhooks**

In Stripe Dashboard, add webhook endpoint: `https://api.tocafichadr.com.br/billing/webhook`
Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.deleted`, `invoice.payment_succeeded`

- [ ] **Step 6: Update extension cloud URL**

Update the default cloud URL in `popup.js` to the actual deployed URL.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: configure cloud deployment"
```

---

## Task 9: Publish Extension to Chrome Web Store

- [ ] **Step 1: Create Chrome Web Store developer account**

Pay $5 one-time fee at https://chrome.google.com/webstore/devconsole

- [ ] **Step 2: Package extension**

```bash
cd /Users/admin/Dev/pedbot-extension
zip -r pedbot-extension.zip . -x ".git/*" -x ".superpowers/*" -x "docs/*" -x "store/*" -x "*.bak"
```

- [ ] **Step 3: Submit for review**

1. Upload ZIP to Chrome Web Store
2. Fill in store listing (Portuguese)
3. Upload screenshots
4. Link privacy policy URL
5. Justify permissions (activeTab, storage, scripting)
6. Submit for review

- [ ] **Step 4: Wait for approval (typically 1-3 business days)**

---

## Task 10: Beta Launch — Onboard Colleagues

- [ ] **Step 1: Create free accounts for 5-10 colleagues**

Use `/auth/register` endpoint or admin script to pre-create accounts.

- [ ] **Step 2: Share extension link**

Send Chrome Web Store URL to colleagues at your UPA.

- [ ] **Step 3: Gather feedback**

Track: completion rate, errors, time-per-patient, feature requests.

- [ ] **Step 4: Iterate based on feedback**

Fix selector issues, adjust SOAP prompts, update CID suggestions based on real usage.

---

## Dependency Graph

```
Task 1 (DB models) ──────┐
                          ├── Task 2 (JWT auth)
                          ├── Task 3 (Stripe billing)
                          ├── Task 4 (Selector DB backend)
                          │
Task 5 (Docker/cloud) ───┤
                          │
Tasks 2+3+4 ──── Task 6 (Extension auth + cloud toggle)
                          │
                 Task 7 (Store assets) ──── Task 9 (Publish)
                          │
                 Task 8 (Deploy to cloud)
                          │
                 Task 10 (Beta launch)
```

**Tasks 1, 5, 7 can run in parallel.** Tasks 2, 3, 4 depend on 1. Task 6 depends on 2+3. Tasks 8+9 are sequential at the end.
