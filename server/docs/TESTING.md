# Testing And Release Gates

Updated: 2026-05-15

This document defines the checks required before saying Toca Ficha Dr. is
working, ready to deploy, or ready to submit to the Chrome Web Store.

## Automated Gates

### Extension Gate

Run from the repo root:

```bash
npm test
```

This runs:

- `scripts/selftest.sh`
- `npm run build`
- `node scripts/verify-package.js --root .`

Expected result:

- JS syntax passes.
- `manifest.json` and `content/selectors.json` are valid JSON.
- CID database has no duplicate malformed entries.
- Selector parity check passes.
- Service worker message type parity passes.
- PII console-log scan passes.
- VAD unit tests pass.
- Popup and service worker bundles build.
- Manifest-referenced files exist.

### Production Package Gate

Run from the repo root:

```bash
./scripts/build-package.sh --prod
```

Expected result:

- Creates `tocafichadr-v<manifest.version>.zip`.
- Uses `manifest.prod.json`.
- Runs `verify-package` before zipping.
- Package contains all runtime files referenced by the manifest.
- Package does not contain dev-only hosts:
  - `localhost:5050`
  - `127.0.0.1:5050`
  - Tailscale IPs
  - rotating `trycloudflare.com`
  - gist discovery URL

### Backend Gate

Run from `backend/`:

```bash
ALLOW_MISSING_OPENAI=1 \
SECRET_KEY=test-secret \
DATABASE_URL=sqlite:////tmp/tocafichadr-test.db \
python3 -m pytest -q
```

Expected result:

- `89 passed` as of 2026-05-15.
- Warnings about SQLAlchemy legacy `Query.get()` or Python datetime deprecation
  are known cleanup work, not release blockers.

### SOAP/CID Eval Gate

Run this before changing SOAP prompts, CID prompts, SOAP/CID models, ASR
providers, or provider fallback rules. Use de-identified JSONL cases only; never
use live PHI for a new provider test without explicit approval.

Validate case schema and count without provider calls:

```bash
python backend/scripts/eval_soap_cid.py path/to/cases.jsonl --check-only
```

Run the live eval with configured OpenAI credentials:

```bash
python backend/scripts/eval_soap_cid.py path/to/cases.jsonl
```

Expected result:

- At least 20 de-identified cases unless a smaller emergency patch is explicitly
  accepted.
- No new score `0` critical failures.
- Provider/timing summary captured in the eval output.

### Mac Mini Backend Gate

Run from the MacBook:

```bash
ssh mac-mini env \
  PYTHONPATH=/Users/christianoliveira/Dev/tocafichadr-extension/backend \
  ALLOW_MISSING_OPENAI=1 \
  SECRET_KEY=test-secret \
  DATABASE_URL=sqlite:////tmp/tocafichadr-test.db \
  /Users/christianoliveira/Dev/tocafichadr-extension/backend/venv/bin/python \
  -m pytest -q \
  --rootdir=/Users/christianoliveira/Dev/tocafichadr-extension/backend \
  /Users/christianoliveira/Dev/tocafichadr-extension/backend/tests
```

Use this after backend changes are pulled onto the Mini.

## Public Smoke Tests

Run after deploy or service restart:

```bash
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/api/health
```

Expected:

- `HTTP 200`
- Typical response under 1 second from the MacBook network.

Selector smoke:

```bash
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  'https://api.tocafichadr.com.br/api/selectors?emr=ghosp'
```

Expected:

- `HTTP 200`
- JSON includes `"emr":"ghosp"` and selector keys.

Billing auth smoke:

```bash
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/billing/subscription
```

Expected without auth:

- `HTTP 401`
- Fast response. A timeout here is a production incident.

## Manual Clinical Gate

Use `docs/MANUAL-TESTS.md` for any release that changes:

- content scripts
- DOM automation
- selectors
- audio capture
- SOAP/CID generation
- prescription, atestado, or discharge flows
- extension permissions
- backend API behavior used by the extension

Minimum live-shift smoke before Web Store submission:

- First 10 real patients of a shift.
- Error rate under 5 percent.
- No patient flow over 90 seconds end-to-end.
- No saved clinical output without physician review.

## GitHub Actions

Workflows:

- `.github/workflows/extension.yml`
- `.github/workflows/backend.yml`
- `.github/workflows/pages.yml`

After pushing `main`, verify:

```bash
gh run list --repo chrislro/tocafichadr-extension --branch main --limit 6
```

Latest relevant Backend and Extension checks must pass before declaring the
project green.

## Release Checklist

Before shipping a Web Store zip or deploying backend changes:

- [ ] `git status --short --branch` is clean except intentional files.
- [ ] `npm test` passed locally.
- [ ] Backend pytest passed locally.
- [ ] `./scripts/build-package.sh --prod` passed.
- [ ] Public `/api/health` passed.
- [ ] Public `/api/selectors?emr=ghosp` passed if selectors or package changed.
- [ ] GitHub Actions checks passed.
- [ ] Mac Mini is on the same commit if backend behavior changed.
- [ ] Rollback command or previous commit SHA is known.
- [ ] No PHI, secrets, live DB files, logs, or `.env` files are staged.

## Failure Triage

Use this order when the extension says "Servidor nao respondeu":

1. Check public health endpoint.
2. Check local Mac Mini health endpoint.
3. Check `launchctl list com.tocafichadr.cloud-api`.
4. Tail `backend/logs/cloud-api-error.log`.
5. Check for DB pool exhaustion, auth provisioning errors, OpenAI timeout, or
   Cloudflare tunnel failures.
6. Reproduce with a direct curl to the endpoint the extension was calling.

Recent example: repeated `/billing/subscription` calls timed out because DB
sessions were not released after request teardown. Fixed by ADR 0002.
