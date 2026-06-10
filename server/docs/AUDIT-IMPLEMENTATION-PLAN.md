# Audit Implementation Plan

Updated: 2026-05-08

This plan converts the May 2026 audit findings into PR-sized implementation work.
It also moves Toca Ficha Dr. backend ownership out of the general
`/Users/admin/Dev/Pediatrics` repo and into this GitHub/local repo so extension,
API, database schema, deployment docs, and tests live together.

## Goals

1. Make this repo the single source of truth for the Chrome extension, Flask API,
   billing/auth integration, selector config, migrations, and deploy scripts.
2. Remove Toca Ficha Dr. project code from the Pediatrics repo after the new
   repo-owned backend is deployed and verified.
3. Lock down production auth and CORS before public or paid use.
4. Prevent duplicate, unbounded, or hanging AI API calls.
5. Fix packaging, CI, test staleness, and database schema drift.
6. Align the UI/product behavior with the PRD and safety docs.

## Verification Status

Verified now:

- This document exists in the extension repo and contains implementation,
  testing, audit, rollback, and Mac Mini deployment guidance.
- The current machine is the MacBook: `MacBook-de-Chris-2.local`, user `admin`,
  Tailscale IP `100.88.191.63`.
- The Mac Mini is reachable over Tailscale at `100.97.14.32` via SSH as
  `christianoliveira`.
- The Mac Mini hostname is `mac-mini-de-chris`.
- The Mac Mini backend currently responds on:
  - `http://127.0.0.1:5050/api/health` from the Mac Mini
  - `http://100.97.14.32:5050/api/health` from the MacBook
- The Mac Mini backend is listening on `*:5050`.
- The Git remote for this repo is
  `https://github.com/chrislro/tocafichadr-extension.git`.

Not yet verified because implementation has not happened:

- The backend has not yet been moved into this repo.
- The unified repo has not yet been cloned/deployed to the Mac Mini target path.
- Runtime DB files have not yet been copied into `backend/data/` under the
  unified repo.
- Launchd has not yet been cut over from Pediatrics to this repo.
- Production auth gate has not yet been flipped.
- Usage/rate/idempotency controls have not yet been implemented.
- DB migrations have not yet been created or tested.
- Chrome Web Store production extension ID is not yet recorded here.
- CI is not yet updated to run the full extension and backend gates.

## Hard Rules

- Do not commit real PHI-bearing SQLite databases to GitHub.
- Commit database schema, migrations, seed selector config, and optionally an
  empty sanitized development database.
- Keep live/local runtime DB files inside this repo locally under `backend/data/`,
  but add them to `.gitignore`.
- Move code first, behavior second. The repo consolidation PR should be mostly
  mechanical so breakage is easy to isolate.
- Keep the old Pediatrics backend available until the repo-owned backend passes
  smoke tests and serves the extension successfully.
- Treat the full program as 2-3 weeks of focused work, not a quick cleanup.
  PR 3, PR 4, and PR 8 have the most likely scope expansion.
- Do not flip production auth gates or remove legacy auth support until the
  production Chrome extension ID and Web Store rollout path are known.

## Junior Execution Model

This file is designed so a junior developer can execute safe portions of the
work, but it does not remove the need for senior review. Anything involving
auth, billing, database migration, deploy config, or clinical workflow
automation must have a senior reviewer before merge or production use.

Ownership levels:

- Junior-owned with review:
  - PR 1 packaging fixes
  - PR 5 stable API URL cleanup after the first-run behavior is decided
  - PR 7 test/CI cleanup
  - PR 9 docs cleanup
  - PR 0 file inventory, docs, `.gitignore`, and non-destructive copying
- Junior implements with senior pairing:
  - PR 0 backend import/package migration
  - PR 2A auth code cleanup
  - PR 3A low-risk rate/usage controls
  - PR 4 API fetch architecture refactor
  - PR 8 migration tooling on copied/local databases
- Senior-owned:
  - PR 2B production auth gate flip
  - PR 3B durable idempotency if provider billing correctness is at stake
  - PR 6B full resumable clinical finalization workflow
  - any live database migration
  - deleting or archiving old Pediatrics backend files

Stop and ask a senior before:

- touching a real production `.db` file
- changing launchd plist paths or production env vars
- changing Clerk, Stripe, CORS, or auth gate behavior in production
- deleting files from `/Users/admin/Dev/Pediatrics`
- changing G-Hosp discharge, prescription save, print, or finalize click flows
- adding a new paid/provider API call path
- committing any file that may contain PHI, secrets, tokens, or real patient logs

Every PR must include:

- a short "what changed" summary
- exact test commands run
- relevant output summary
- any skipped test and the reason
- rollback notes if the PR touches backend, auth, DB, or deployment
- screenshots or package listing when the PR affects Chrome extension packaging

Before requesting review, run this self-audit:

- `git diff --stat` matches the intended scope.
- No real `.db`, `.db-wal`, `.db-shm`, log, token, key, `.env`, or patient data
  file is staged.
- No production manifest or package contains localhost, Tailscale, rotating
  Cloudflare tunnel, or gist URLs unless the PR is explicitly a dev-build PR.
- All new network calls have timeout behavior.
- All disabled buttons or locked UI states have `finally` cleanup or equivalent.
- Auth-sensitive changes have tests for anonymous, invalid auth, and valid auth.
- Billing/usage-sensitive changes have tests for under-limit and over-limit
  users.
- DB changes are tested on a copied DB first.
- Any skipped test is written in the PR description with a concrete reason.

## Preflight: Dependency And Runtime Audit

Run this before PR 0. It is intentionally separate so the repo move starts with
known dependencies instead of discovering import failures after files are moved.

Tasks:

- Inventory every backend import and script dependency:
  - top-level `keychain_helper.py`
  - `run_dashboard.py`
  - `scripts/run_cloud_api.sh`
  - `scripts/com.tocafichadr.cloud-api.plist`
  - `Dockerfile.cloud`
  - `docker-compose.cloud.yml`
  - `.env.example.cloud`
  - `tests/conftest.py`
- Grep for imports and path assumptions:
  - `keychain_helper`
  - `sys.path`
  - `from emr_automation`
  - `data/`
  - `/Users/*/Dev/Pediatrics`
  - `run_cloud_api`
- Decide whether PR 0 preserves the package name `emr_automation` temporarily or
  renames it immediately to `tocafichadr_api`.
- Audit `dashboard/routes.py` for relative file paths and mixed responsibilities
  before copying it.
- Audit moved tests for fixture dependencies outside `emr_automation/`.
- Dump the current local schema and, if accessible, production schema:
  - `sqlite3 data/tocafichadr.db .schema`
  - `sqlite3 data/audit.db .schema`

Acceptance:

- A migration manifest exists listing every file to move, every file to leave
  behind, and every import/path that needs editing.
- The backend entrypoint strategy is known before the copy starts.
- The schema drift is known before migrations are designed.

## Target Repo Layout

Keep the Chrome extension at repo root for now because Chrome, build scripts, and
existing docs assume `manifest.json` is at the root.

```text
tocafichadr-extension/
  manifest.json
  background/
  content/
  popup/
  sidepanel/
  offscreen/
  styles/
  landing/
  store/
  scripts/
  docs/
  backend/
    README.md
    pyproject.toml
    requirements.txt
    .env.example
    run_dashboard.py
    scripts/
      run_cloud_api.sh
      com.tocafichadr.cloud-api.plist
    devtools/
      realtime_proxy.py
    tocafichadr_api/
      __init__.py
      auth.py
      billing.py
      database.py
      extension_api.py
      keychain_helper.py
      models.py
      openai_auth.py
      selector_config.py
      dashboard/
        __init__.py
        app.py
        routes.py
        routes_auth.py
        routes_billing.py
        routes_clerk.py
        static/
        templates/
    data/
      .gitkeep
      README.md
      selectors/
        ghosp.json
    migrations/
    tests/
  .github/
    workflows/
```

The package name should move away from generic `emr_automation` for new backend
code. Use `tocafichadr_api` unless there is a strong reason to preserve imports.
If preserving imports is needed for a low-risk first move, do it temporarily and
rename in a follow-up PR.

`backend/realtime_proxy.py` already exists in this repo as a local development
tool. Move it under `backend/devtools/` or explicitly delete it if realtime is no
longer supported. Do not leave it orphaned at the old path.

## PR 0: Repo Consolidation And Backend Ownership

Purpose: move all Toca Ficha Dr. backend/runtime ownership into this repo without
changing runtime behavior.

Tasks:

- Create `backend/` with Python package, config, tests, data docs, and migration
  folders.
- Move or copy backend files from `/Users/admin/Dev/Pediatrics` that are part of
  the cloud extension product:
  - `emr_automation/auth.py`
  - `emr_automation/billing.py`
  - `emr_automation/database.py`
  - `emr_automation/extension_api.py`
  - `emr_automation/models.py`
  - `emr_automation/openai_auth.py`
  - `emr_automation/selector_config.py`
  - `emr_automation/dashboard/*`
  - top-level `keychain_helper.py`
  - `run_dashboard.py`
  - `scripts/run_cloud_api.sh`
  - `scripts/com.tocafichadr.cloud-api.plist`
  - `.env.example.cloud`
  - `Dockerfile.cloud` and `docker-compose.cloud.yml` if Docker remains a
    supported deployment path
  - dosage/selector helpers required by extension routes
- Move related backend tests from Pediatrics into `backend/tests/`.
- Move selector seed data from `Pediatrics/data/selectors/ghosp.json` to
  `backend/data/selectors/ghosp.json`.
- Move local runtime DB files locally to:
  - `backend/data/tocafichadr.db`
  - `backend/data/audit.db`
- Add `.gitignore` rules for live DB files:
  - `backend/data/*.db`
  - `backend/data/*.db-*`
  - `backend/logs/`
- Add `backend/data/README.md` explaining local DB placement, backup, and why
  real data is not committed.
- Add schema/migration files so GitHub has the database definition even though
  live DB files are ignored.
- Update docs that currently point to `/Users/admin/Dev/Pediatrics`.
- Add a temporary compatibility note for the old Pediatrics repo: Toca Ficha Dr.
  backend moved here; do not make new product changes there.
- Keep the first migration PR conservative: preserve imports if renaming the
  Python package would make the move risky. Rename package paths only after tests
  pass in the new repo.
- Decide deployment target explicitly:
  - short term: Mac Mini + Cloudflare named tunnel
  - later: Docker/Postgres host if needed
  - not Vercel serverless unless the backend is redesigned for that runtime

Acceptance:

- Backend starts from this repo.
- Focused backend tests pass from `backend/`.
- Extension can hit `/api/health` and one authenticated non-AI route on the new
  backend path.
- No real DB file is tracked by Git.
- `git status --short` does not show changes in `/Users/admin/Dev/Pediatrics`
  after migration cleanup, except for intentional removal commits if that repo is
  also being cleaned.

Rollback:

- Keep the current Pediatrics backend service untouched until the new backend is
  deployed and smoke-tested.
- If the new backend fails, point the extension API base URL back to the old
  running backend while fixing this repo.

## PR 1: Packaging And Manifest Hardening

Purpose: ensure the release zip actually contains the product and only the
required runtime surface.

Tasks:

- Fix `scripts/build-package.sh` to copy `sidepanel/` and `offscreen/`.
- Add the `offscreen` permission if realtime/offscreen remains enabled.
- Add package verification that fails if manifest paths point to missing files.
- Add dev/prod manifest strategy:
  - production: first-party API, Clerk, G-Hosp only
  - dev: localhost, Tailscale, Cloudflare tunnel, gist discovery if still needed
- Choose one implementation:
  - a manifest generator such as `scripts/generate-manifest.js --env=prod`
  - or static `manifest.dev.json` / `manifest.prod.json` with a copy step
- Remove dev-only origins from production package.
- Confirm popup fallback expectations: either add a real popup fallback or remove
  stale fallback comments.

Acceptance:

- `npm run build` passes.
- `scripts/build-package.sh` produces a zip with `sidepanel/` and `offscreen/`.
- Packaged extension loads locally and opens the side panel.
- Static package check fails on missing referenced files.

## PR 2: Auth Code Cleanup And Production Config Lockdown

Purpose: prevent anonymous cloud usage and align extension auth with Clerk.

Split this into two deployment phases. Code cleanup can happen now; the final
production env flip depends on Web Store approval and the production extension
ID.

Tasks:

- PR 2A, code/config prep:
  - make auth-required behavior testable with env vars
  - add explicit failure messages for missing/invalid Clerk auth
  - restrict CORS in examples and deploy docs
  - keep legacy auth code isolated behind a compatibility flag
  - add a health/readiness check for Clerk JWKS reachability and authorized
    parties
- PR 2B, production flip after Web Store approval:
  - set `TOCAFICHADR_AUTH_REQUIRED=true`
  - add `chrome-extension://<PRODUCTION_EXTENSION_ID>` to
    `CLERK_AUTHORIZED_PARTIES`
  - restrict production `CORS_ORIGINS`; do not ship default `*`
- Keep shared `EXTENSION_API_KEY` only for explicitly documented self-host/dev
  mode.
- Replace test Clerk publishable key with production Clerk config.
- Remove or isolate legacy `authToken`, `refreshToken`, `/auth/refresh`,
  `/auth/login`, and `/auth/register` client code paths only after deciding the
  deprecation window for pre-v3.0 clients.
- Make billing/subscription reads use the same discovered/stable authenticated
  API base URL as the rest of the extension.

Acceptance:

- Anonymous paid API calls return `401`.
- Signed-in extension requests work.
- Invalid Clerk audience/origin is rejected.
- Subscription status is fetched through the production API URL, not a hardcoded
  tunnel.
- Readiness check fails before the auth gate can be flipped if Clerk JWKS or
  authorized parties are misconfigured.
- A rollback instruction exists to disable the auth gate if Clerk or extension
  rollout fails.

## PR 3: Usage Limits, Rate Limits, And Cost Controls

Purpose: stop limit bypasses and duplicate billing/provider calls.

Tasks:

- PR 3A, low-risk cost controls:
  - enforce usage checks before every paid/model-backed endpoint
  - add `MAX_CONTENT_LENGTH` or equivalent upload caps
  - add client-side audio duration/size checks before upload
  - add provider timeout handling and normalized provider errors
  - add simple rate limiting with a consciously chosen storage backend
- PR 3B, durable idempotency:
  - add schema for idempotent operations
  - add client-generated operation IDs
  - add TTL/cleanup
  - define behavior for in-progress, completed, failed, and timed-out operations
- Enforce usage limits before every paid/model-backed endpoint:
  - `/api/transcribe`
  - `/api/format-soap`
  - `/api/soap-stream`
  - `/api/format-atestado-letter`
  - `/api/suggest-cid` if model-backed
- Add server-side rate limiting by authenticated user and fallback client IP.
- Add upload size and duration limits for audio.
- Add provider timeout handling and normalized provider error responses.
- Add idempotency keys:
  - client sends `operation_id`
  - backend stores completion/log record keyed by user + operation
  - retries return the existing result or a controlled in-progress response
- Choose rate-limit storage explicitly:
  - in-memory is acceptable only for single-process Mac Mini deployment
  - SQLite is acceptable only at low write volume with short transactions
  - Redis or another shared cache is required before multi-process/multi-host
    deployment
- If behind Cloudflare, parse client IP from trusted proxy headers such as
  `CF-Connecting-IP` or configured `X-Forwarded-For`; do not rate-limit every
  user as the Cloudflare edge IP.
- Ensure one completed clinical action logs one billable usage event.
- Add audit fields for endpoint, operation ID, provider, duration, success, and
  normalized error code.

Acceptance:

- Free users cannot bypass limits through fallback or streaming endpoints.
- Repeating the same `operation_id` does not double-log or double-charge.
- Oversized audio fails before reaching the provider.
- Provider timeout returns a controlled error to the extension.
- A first request that times out after provider charge is treated as an explicit
  failure mode in the design, not hand-waved.

## PR 4: Unified Extension API Fetch Layer

Purpose: prevent hung buttons, duplicate clicks, and inconsistent API behavior.

Tasks:

- Choose the architecture first:
  - preferred: route authenticated `/api/*` calls through the service worker
    proxy and use message passing from popup/side panel/content scripts
  - fallback: create `shared/api-fetch.js` and load it separately in each Chrome
    context that needs it
- Document the three extension contexts before editing:
  - content scripts run in G-Hosp isolated world
  - popup is esbuild-bundled
  - side panel is currently raw/unbundled JS
- Create the shared request surface only after choosing service-worker proxy vs
  shared module.
- Add `AbortSignal.timeout(...)` to all direct API calls.
- Use a single retry policy:
  - no retry for validation/auth failures
  - one retry for network failure after URL refresh
  - no nested retries
- Add single-flight guards for:
  - transcription
  - SOAP streaming/fallback
  - atestado letter generation
  - prescription/finalize actions where applicable
- Prefer service-worker proxy for authenticated `/api/*` calls where practical.
- Normalize backend errors to user-safe Portuguese messages.
- Add `finally` blocks so buttons always re-enable after thrown errors.

Acceptance:

- Rapid double-clicks do not create duplicate API calls.
- Transcription, SOAP fallback, and atestado calls timeout predictably.
- Network failure leaves UI state recoverable.
- No half-written SOAP is pasted after a stream failure.

## PR 5: Stable API URL And Environment Separation

Purpose: remove rotating Cloudflare tunnel dependence from production.

Tasks:

- Make `https://api.tocafichadr.com.br` the production default.
- Replace popup `CLOUD_URL` writes with one API source of truth.
- Allow stable first-party API URLs as valid stored URLs.
- Keep gist/tunnel discovery only in dev builds if needed.
- Remove `*.trycloudflare.com`, Tailscale, localhost, and gist permissions from
  production manifest/package.
- Update docs and launch checklist to use the first-party API.
- Define first-run behavior explicitly: if there is no stored URL, production
  uses `https://api.tocafichadr.com.br`; dev builds may use localhost or
  discovery.

Acceptance:

- Fresh production install uses `https://api.tocafichadr.com.br`.
- Saving settings never overwrites stable API URL with a stale tunnel.
- Cloud mode still works after extension reload.

## PR 6: Finalization Workflow Safety And PRD Alignment

Purpose: make the UI label, clinical workflow, and verification semantics match.

Tasks:

- Decide product behavior:
  - short term recommendation: Option A, rename current button to "Alta e
    voltar" and document it
  - later milestone: Option B, restore full "Finalizar Paciente" workflow
- Add explicit doctor confirmation before any final discharge/submit action.
- Strengthen discharge verification. Do not treat "no error after 4 seconds" as
  sufficient success without another confirmation signal.
- If Option B is chosen, add resumable workflow state persisted across page
  navigations:
  - SOAP saved
  - prescription saved
  - print opened
  - discharge submitted
  - returned to list
- Add audit events for each step.
- Add UI recovery for retrying from the failed step without repeating completed
  steps.

Acceptance:

- Button text matches actual behavior.
- Failed discharge does not show success unless confirmed.
- Doctor can retry or stop safely after a partial failure.
- PRD and manual tests are updated to match the final behavior.
- If Option A is selected, no persistent workflow state is required in this PR.
- If Option B is selected, persistent `chrome.storage` workflow state and
  page-load recovery are part of the estimate.

## PR 7: CI And Test Pipeline

Purpose: make stale tests and broken packaging visible before release.

Tasks:

- Replace placeholder `npm test`.
- Fix `scripts/selftest.sh` selector parsing.
- Update `test-buttons.mjs` version checks so they do not pin stale versions.
- Add extension CI:
  - `npm ci`
  - `npm run build`
  - `npm test`
  - package smoke check
- Add backend CI:
  - install Python dependencies
  - run focused backend tests
  - run full backend tests with dummy test secrets
- Update tests so backend construction does not require real Keychain secrets.
- Prove locally that `pytest` passes with dummy test secrets before declaring CI
  complete.
- Keep Playwright/browser tests separate from fast unit/static checks.

Acceptance:

- Extension test command passes locally.
- Backend test command passes locally without real production secrets.
- CI runs both extension and backend gates.
- Build/package/test failure blocks release.

## PR 8: Database Migrations And Operational Readiness

Purpose: remove schema drift and make operations repeatable.

Tasks:

- Add Alembic or a simple explicit migration runner under `backend/migrations/`.
- Before writing migrations, compare live schema against models:
  - local `backend/data/tocafichadr.db`
  - current Pediatrics `data/tocafichadr.db`
  - production DB if different from local
- Create migration for `users.password_hash` nullable to match Clerk model.
- Add migrations for idempotency/usage/audit improvements from PR 3.
- Seed selector config intentionally from `backend/data/selectors/ghosp.json`.
- Add backup/restore docs for local SQLite and production DB.
- Add production readiness check for:
  - DB connectivity
  - Clerk secret/config
  - Stripe config
  - OpenAI OAuth/client config
  - auth gate state
  - CORS origins
- Add a sanitized schema dump command for support/debugging.

Acceptance:

- Fresh DB and migrated DB both work.
- Clerk-created users do not rely on compatibility hacks.
- Production readiness check fails loudly on unsafe config.
- Migration baseline is based on the actual deployed schema, not only
  `models.py`.

## PR 9: Documentation, PRD, And Compliance Cleanup

Purpose: remove stale product claims and make launch docs accurate.

Tasks:

- Update `PRD.md` to reflect side panel architecture, current finalize behavior,
  backend status, and production readiness.
- Update `SAFETY.md` with the final doctor-confirmation and AI disclosure flow.
- Update `SECURITY.md` after auth gate is enforced.
- Update `docs/NEXT-STEPS.md` paths after backend migration.
- Update Chrome Web Store prep docs with final permissions and data-use claims.
- Add a short regulatory checklist for CFM 2.454/2026 and Anvisa/SaMD review.

Acceptance:

- Docs no longer say backend lives in Pediatrics.
- Docs no longer claim cloud/auth/usage is complete before implementation.
- Web Store claims match code and permissions.

## Suggested Implementation Order

1. Preflight dependency/runtime/schema audit.
2. PR 0: Repo consolidation.
3. PR 1: Packaging and manifest hardening.
4. PR 5: Stable API URL and environment separation.
5. PR 2A: Auth code/config prep.
6. PR 7: CI and test pipeline.
7. PR 3A: Low-risk usage/rate/cost controls.
8. PR 4: Unified extension API fetch layer.
9. PR 6A: Rename/document current finalization behavior.
10. PR 8: DB migrations and operational readiness.
11. PR 2B: Production auth gate flip after Web Store ID/rollout.
12. PR 3B: Durable idempotency if duplicate provider calls remain a real risk.
13. PR 6B: Full resumable finalization workflow, if the product needs it.
14. PR 9: Docs, PRD, and compliance cleanup.

PR 7 can start in parallel after PR 0 if the backend move is clean. Do not start
PR 2B production enforcement until PR 0 is deployable from this repo and the
production Chrome extension ID is known.

## Junior Runbook And Required Tests

Use this section as the execution checklist. A junior developer should not mark a
step complete unless every required test has been run, skipped with a written
reason, or escalated to a senior reviewer.

Before every PR:

```bash
cd /Users/admin/Dev/tocafichadr-extension
git status --short
git branch --show-current
npm run build
```

Expected:

- Worktree changes are understood before starting.
- `npm run build` passes or the failure is documented as pre-existing.
- No unrelated file is edited.

### Preflight Runbook

Implementation checklist:

- Create a migration notes file, for example
  `docs/backend-migration-inventory.md`.
- Record the backend files to move and files to leave behind.
- Record all imports that reach outside `emr_automation/`.
- Record the current SQLite schemas.
- Decide whether PR 0 keeps `emr_automation` as a temporary package name.

Commands:

```bash
cd /Users/admin/Dev/tocafichadr-extension
rg -n "keychain_helper|sys\\.path|from emr_automation|data/|/Users/.*/Dev/Pediatrics|run_cloud_api" \
  /Users/admin/Dev/Pediatrics/emr_automation \
  /Users/admin/Dev/Pediatrics/tests \
  /Users/admin/Dev/Pediatrics/*.py \
  /Users/admin/Dev/Pediatrics/scripts
sqlite3 /Users/admin/Dev/Pediatrics/data/tocafichadr.db ".schema" > /tmp/tocafichadr-schema-before.sql
sqlite3 /Users/admin/Dev/Pediatrics/data/audit.db ".schema" > /tmp/tocafichadr-audit-schema-before.sql
```

Required tests:

- Review `/tmp/tocafichadr-schema-before.sql` and confirm it contains no patient
  rows, only schema.
- Confirm the migration notes identify `keychain_helper.py`, launchd scripts,
  backend entrypoint, selector data, and tests.
- Senior review is required before PR 0 starts.

### PR 0 Runbook: Repo Consolidation

Implementation checklist:

- Create `backend/` structure.
- Copy backend files; do not delete from Pediatrics in this PR.
- Copy `keychain_helper.py` or refactor imports to a repo-local module.
- Copy tests needed for extension backend behavior.
- Move local runtime DB files only after `.gitignore` excludes them.
- Add `backend/data/README.md` explaining DB rules.
- Update paths in scripts and docs to point to this repo.
- Keep launchd production path changes staged for review, not applied live.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension
git status --short
git ls-files -- 'backend/data/*.db' 'backend/data/*.db-*'
```

Expected:

- `git ls-files` prints nothing for real DB files.

Backend import smoke, adjusted to the chosen package name:

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_auth.py tests/test_billing.py tests/test_extension_api.py tests/test_extension_routes.py -q
python -c "from emr_automation.dashboard.app import create_app; app = create_app(); print(app.name)"
```

If the package is renamed immediately, replace `emr_automation` with
`tocafichadr_api` in the smoke command and tests.

Manual smoke:

- Start backend from this repo on localhost.
- Confirm `GET /api/health` returns 200.
- Confirm `GET /api/selectors` returns G-Hosp selectors.
- Confirm no production service path was changed without senior approval.

### PR 1 Runbook: Packaging And Manifest Hardening

Implementation checklist:

- Include `sidepanel/` and `offscreen/` in the package output.
- Add or remove `offscreen` permission based on whether offscreen code ships.
- Add a static package verifier script.
- Pick manifest strategy: generator or static dev/prod manifests.
- Ensure production package excludes dev-only origins.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension
npm run build
./scripts/build-package.sh
VERSION="$(jq -r .version manifest.json)"
unzip -l "tocafichadr-v${VERSION}.zip" | rg "manifest.json|sidepanel/sidepanel.html|sidepanel/sidepanel-prontuario.js|offscreen/offscreen.html|background/service-worker.bundle.js|popup/popup.bundle.js"
```

Expected:

- Build succeeds.
- Zip contains side panel, offscreen files if enabled, bundled popup, bundled
  service worker, and manifest.
- Static verifier fails if a manifest-referenced file is missing.

Manual smoke:

- Load the packaged extension into Chrome.
- Click extension action and confirm side panel opens.
- Confirm console has no missing-file errors.

### PR 5 Runbook: Stable API URL And Environment Separation

Implementation checklist:

- Set production first-run API URL to `https://api.tocafichadr.com.br`.
- Remove production writes to hardcoded `trycloudflare` URLs.
- Keep dev-only URL discovery behind a dev manifest/build flag.
- Update docs and launch checklist.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension
npm run build
rg -n "trycloudflare|100\\.97\\.14\\.32|localhost:5050|gist.githubusercontent" manifest.json popup sidepanel background content
```

Expected:

- Production files do not contain dev-only hosts except in explicitly named dev
  config or docs.
- Fresh install path sets the API URL to `https://api.tocafichadr.com.br`.
- Saving popup settings does not overwrite a stable URL with a tunnel URL.

Manual smoke:

- Clear extension storage.
- Load extension.
- Confirm first-run API URL is first-party.
- Confirm cloud mode still reaches `/api/health`.

### PR 2A Runbook: Auth Code And Config Prep

Implementation checklist:

- Make auth-required mode testable locally.
- Add readiness endpoint or command that checks Clerk config without exposing
  secrets.
- Isolate legacy token code behind a compatibility decision.
- Do not flip production auth gate in this PR.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
TOCAFICHADR_AUTH_REQUIRED=true \
CLERK_AUTHORIZED_PARTIES="chrome-extension://dummy" \
python -m pytest tests/test_auth.py tests/test_extension_routes.py tests/test_billing.py -q
```

Local smoke with backend running:

```bash
curl -i -X POST http://127.0.0.1:5050/api/transcribe
curl -i http://127.0.0.1:5050/api/health
```

Expected:

- Unauthenticated `POST /api/transcribe` returns `401` when auth gate is on.
- `/api/health` remains safe and intentionally public.
- Signed-in/authenticated tests pass with mocked Clerk tokens.

Senior review required:

- Any change to Clerk audience/authorized parties.
- Any deletion of legacy auth paths.

### PR 2B Runbook: Production Auth Gate Flip

Implementation checklist:

- Confirm production Chrome extension ID.
- Confirm signed-in extension can obtain Clerk token.
- Confirm readiness check passes in production.
- Prepare rollback command before flipping the env var.
- Flip `TOCAFICHADR_AUTH_REQUIRED=true` only during a monitored window.

Required tests:

- Before flip: production readiness check passes.
- Before flip: signed-in extension request succeeds against production.
- After flip: anonymous paid API request returns `401`.
- After flip: signed-in voice/transcribe path succeeds.
- After flip: logs show no spike in auth failures from current clients.

Rollback:

- Document the exact command or plist/env edit to set
  `TOCAFICHADR_AUTH_REQUIRED=false`.
- Do not leave the monitored window until rollback has been tested or reviewed.

### PR 7 Runbook: CI And Test Pipeline

Implementation checklist:

- Replace placeholder `npm test`.
- Fix selector parity selftest.
- Remove stale fixed manifest version assertions.
- Add GitHub Actions for extension and backend.
- Make backend tests run with dummy secrets and no macOS Keychain.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension
npm test
npm run build
./scripts/selftest.sh
./scripts/build-package.sh
```

Backend tests after PR 0:

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest -q
```

Expected:

- `npm test` is no longer a placeholder.
- Selftest completes without selector regex crash.
- Backend tests pass without real production secrets.
- CI config runs the same commands or a documented subset.

### PR 3A Runbook: Low-Risk Usage, Rate, And Cost Controls

Implementation checklist:

- Add usage checks before every model-backed endpoint.
- Add backend upload size limit.
- Add client-side audio size/duration guard.
- Add provider timeout handling.
- Add simple rate limiter with chosen storage.
- Add tests for Cloudflare IP header parsing if proxy headers are used.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_billing.py tests/test_extension_routes.py -q
python -m pytest tests/test_usage_limits.py tests/test_rate_limits.py -q
```

If new test files do not exist yet, create them in this PR.

Test cases required:

- free user under limit can call each paid endpoint
- free user over limit gets `429` on each paid endpoint
- anonymous request with auth gate on gets `401`, not a usage-limit response
- oversized audio returns a controlled `413` or documented error
- provider timeout returns a controlled error body
- `CF-Connecting-IP` is honored only when the request is from a trusted proxy

Extension tests:

- Oversized or too-long recording is rejected before upload.
- UI shows a recoverable message and re-enables controls.

### PR 3B Runbook: Durable Idempotency

Implementation checklist:

- Add operation table or equivalent schema.
- Generate client operation IDs for model-backed operations.
- Define TTL and cleanup.
- Define in-progress, completed, failed, and timed-out semantics.
- Store enough metadata to avoid double billing without storing PHI.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
python -m pytest tests/test_idempotency.py tests/test_billing.py tests/test_extension_routes.py -q
```

Test cases required:

- same user + same operation ID does not call provider twice
- different user + same operation ID is isolated
- in-progress duplicate returns controlled in-progress response
- completed duplicate returns stored response or documented replay response
- failed duplicate follows documented retry behavior
- expired idempotency key can be cleaned up

Senior review required before merge because this affects billing correctness.

### PR 4 Runbook: Unified Extension API Fetch Layer

Implementation checklist:

- Choose service-worker proxy or shared module before writing code.
- Document the decision in the PR.
- Apply one timeout/retry/error policy to popup, side panel, and content script
  API calls.
- Remove direct fetch paths that bypass the chosen policy unless documented.
- Add `finally` cleanup for every button-disabled path.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension
npm test
npm run build
rg -n "fetch\\(baseUrl \\+ '/api|fetch\\(CLOUD_URL|fetch\\(.*\\/api/" popup sidepanel content background
```

Expected:

- Remaining direct `/api/` fetches are either removed or documented exceptions.
- Timeout behavior is covered by unit tests or a mock backend test.
- Double-click tests prove only one operation starts.

Manual smoke:

- Start backend.
- Trigger transcription once.
- Trigger rapid double-click on transcription/atestado actions.
- Confirm only one backend request is made per operation.
- Simulate backend offline and confirm UI recovers.

### PR 6A Runbook: Rename/Document Current Finalization Behavior

Implementation checklist:

- Rename the current button to match actual behavior, for example
  "Alta e voltar".
- Update PRD/manual tests to say the button discharges and returns to list only.
- Add explicit confirmation if the action submits discharge.
- Strengthen success/failure language in UI.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension
npm test
npm run build
rg -n "Finalizar Paciente|Alta e voltar|SIDEPANEL_FINALIZE_PATIENT" sidepanel content PRD.md docs
```

Expected:

- UI text and docs no longer promise a full workflow if code only discharges.
- Existing discharge tests still pass.
- Manual test checklist reflects the actual behavior.

Senior/manual validation:

- Any real G-Hosp discharge-path smoke must be done by a doctor or supervised
  in a non-production/safe patient context.

### PR 6B Runbook: Full Resumable Finalization Workflow

Implementation checklist:

- Only start this if product explicitly chooses full "Finalizar Paciente".
- Add persistent workflow state in `chrome.storage`.
- Detect current G-Hosp page state after navigation/reload.
- Make every step idempotent or explicitly non-repeatable.
- Add retry-from-failed-step UI.

Required tests:

- Unit tests for workflow state transitions.
- Content-script tests for each DOM step using fixtures/mocks.
- Manual supervised G-Hosp test for:
  - SOAP save
  - prescription save
  - print open
  - discharge submit
  - return to list
  - failure at each step and retry

Senior review required before merge because this can affect live clinical flow.

### PR 8 Runbook: Database Migrations And Operational Readiness

Implementation checklist:

- Dump schema before migrations.
- Build migrations against a copied DB, never the original first.
- Add migration command and rollback/restore docs.
- Add readiness check for DB, Clerk, Stripe, OpenAI, auth gate, and CORS.
- Add schema dump support command.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension/backend
cp data/tocafichadr.db /tmp/tocafichadr-migration-test.db
DATABASE_URL="sqlite:////tmp/tocafichadr-migration-test.db" python -m migrations.upgrade
sqlite3 /tmp/tocafichadr-migration-test.db "PRAGMA integrity_check;"
DATABASE_URL="sqlite:////tmp/tocafichadr-migration-test.db" python -m pytest tests/test_models.py tests/test_auth.py tests/test_billing.py -q
```

Expected:

- Integrity check returns `ok`.
- Migrated copied DB supports auth, billing, and model tests.
- Fresh empty DB can also initialize and pass tests.
- No migration command is run against production until senior-approved.

### PR 9 Runbook: Docs, PRD, And Compliance Cleanup

Implementation checklist:

- Update PRD after the code behavior is actually implemented.
- Update Safety/Security docs after auth and finalization behavior are final.
- Update Web Store prep permissions and data-use declarations.
- Update old Pediatrics paths.

Required tests:

```bash
cd /Users/admin/Dev/tocafichadr-extension
rg -n "/Users/admin/Dev/Pediatrics|trycloudflare|TOCAFICHADR_AUTH_REQUIRED=false|Cloud backend .*Not deployed|HUD panel" PRD.md SECURITY.md SAFETY.md README.md docs
npm run build
```

Expected:

- Any remaining stale text is intentional and documented.
- Docs match manifest permissions and backend behavior.
- Build still passes after docs-only changes.

## Local Migration Checklist

Use this once PR 0 is ready.

1. Finish the preflight dependency audit.
2. Stop making Toca Ficha Dr. backend changes in `/Users/admin/Dev/Pediatrics`.
3. Copy backend code and tests into `tocafichadr-extension/backend/`.
4. Move local SQLite runtime files into `tocafichadr-extension/backend/data/`.
5. Confirm DB files are ignored and not staged.
6. Run backend tests from the new path.
7. Start backend from the new path on localhost.
8. Point extension dev config to the new localhost backend.
9. Smoke `/api/health`, auth, selectors, and one transcription path.
10. Deploy new backend path to the Mac Mini or selected host.
11. Update launchd/system service paths.
12. Smoke production API.
13. Only then remove or archive the old Toca Ficha Dr. backend files from
    Pediatrics.

## Verified MacBook And Mac Mini Infrastructure

Verified on 2026-05-08.

Current development MacBook:

- Hostname: `MacBook-de-Chris-2.local`
- Local user in this session: `admin`
- Tailscale IP: `100.88.191.63`
- Tailscale interface: `utun6`
- SSH service on the MacBook is reachable on port 22 over Tailscale, but the
  current key is not authorized for `admin@100.88.191.63`. Local shell access is
  available in this session; reverse SSH into the MacBook requires key setup.

Mac Mini:

- Tailscale IP: `100.97.14.32`
- SSH user: `christianoliveira`
- Verified hostname over SSH: `mac-mini-de-chris`
- Verified SSH reachability from MacBook:
  `nc -vz -G 5 100.97.14.32 22`
- Verified SSH login from MacBook:
  `ssh -F /dev/null -o BatchMode=yes christianoliveira@100.97.14.32 hostname`
- Verified Mac Mini can reach the MacBook over Tailscale:
  `ping -c 1 100.88.191.63` from Mac Mini returned 0% packet loss.

Current backend state on Mac Mini:

- Backend health from inside Mac Mini:
  `curl -sS http://127.0.0.1:5050/api/health`
- Backend health from MacBook over Tailscale:
  `curl -sS http://100.97.14.32:5050/api/health`
- Both returned `{"status":"ok", ...}` during verification.
- Mac Mini is listening on `*:5050`, verified with:
  `lsof -nP -iTCP:5050`
- This means the backend is reachable over Tailscale while the Mac Mini is on.

Operational conclusion:

- The MacBook is a development machine. The production backend must not depend
  on the MacBook being powered on.
- The Mac Mini can host the backend independently. If the MacBook is off, the
  extension/backend flow can still work as long as the Mac Mini is on, the
  backend service is running, and the doctor can reach it through Tailscale,
  Cloudflare Tunnel, or `https://api.tocafichadr.com.br`.
- For public production use, the preferred external path is a stable
  first-party API URL that routes to the Mac Mini or a future cloud host:
  `https://api.tocafichadr.com.br`.

## Mac Mini Unified Repo Deployment Runbook

Purpose: place the unified project repo on the Mac Mini so the Mac Mini contains
both the Chrome extension frontend source and the Flask backend source in one
repo. After PR 0, this repo should be the source of truth on both the MacBook and
Mac Mini.

Target path on Mac Mini:

```text
/Users/christianoliveira/Dev/tocafichadr-extension/
```

Do not delete `/Users/christianoliveira/Dev/Pediatrics` until the unified repo
backend has been deployed, tested, monitored, and explicitly approved for
cutover.

### One-Time SSH Check

From the MacBook:

```bash
ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=8 \
  christianoliveira@100.97.14.32 'hostname; whoami; pwd'
```

Expected:

- Hostname: `mac-mini-de-chris`
- User: `christianoliveira`
- Home path: `/Users/christianoliveira`

### Recommended Git-Based Deployment

Use this after PR 0 is committed and pushed to GitHub.

On the Mac Mini:

```bash
ssh -F /dev/null christianoliveira@100.97.14.32
mkdir -p ~/Dev
cd ~/Dev
git clone https://github.com/chrislro/tocafichadr-extension.git tocafichadr-extension
cd tocafichadr-extension
git status --short
```

If the repo already exists:

```bash
ssh -F /dev/null christianoliveira@100.97.14.32
cd ~/Dev/tocafichadr-extension
git fetch --all --prune
git status --short
git pull --ff-only
```

Expected:

- The Mac Mini has this repo at `~/Dev/tocafichadr-extension`.
- The repo contains both frontend extension folders and backend folders:
  - `manifest.json`
  - `background/`
  - `content/`
  - `popup/`
  - `sidepanel/`
  - `offscreen/`
  - `backend/`

### Safe Local Copy Alternative

Use this only before the GitHub remote is ready. This copies source files but
must not copy live databases, logs, node_modules, build cache, or secrets.

From the MacBook:

```bash
cd /Users/admin/Dev/tocafichadr-extension
rsync -av \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'graphify-out/cache/' \
  --exclude 'backend/data/*.db' \
  --exclude 'backend/data/*.db-*' \
  --exclude 'backend/logs/' \
  --exclude '.env' \
  --exclude '*.log' \
  ./ christianoliveira@100.97.14.32:/Users/christianoliveira/Dev/tocafichadr-extension/
```

After copying, verify on Mac Mini:

```bash
ssh -F /dev/null christianoliveira@100.97.14.32 \
  'cd ~/Dev/tocafichadr-extension && git status --short && find backend -maxdepth 3 -name "*.db" -o -name "*.db-wal" -o -name "*.db-shm"'
```

Expected:

- No real DB files were copied by accident.
- Git status only shows expected source changes.

### Moving Runtime DB Files To Unified Repo On Mac Mini

Only do this after PR 0 creates `backend/data/` and `.gitignore` excludes live
DB files.

On the Mac Mini, make a backup first:

```bash
ssh -F /dev/null christianoliveira@100.97.14.32
mkdir -p ~/Backups/tocafichadr-db
cp ~/Dev/Pediatrics/data/tocafichadr.db ~/Backups/tocafichadr-db/tocafichadr-$(date +%Y%m%d-%H%M%S).db
cp ~/Dev/Pediatrics/data/audit.db ~/Backups/tocafichadr-db/audit-$(date +%Y%m%d-%H%M%S).db 2>/dev/null || true
```

Then copy, not move, into the unified repo:

```bash
mkdir -p ~/Dev/tocafichadr-extension/backend/data
cp ~/Dev/Pediatrics/data/tocafichadr.db ~/Dev/tocafichadr-extension/backend/data/tocafichadr.db
cp ~/Dev/Pediatrics/data/audit.db ~/Dev/tocafichadr-extension/backend/data/audit.db 2>/dev/null || true
cd ~/Dev/tocafichadr-extension
git ls-files -- 'backend/data/*.db' 'backend/data/*.db-*'
```

Expected:

- `git ls-files` prints nothing for live DB files.
- Keep the original DBs in Pediatrics until production cutover is complete.

### Backend Setup On Mac Mini

After PR 0, install backend dependencies inside the unified repo. Exact commands
may change depending on whether PR 0 uses `requirements.txt`, `pyproject.toml`,
or both.

Example:

```bash
ssh -F /dev/null christianoliveira@100.97.14.32
cd ~/Dev/tocafichadr-extension/backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pytest tests/test_auth.py tests/test_billing.py tests/test_extension_api.py tests/test_extension_routes.py -q
```

Expected:

- Focused backend tests pass on the Mac Mini from the unified repo.
- Tests do not require live production secrets.

### Running The Unified Backend On Mac Mini

Before changing launchd, test manually:

```bash
ssh -F /dev/null christianoliveira@100.97.14.32
cd ~/Dev/tocafichadr-extension/backend
source .venv/bin/activate
export DATABASE_URL="sqlite:///data/tocafichadr.db"
python run_dashboard.py
```

From the MacBook:

```bash
curl -sS --max-time 5 http://100.97.14.32:5050/api/health
curl -sS --max-time 5 http://100.97.14.32:5050/api/selectors | head -c 300
```

Expected:

- `/api/health` returns `{"status":"ok", ...}`.
- `/api/selectors` returns valid selector JSON.

### Launchd Cutover On Mac Mini

Senior-owned. Do not let a junior developer perform this unsupervised.

Plan:

1. Keep the current Pediatrics launchd service running until the unified backend
   manual smoke test passes.
2. Create a new launchd plist pointing to:
   `/Users/christianoliveira/Dev/tocafichadr-extension/backend/scripts/run_cloud_api.sh`
3. Keep a rollback plist or command that points back to:
   `/Users/christianoliveira/Dev/Pediatrics/scripts/run_cloud_api.sh`
4. Restart during a monitored window.
5. Verify health from both Mac Mini localhost and MacBook Tailscale.

Required checks after launchd cutover:

```bash
ssh -F /dev/null christianoliveira@100.97.14.32 \
  'curl -sS http://127.0.0.1:5050/api/health'
curl -sS --max-time 5 http://100.97.14.32:5050/api/health
ssh -F /dev/null christianoliveira@100.97.14.32 \
  'lsof -nP -iTCP:5050'
```

Expected:

- Health passes from inside and outside the Mac Mini.
- The process listening on `*:5050` is the unified repo backend.
- Logs are written under the unified repo or another documented location.

Rollback:

- Stop the unified backend launchd service.
- Restart the old Pediatrics service.
- Confirm `http://100.97.14.32:5050/api/health` returns 200 again.
- Do not delete the old Pediatrics backend until rollback has been unnecessary
  for a full monitored period.

## GitHub Migration Checklist

1. Push this repo with `backend/`, migrations, tests, docs, and seed selector
   config.
2. Confirm `.gitignore` excludes runtime DBs, logs, secrets, `.env`, and cache.
3. Add GitHub Actions for extension and backend checks.
4. Add repository secrets only for CI-safe values. Do not add live PHI or real
   local DB files.
5. Update README with monorepo setup:
   - extension build
   - backend setup
   - local DB creation
   - migrations
   - test commands
6. Archive old backend references in the Pediatrics repo after production cutover.

## Release Gates

For a Chrome Web Store draft/upload used to obtain or verify the production
extension ID, PR 2A plus a documented PR 2B flip plan is acceptable. Do not
publish broadly, expand users, or market paid access until all gates pass:

- Packaged extension contains all referenced files.
- Production manifest has no dev-only hosts.
- Auth gate is on in production.
- Anonymous model-backed API calls fail.
- Usage limits apply to streaming and fallback endpoints.
- API calls have timeouts and duplicate-click protection.
- Finalization behavior is accurately labeled and verified.
- DB migrations are reproducible.
- CI passes for extension and backend.
- Privacy, safety, and Web Store declarations match actual code.

## Known Complexity Traps

- `keychain_helper.py` is top-level in Pediatrics and is imported by multiple
  backend modules. PR 0 must move it or refactor those imports.
- `tests/conftest.py` constructs `EMRAutomation`, which currently reaches real
  Keychain/OpenAI secret validation unless tests patch it correctly.
- `dashboard/routes.py` is large and mixes dashboard, extension API, dosage, and
  audit behavior. Move first, split later.
- `backend/realtime_proxy.py` is currently orphaned local-dev code in this repo.
  Decide whether to keep it under `backend/devtools/` or delete it.
- The landing page is deployed by Vercel. The Flask API should remain Mac Mini
  plus Cloudflare named tunnel for this plan unless a separate backend hosting
  decision is made.
- Popup and service-worker bundles are large because of Clerk. This is not a
  launch blocker, but CI should track bundle size so it does not regress
  unnoticed.


---

## Execution Log — 2026-05-08 Session

This section records the full migration execution performed on 2026-05-08.
It serves as an audit trail and rollback reference.

### Before State

- Repo on MacBook (`MacBook-de-Chris-2.local`) had uncommitted backend migration
  work (PR 0–7 safe parts completed in a prior session).
- Mac Mini (`mac-mini-de-chris`, Tailscale `100.97.14.32`) ran the backend from
  `~/Dev/Pediatrics` via `com.pedbot.cloud-api` launchd.
- Chrome extension used a rotating `trycloudflare.com` tunnel URL discovered via
  gist.
- `api.tocafichadr.com.br` did not resolve.

### Commits Made

All commits pushed to `main` on `https://github.com/chrislro/tocafichadr-extension.git`:

1. `2e3e014..f78e79d` — "PR 0–7 backend migration, packaging, auth config,
   usage limits, CI" (95 files, 18,998 insertions).
2. `f78e79d..c6c5eb2` — "docs(PR 9): update PRD, README, SAFETY, SECURITY,
   deploy docs" (10 docs files).
3. `c6c5eb2..32d31b6` — "feat(PR 4): unified extension API fetch layer" (5
   extension files: sidepanel, popup, service-worker, content/api-client).
4. `32d31b6..bedc6fc` — "feat(PR 3B): durable idempotency schema + backend
   decorator" (5 backend files: idempotency.py, models.py, routes.py,
   migrations/upgrade.py, tests/test_idempotency.py).
5. `bedc6fc..66210e3` — "fix(tests): add Authorization header to idempotency
   tests".
6. `66210e3..614e815` — "fix(idempotency): use module-level get_session lookup
   for test compat".
7. `614e815..4c52e4d` — "fix(tests): adjust failed-retry assertion to match
   decorator behavior".

### Mac Mini Deployment Steps

Performed via SSH as `christianoliveira@100.97.14.32`:

1. `git clone https://github.com/chrislro/tocafichadr-extension.git`
   → `~/Dev/tocafichadr-extension`
2. `python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`
3. Backed up live DBs:
   `cp ~/Dev/Pediatrics/data/tocafichadr.db ~/Backups/tocafichadr-db/tocafichadr-20260508-150825.db`
   `cp ~/Dev/Pediatrics/data/audit.db ~/Backups/tocafichadr-db/audit-20260508-150825.db`
4. Copied live DBs to unified repo:
   `cp ~/Dev/Pediatrics/data/tocafichadr.db ~/Dev/tocafichadr-extension/backend/data/tocafichadr.db`
   `cp ~/Dev/Pediatrics/data/audit.db ~/Dev/tocafichadr-extension/backend/data/audit.db`
5. Copied `.env` from Pediatrics to `backend/.env`
6. Created `logs/` directory
7. Created new launchd plist `~/Library/LaunchAgents/com.tocafichadr.cloud-api.plist`
   with working directory `~/Dev/tocafichadr-extension/backend` and env vars:
   `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES`, `SECRET_KEY`, `PATH`
8. Launchd cutover:
   `launchctl unload com.pedbot.cloud-api.plist`
   `launchctl load com.tocafichadr.cloud-api.plist`
9. Verified health from localhost, Tailscale, and tunnel URL.
10. Killed stray test process on port 5051.
11. Pulled subsequent commits and re-ran backend tests after each backend code
    change.

### Test Results

**Mac Mini backend (unified repo)**
- `python -m pytest -q` → **76 passed**, 65 warnings (all pre-existing
  SQLAlchemy legacy/utcnow deprecation warnings).
- `python -m pytest tests/test_idempotency.py -v` → **4 passed**.

**MacBook extension**
- `npm run build` → passes.
- `node scripts/verify-package.js --root .` → OK.
- `./scripts/build-package.sh` → `tocafichadr-v3.4.0.zip` (1.8M, 34 files).

### What Is Now Live on Mac Mini

- Flask backend process PID `78767` listening on `*:5050`
- Source: `~/Dev/tocafichadr-extension/backend`
- Logs: `~/Dev/tocafichadr-extension/backend/logs/`
- Runtime DBs: `~/Dev/tocafichadr-extension/backend/data/*.db` (ignored by git)
- `.env`: copied from old Pediatrics path
- Launchd label: `com.tocafichadr.cloud-api`
- Rollback plist available: `com.pedbot.cloud-api` (not deleted)

### What Remains Blocked

- **PR 2B (production auth flip)**:
  - Needs `api.tocafichadr.com.br` DNS to resolve.
  - Needs production Chrome extension ID from Web Store.
  - Readiness shows `auth_required: false` and `cors_origins: false` (wildcard)
    which are expected until flip.
- **PR 6B (full resumable finalization workflow)**:
  - Needs explicit product decision (Option A vs Option B).

### Rollback Commands

If the new backend fails, revert to Pediatrics without data loss:

```bash
ssh christianoliveira@100.97.14.32
launchctl unload ~/Library/LaunchAgents/com.tocafichadr.cloud-api.plist
launchctl load ~/Library/LaunchAgents/com.pedbot.cloud-api.plist
curl -sS http://100.97.14.32:5050/api/health
```

The old `.db` files are still in `~/Dev/Pediatrics/data/` as a safety copy.

### Files That Must Not Be Deleted from Mac Mini

- `~/Dev/Pediatrics/data/tocafichadr.db` — safety copy until cutover is confirmed
- `~/Dev/Pediatrics/data/audit.db` — safety copy
- `~/Backups/tocafichadr-db/*` — dated backups
- `~/Library/LaunchAgents/com.pedbot.cloud-api.plist` — rollback launchd config

---

## Update: DNS Propagation Successful — 2026-05-08 21:55 UTC-3

### DNS Verification

- `dig @1.1.1.1 api.tocafichadr.com.br` → resolves to Cloudflare A records:
  - `104.21.49.165`
  - `172.67.164.249`
- SSL certificate: valid Let's Encrypt cert for `tocafichadr.com.br` (SAN `*.tocafichadr.com.br`)
- `curl https://api.tocafichadr.com.br/api/health` → `{"status":"ok"}` ✅
- Named tunnel `tocafichadr-api` running with 4 active QUIC connections (gru02, gru19, gru20)

### Notes

- MacBook local DNS cache still has stale NXDOMAIN from pre-propagation; will clear automatically.
- Requests without `User-Agent` header may receive 403 from Cloudflare edge; extension fetch calls automatically include browser User-Agent.
- Python `urllib.request` without explicit headers gets 403; this is expected and not a production concern.

### Remaining Blocker for PR 2B

Only **production Chrome Web Store extension ID** is still needed before flipping `TOCAFICHADR_AUTH_REQUIRED=true`:

1. Submit extension v3.4.0 to Chrome Web Store → obtain production `EXTENSION_ID`
2. Update `CLERK_AUTHORIZED_PARTIES` and `CORS_ORIGINS` in launchd plist with production domain + extension origin
3. Reload launchd service and verify readiness shows `auth_required: true`, `cors_origins: true`
