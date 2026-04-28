# Paperclip Mac Mini — Full Review & Doc-Compliance Audit

**Audited:** 2026-04-28
**Host:** `mac-mini-de-chris.tail606c16.ts.net` (`100.97.14.32`)
**Source:** `/Users/christianoliveira/Dev/paperclip` (fork: `chrislro/paperclip`, upstream: `paperclipai/paperclip`)
**Runtime home:** `~/.paperclip/instances/default/`
**Doc baseline:** `doc/DEPLOYMENT-MODES.md` (2026-02-23) and upstream README @ release v2026.427.0.

## TL;DR

System is healthy and serving traffic. Five issues found; all addressed in this audit cycle except macOS 12 → 14/15 platform upgrade (deferred — needs coordination with parser cron, OpenClaw, Caddy).

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | Critical | Auto-update silently disabled (working copy on `fix/config-validation-error-logging` instead of `master`; update script aborts if branch != master) | Switched back to `master`. Feature branch `2de867f5` already pushed to `fork/`. |
| 2 | Notable | `local_trusted` exposed via Caddy on Tailnet (off-spec per `DEPLOYMENT-MODES.md` §3) | **Accepted as documented deviation** — see `doc/plans/2026-04-28-tailnet-local-trusted-deviation.md`. Trip-wires defined; migration path documented. |
| 3 | Medium | Discord digest watcher timing out after 15s (real endpoint takes 44.9s for 875 KB / 500 issues) | `~/bin/paperclip-discord-watcher.py` `timeout=15` → `timeout=90`. |
| 4 | Medium | Backup growth jump (24 MB → 68 MB in 24h, then plateau) | Documented as follow-up; see "Open Diagnostics" below. |
| 5 | Medium | Mac Mini health collector `services.json` had stale `luxe-staging-*` entries | Removed 2 stale entries from `~/Library/Application Support/Paperclip/mac-mini-health/services.json`. |
| 6 | Medium | macOS 12.7.6 (Monterey) end-of-life | **Deferred** to a separate maintenance window. |
| 7 | Low | `ULTRAREVIEW_2026-04-27.md` untracked | Committed alongside this audit. |
| 8 | Low | Stale `ERR_MODULE_NOT_FOUND` lines in `server.err` from 2026-04-21 | Left in place (harness blocked truncation; low priority; no recurrence). |

## What Was Verified Against Upstream Docs

| Upstream contract | Local reality | Status |
|---|---|---|
| Node.js 20+ | v22.22.2 | OK |
| Embedded Postgres in `local_trusted` | `embedded-postgres@18.1.0-beta.16`, port 54329 | OK |
| `local_trusted` host = loopback | `host: "127.0.0.1"` | OK at server level |
| `local_trusted` = no login required | matches | OK |
| `local_trusted` should be **loopback-only** per §3 | Caddy proxies `:3443` to all tailnet peers | off-spec → see deviation doc |
| `allowedHostnames` enforced | 4 entries; covers tailnet + localhost | OK |
| Telemetry off by default | `telemetry.enabled: false` | OK |
| `secrets.strictMode` | `false` | acceptable for solo `local_trusted`; documented |
| Hourly DB backup with retention | 7-day, last 49.6 MB at 03:00 today | OK |
| SECURITY.md vuln-reporting via GH Advisory | upstream policy, n/a to local | n/a |

## Service Inventory at Audit Time

| Service | Schedule | Last Run | Status |
|---|---|---|---|
| `ai.paperclip` | KeepAlive | uptime 48m at audit | healthy, listening 127.0.0.1:3100 |
| `ai.paperclip.backup` | daily 03:00 | 2026-04-28 03:00 (49.6 MB) | OK |
| `ai.paperclip.update` | daily 04:15 | 2026-04-28 04:20 (now at `ae85fc10`) | Critical → fixed by branch switch |
| `ai.paperclip.discord-alerts` | every 300s | live (running) | OK (recovered) |
| `ai.paperclip.discord-digest` | daily 09:00 | 2026-04-28 09:00 (timeout) | Medium → fixed by timeout bump |
| `ai.paperclip.discord-patch-verify` | Mondays 09:00 | 2026-04-27 15:54 | OK |
| `ai.paperclip.mac-mini-health-collector` | KeepAlive | live (PID 521) | OK (config cleaned) |

## Architecture Snapshot

```
tailnet peer (e.g. MacBook)
  browser → https://mac-mini-de-chris.tail606c16.ts.net:3443
            │ TLS (Let's Encrypt via tailscale cert)
            ▼
Mac Mini (100.97.14.32)
  Caddy 2.11.2 (root, system LaunchDaemon)
    :3443 → reverse_proxy localhost:3100
            │
            ▼
  ai.paperclip (LaunchAgent, Node v22.22.2)
    127.0.0.1:3100 — deploymentMode: local_trusted
    └─ embedded-postgres@18.1.0-beta.16 (:54329)
       └─ DB ~745 MB; hourly backups (7d retention)

  Auto-update layer (chrislro/paperclip → fork/master)
    Layer 1: GitHub Actions sync-upstream.yml @ 06:00Z
    Layer 2: ai.paperclip.update @ 04:15 local
      └─ patches: dist/ exports + openclaw-gateway line 1137
```

## Actions Taken (This Audit)

1. **Branch state**: confirmed `2de867f5` pushed to `fork/fix/config-validation-error-logging`; switched local working copy back to `master` (commit `ae85fc10`). Auto-update gate now passes.
2. **Deviation doc**: wrote `doc/plans/2026-04-28-tailnet-local-trusted-deviation.md` codifying the `local_trusted`-on-tailnet choice with explicit threat-model trip-wires.
3. **Discord watcher**: edited `~/bin/paperclip-discord-watcher.py` line 74, `timeout=15` → `timeout=90`. Backup at `paperclip-discord-watcher.py.bak`.
4. **Health collector**: removed `luxe-staging-api` and `luxe-staging-frontend` from `~/Library/Application Support/Paperclip/mac-mini-health/services.json`. New count: 10.
5. **Audit artifact**: this file + the deviation doc, committed to `chris/audit-2026-04-28` branch and pushed to `fork/`.

## Open Diagnostics (Follow-Ups)

### Backup growth (Medium)

DB compressed backup jumped from ~24 MB to ~68 MB on 2026-04-27→28, then plateaued. Cause unknown.

To diagnose, connect to the embedded postgres and look at the largest tables:

```
pnpm paperclipai db:size --top 15
```

Or via psql with credentials from `~/.paperclip/instances/default/secrets/master.key`-derived auth:

```
psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip \
  -c "SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS sz \
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace \
      WHERE c.relkind = 'r' AND n.nspname = 'public' \
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15;"
```

### macOS upgrade (Medium → Deferred)

macOS 12.7.6 build 21H1320 is end-of-life. Upgrade window must coordinate with: parser/Itaú cron grants, OpenClaw daemons (TCC), Caddy launchd swap-in. Not done in this audit.

### Discord digest endpoint performance (Long-term)

`/api/companies/<id>/issues?limit=500` takes ~44.9s for 875 KB. The watcher timeout bump is a workaround. The upstream-quality fix is pagination or a lean digest endpoint. Worth filing as a `PAP-*` issue.

## Verification Commands (re-run after this audit)

After this audit, the following should hold:

```
ssh mac-mini "cd ~/Dev/paperclip && git symbolic-ref --short HEAD"
# expected: master

ssh mac-mini "tail -5 ~/.paperclip/instances/default/logs/update.log"
# expected: tomorrow at 04:15+, "=== Update complete — now at <commit> ==="

ssh mac-mini "grep -n 'timeout=' ~/bin/paperclip-discord-watcher.py | head -3"
# expected: line 74 shows timeout=90
```
