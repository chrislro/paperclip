# Toca Ficha Dr. Backend

This directory is the repo-owned home for the Flask API that serves the Chrome
extension. The initial consolidation keeps the historical `emr_automation`
package name to avoid a risky import-only rename during the move.

## Local Setup

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

For local tests and smoke checks, use dummy secrets and a temporary SQLite DB:

```bash
ALLOW_MISSING_OPENAI=1 \
SECRET_KEY=test-secret \
DATABASE_URL=sqlite:////tmp/tocafichadr-test.db \
python -m pytest -q
```

## Run Locally

```bash
ALLOW_MISSING_OPENAI=1 \
SECRET_KEY=test-secret \
DATABASE_URL=sqlite:////tmp/tocafichadr-smoke.db \
python run_dashboard.py
```

Smoke:

```bash
curl -sS http://127.0.0.1:5050/api/health
curl -sS http://127.0.0.1:5050/api/selectors?emr=ghosp
```

## Deployment

`scripts/run_cloud_api.sh` and `scripts/com.tocafichadr.cloud-api.plist` are
copied here for review and now point at:

```text
/Users/christianoliveira/Dev/tocafichadr-extension/backend
```

Do not cut over launchd until the unified repo backend has passed local and Mac
Mini smoke tests.
