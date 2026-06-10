# Toca Ficha Dr. — Railway Deployment Guide

> Last updated: 2026-03-24
> Backend repo: `~/Dev/Pediatrics/`
> Extension repo: `~/Dev/pedbot-extension/`

This guide walks through deploying the Flask backend to Railway so Cloud mode works for all users.
Run these commands in order. Steps marked **(manual)** require browser or interactive terminal input.

---

## Prerequisites

- [ ] Railway account — sign up at https://railway.app
- [ ] Railway CLI installed: `npm install -g @railway/cli`
- [ ] Stripe account with a Product + Price created (see Step 3)
- [ ] Domain `tocafichadr.com.br` purchased and DNS accessible
- [ ] OpenAI API key ready

---

## Step 1 — Install Railway CLI and Login

```bash
npm install -g @railway/cli
railway login          # opens browser for OAuth
```

Verify login:
```bash
railway whoami         # should print your email
```

---

## Step 2 — Create Railway Project

```bash
cd ~/Dev/Pediatrics
railway init           # select "Empty Project", name it "tocafichadr-api"
```

**(manual)** In the Railway dashboard:
1. Open the new project
2. Click **+ Add Service** → **Database** → **PostgreSQL**
3. Wait for it to provision (30–60 sec)
4. Note the `DATABASE_URL` from the PostgreSQL service variables

---

## Step 3 — Set Up Stripe **(manual)**

1. Go to https://dashboard.stripe.com
2. Create a Product: **"Toca Ficha Dr. Pro"**
   - Price: R$49/mês, recurring, BRL
   - Copy the `price_XXXX` ID → this is `STRIPE_PRICE_ID`
3. After deployment (Step 6), register the webhook endpoint:
   - URL: `https://api.tocafichadr.com.br/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.deleted`
   - Copy the `whsec_XXXX` signing secret → this is `STRIPE_WEBHOOK_SECRET`

---

## Step 4 — Set Environment Variables

```bash
# Run each line separately, replacing placeholder values
railway variables set OPENAI_API_KEY=sk-...
railway variables set JWT_SECRET=$(openssl rand -hex 32)
railway variables set STRIPE_SECRET_KEY=sk_live_...
railway variables set STRIPE_WEBHOOK_SECRET=whsec_...   # set after Step 6
railway variables set STRIPE_PRICE_ID=price_...
railway variables set FLASK_ENV=production
```

The `DATABASE_URL` is auto-injected by Railway from the PostgreSQL plugin — do NOT set it manually.

**Variable reference:**

| Variable                  | Where to get it                         | Required |
|---------------------------|-----------------------------------------|----------|
| `OPENAI_API_KEY`          | https://platform.openai.com/api-keys   | Yes      |
| `JWT_SECRET`              | `openssl rand -hex 32`                  | Yes      |
| `STRIPE_SECRET_KEY`       | Stripe Dashboard → Developers → API Keys| Yes      |
| `STRIPE_WEBHOOK_SECRET`   | Stripe Dashboard → Webhooks             | After deploy |
| `STRIPE_PRICE_ID`         | Stripe Dashboard → Product catalog      | Yes      |
| `DATABASE_URL`            | Auto-injected by Railway PostgreSQL     | Auto     |
| `FLASK_ENV`               | Set to `production`                     | Yes      |

---

## Step 5 — Deploy

```bash
cd ~/Dev/Pediatrics
railway up
```

Railway detects `Dockerfile.cloud` automatically. First deploy takes ~3 minutes.

Watch logs:
```bash
railway logs --tail
```

Expected output:
```
[gunicorn] Booting worker with pid: ...
[gunicorn] Arbiter booted
```

---

## Step 6 — Get Deployment URL and Set DNS **(manual)**

1. In Railway dashboard, click the service → **Settings** → **Domains**
2. Note the auto-generated URL (e.g., `tocafichadr-api-production.up.railway.app`)
3. Go to your DNS provider for `tocafichadr.com.br`
4. Add a CNAME record:
   - Name: `api`
   - Value: `tocafichadr-api-production.up.railway.app`
   - TTL: 300
5. In Railway: **Settings** → **Domains** → **+ Custom Domain** → `api.tocafichadr.com.br`
6. Railway handles HTTPS automatically via Let's Encrypt

Propagation takes 5–30 minutes. Test with:
```bash
curl https://api.tocafichadr.com.br/api/health
# Expected: {"status": "ok", "mode": "cloud"}
```

---

## Step 7 — Initialize the Database

Run once after first deploy:

```bash
railway run python -c "
from emr_automation.database import engine
from emr_automation.models import Base
Base.metadata.create_all(engine)
print('All tables created.')
"
```

Expected output: `All tables created.`

---

## Step 8 — Seed the Selector Config

```bash
railway run python -c "
from emr_automation.database import SessionLocal
from emr_automation.models import SelectorConfig
import json, pathlib

db = SessionLocal()
existing = db.query(SelectorConfig).filter_by(emr_name='ghosp').first()
if existing:
    print('Already seeded.')
else:
    data = json.loads(pathlib.Path('data/selectors/ghosp.json').read_text())
    row = SelectorConfig(emr_name='ghosp', version='1.0', selectors=data, is_active=True)
    db.add(row)
    db.commit()
    print('Selectors seeded for ghosp.')
"
```

---

## Step 9 — Register the Stripe Webhook **(manual)**

Now that the API is live:

1. Go to Stripe Dashboard → Developers → Webhooks → **+ Add endpoint**
2. URL: `https://api.tocafichadr.com.br/billing/webhook`
3. Events to send: `checkout.session.completed`, `customer.subscription.deleted`
4. Copy the `whsec_XXXX` signing secret
5. Update the Railway variable:

```bash
railway variables set STRIPE_WEBHOOK_SECRET=whsec_...
railway up   # redeploy to pick up new variable
```

---

## Step 10 — Point the Extension at Cloud

The extension already has `CLOUD_URL = "https://api.tocafichadr.com.br"` hardcoded in `popup/popup.js`.

Test from the extension:
1. Open popup → select **Cloud** mode
2. Click **Testar** → should show "Conectado" with a green dot
3. Register an account → 14-day trial starts automatically
4. Record a consultation → SOAP should be generated

---

## Step 11 — Set Up Monitoring (optional but recommended)

**UptimeRobot (free):**
1. Go to https://uptimerobot.com → Add New Monitor
2. Type: HTTP(s)
3. URL: `https://api.tocafichadr.com.br/api/health`
4. Interval: 5 minutes
5. Alert contact: your email

**Stripe webhooks health:**
- Stripe Dashboard → Developers → Webhooks → your endpoint shows delivery history

---

## Updating After Code Changes

```bash
cd ~/Dev/Pediatrics
git add -A && git commit -m "fix: ..."
railway up
```

Railway auto-detects the push and redeploys. Zero-downtime via gunicorn worker rotation.

---

## Rollback

```bash
# In Railway dashboard: Deployments tab → click any previous deploy → Rollback
# Or via CLI:
railway rollback
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `502 Bad Gateway` | Gunicorn not starting | `railway logs` — check for import errors |
| `{"error": "Invalid API key"}` | OPENAI_API_KEY not set | `railway variables set OPENAI_API_KEY=sk-...` |
| `{"error": "DB connection failed"}` | PostgreSQL not provisioned | Add PostgreSQL plugin in Railway dashboard |
| `stripe.error.SignatureVerificationError` | STRIPE_WEBHOOK_SECRET wrong | Re-copy from Stripe dashboard, `railway variables set ...` |
| CID selectors 404 from extension | DB not seeded | Re-run Step 8 |
| Extension shows "Desconectado" | DNS not propagated | Wait 30 min, check CNAME with `dig api.tocafichadr.com.br` |

---

## Local Development (for reference)

```bash
cd ~/Dev/Pediatrics
source "venv 2/bin/activate"
python -m emr_automation --dashboard
# Runs on http://localhost:5050
```

Requires `~/Dev/Pediatrics/.env`:
```
OPENAI_API_KEY=sk-...
```
