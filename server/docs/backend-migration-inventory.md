# Backend Migration Inventory

Date: 2026-05-08

## Strategy

PR 0 preserves the historical `emr_automation` package name. Renaming to
`tocafichadr_api` is deferred to a later import-only PR after backend startup
and tests pass from this repo.

## Copied Into This Repo

- `backend/emr_automation/`
- `backend/keychain_helper.py`
- `backend/run_dashboard.py`
- `backend/requirements.txt`
- `backend/config.ini.example`
- `backend/.env.example`
- `backend/scripts/run_cloud_api.sh`
- `backend/scripts/com.tocafichadr.cloud-api.plist`
- `backend/scripts/init_cloud_db.py`
- `backend/scripts/migrate_add_clerk_user_id.py`
- `backend/Dockerfile.cloud`
- `backend/docker-compose.cloud.yml`
- `backend/data/selectors/ghosp.json`
- focused cloud/backend tests under `backend/tests/`

## Left Behind Intentionally

- `/Users/admin/Dev/Pediatrics/config.ini` because it can contain real local
  credentials.
- `/Users/admin/Dev/Pediatrics/data/*.db` and SQLite sidecars because they can
  contain PHI or operational logs.
- Desktop automation tests not required for the cloud extension backend.
- Old Pediatrics source files, until the unified backend is deployed and smoke
  tested.

## Import And Path Edits

- Top-level `keychain_helper.py` remains top-level in `backend/` for import
  compatibility.
- `backend/emr_automation/__init__.py` was slimmed so backend imports do not
  import desktop automation modules.
- Default SQLite path now resolves to `backend/data/tocafichadr.db` from the
  package path instead of relying on the caller's working directory.
- Launchd/run scripts now target
  `/Users/christianoliveira/Dev/tocafichadr-extension/backend`.
- `backend/realtime_proxy.py` moved to `backend/devtools/realtime_proxy.py`.

## Schema State

Schema-only dumps are committed under `backend/migrations/`:

- `baseline_schema.sql`
- `audit_schema.sql`

No DB rows were copied into Git. Live DB files remain ignored by `.gitignore`.

## Required Smoke Commands

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
ALLOW_MISSING_OPENAI=1 SECRET_KEY=test DATABASE_URL=sqlite:////tmp/tocafichadr-smoke.db \
  python -c "from emr_automation.dashboard.app import create_app; app=create_app(); print(app.test_client().get('/api/health').json)"
```

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
ALLOW_MISSING_OPENAI=1 SECRET_KEY=test DATABASE_URL=sqlite:////tmp/tocafichadr-test.db \
  python -m pytest -q
```
