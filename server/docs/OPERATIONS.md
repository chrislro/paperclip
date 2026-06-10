# Operations And Runbooks

Updated: 2026-05-08

This document covers production operation of the Toca Ficha Dr. backend and the
Chrome extension package.

## Production Inventory

| Item | Value |
|---|---|
| GitHub repo | `https://github.com/chrislro/tocafichadr-extension.git` |
| MacBook checkout | `/Users/admin/Dev/tocafichadr-extension` |
| Mac Mini checkout | `/Users/christianoliveira/Dev/tocafichadr-extension` |
| SSH target | `ssh mac-mini` |
| Backend service | `com.tocafichadr.cloud-api` |
| Backend local port | `127.0.0.1:5050` |
| Public API | `https://api.tocafichadr.com.br` |
| Runtime logs | `backend/logs/cloud-api.log`, `backend/logs/cloud-api-error.log` |

## Health Checks

Public:

```bash
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/api/health
```

Mac Mini local:

```bash
ssh mac-mini /usr/bin/curl -sS http://127.0.0.1:5050/api/health
```

Selectors:

```bash
curl -sS 'https://api.tocafichadr.com.br/api/selectors?emr=ghosp'
```

Service status:

```bash
ssh mac-mini launchctl list com.tocafichadr.cloud-api
```

## Deploy Backend To Mac Mini

From the MacBook:

```bash
git push origin main
ssh mac-mini git -C /Users/christianoliveira/Dev/tocafichadr-extension pull --ff-only
ssh mac-mini launchctl kickstart -k gui/501/com.tocafichadr.cloud-api
```

Then verify:

```bash
ssh mac-mini launchctl list com.tocafichadr.cloud-api
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/api/health
```

## Build Production Extension Package

```bash
cd /Users/admin/Dev/tocafichadr-extension
npm ci
npm test
./scripts/build-package.sh --prod
```

Upload the generated zip to the Chrome Web Store only after the release checklist
in `docs/TESTING.md` passes.

## Logs

Backend stdout:

```bash
ssh mac-mini tail -120 \
  /Users/christianoliveira/Dev/tocafichadr-extension/backend/logs/cloud-api.log
```

Backend stderr and access logs:

```bash
ssh mac-mini tail -160 \
  /Users/christianoliveira/Dev/tocafichadr-extension/backend/logs/cloud-api-error.log
```

Useful patterns:

```bash
ssh mac-mini rg -n "QueuePool|timeout|transcribe_audio|billing/subscription|500|Traceback" \
  /Users/christianoliveira/Dev/tocafichadr-extension/backend/logs
```

## Runbook: Extension Shows "Servidor nao respondeu"

1. Check public health:
   ```bash
   curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
     https://api.tocafichadr.com.br/api/health
   ```
2. Check the exact endpoint, if known, for example:
   ```bash
   curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
     https://api.tocafichadr.com.br/billing/subscription
   ```
   Without auth, this should return `401` quickly. It should not hang.
3. Check Mac Mini service status:
   ```bash
   ssh mac-mini launchctl list com.tocafichadr.cloud-api
   ```
4. Tail logs:
   ```bash
   ssh mac-mini tail -160 \
     /Users/christianoliveira/Dev/tocafichadr-extension/backend/logs/cloud-api-error.log
   ```
5. If logs show SQLAlchemy pool exhaustion, restart service immediately:
   ```bash
   ssh mac-mini launchctl kickstart -k gui/501/com.tocafichadr.cloud-api
   ```
6. If health is down after restart, roll back to the last known good commit.

## Runbook: Roll Back Backend

Use this only when the current backend commit causes production failure.

```bash
ssh mac-mini git -C /Users/christianoliveira/Dev/tocafichadr-extension log --oneline -5
ssh mac-mini git -C /Users/christianoliveira/Dev/tocafichadr-extension checkout <known-good-sha>
ssh mac-mini launchctl kickstart -k gui/501/com.tocafichadr.cloud-api
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/api/health
```

After emergency rollback, create a follow-up commit or revert on `main` so the
Mac Mini does not remain detached from the repository history.

## Runbook: Sync MacBook, GitHub, And Mac Mini

```bash
git -C /Users/admin/Dev/tocafichadr-extension status --short --branch
git -C /Users/admin/Dev/tocafichadr-extension rev-parse HEAD
git -C /Users/admin/Dev/tocafichadr-extension ls-remote origin refs/heads/main
ssh mac-mini git -C /Users/christianoliveira/Dev/tocafichadr-extension status --short --branch
ssh mac-mini git -C /Users/christianoliveira/Dev/tocafichadr-extension rev-parse HEAD
```

Expected:

- Both worktrees clean.
- Both HEAD SHAs match GitHub `refs/heads/main`.
- Mac Mini `rev-list --left-right --count HEAD...origin/main` returns `0 0`.

## Incident Response

Severity guide:

| Severity | Examples | Action |
|---|---|---|
| Critical | PHI leak, auth bypass, wrong clinical data saved automatically | Stop rollout, disable affected feature, notify owner immediately. |
| High | Backend outage during shift, repeated timeouts, billing/auth failure blocking use | Restart or roll back, preserve logs, ship hotfix. |
| Medium | One workflow broken but manual fallback works | Document in `docs/NEXT-STEPS.md`, fix before Web Store submission. |
| Low | Cosmetic issue, stale docs, non-blocking warnings | Batch into next maintenance pass. |

Incident notes should include:

- Exact time and timezone.
- Extension version and backend commit.
- Endpoint and HTTP status.
- Relevant log lines.
- What was changed, restarted, rolled back, or deferred.
- Verification commands and outcomes.

## Backup And Recovery Notes

- Runtime SQLite files under `backend/data/` are local operational state and must
  not be committed.
- Before schema changes, copy the live DB and run migrations against the copy.
- Record RTO/RPO targets before broader paid use.
- Move billing/auth data to managed Postgres before multi-clinic or enterprise
  rollout.
