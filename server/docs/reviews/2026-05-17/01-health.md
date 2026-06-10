---
skill: /health
date: 2026-05-17
phase: 006-code-quality-sweep-2026-05-17
repo: tocafichadr-extension
---

# Health Report — tocafichadr-extension

## Summary

| Dimension | Status | Notes |
|---|---|---|
| Build | ✅ Green | esbuild bundles popup + SW cleanly |
| Dependencies | ✅ 0 vulns | `npm audit`: 0 info/low/moderate/high/critical |
| Tests | ⚠️ Partial | Static selftest + verify-package passes; Playwright E2E gates are in PRs but not merged |
| Git hygiene | ⚠️ Warning | `backend/.env.bak` secrets removed from HEAD but BFG history scrub still pending (noted in commit 8d6c2ab) |
| Code organization | ✅ Good | Clean MV3 separation: SW / content scripts / shared / sidepanel / popup / offscreen |
| CSP | ✅ Compliant | Extension-pages CSP is explicit and well-scoped |
| MV3 compliance | ✅ Green | Uses `service_worker`, `offscreen`, `sidePanel`, no `background.persistent` |

## Dependency Counts

- Production: 220 packages
- Dev: 27 packages
- Optional: 32 packages
- Peer: 262 packages
- **npm audit vulnerabilities: 0**

## Source File Stats

| File | Category |
|---|---|
| `background/service-worker.src.js` | Core — SW, API proxy, Clerk auth |
| `content/api-client.js` | Content — API wrapper, token mgmt |
| `content/audio-capture.js` | Content — MediaRecorder + VAD |
| `content/bridge.js` | Content — SW message bus |
| `content/cid.js` | Content — ICD-10 lookup |
| `content/content.js` | Content — main orchestrator |
| `content/dom-engine.js` | Content — G-Hosp DOM automation |
| `content/hud.js` | Content — floating UI |
| `content/vad-helpers.js` | Content — VAD pure-math helpers |
| `shared/clerk-tap.js` | Shared — Clerk telemetry beacon |
| `shared/console-shipper.js` | Shared — console.warn/error exfil |
| `shared/user-config-client.js` | Shared — per-user config hydration |
| `sidepanel/sidepanel-prontuario.js` | UI — side panel orchestrator |
| `popup/popup.src.js` | UI — popup |
| `offscreen/offscreen.js` | Offscreen — MediaRecorder host |
| `auth-success.js` | Auth — post-OAuth redirect |

## Build Reproducibility

```bash
npm run build   # → popup/popup.bundle.js + background/service-worker.bundle.js
npm run test    # → scripts/selftest.sh + npm run build + node scripts/verify-package.js
```

Both run clean on current HEAD (`8d6c2ab`).

## Key Open Items

1. **BFG scrub pending** — git history still contains `.env.bak` secrets; must be purged before sharing repo access broadly. Already flagged in PR #23 commit message.
2. **E2E gates unmerged** — PRs #20, #21, #22 add Playwright infrastructure but are not yet in `main`.
3. **package.json name mismatch** — `"name": "pedbot-extension"` (leftover from rebrand phase 004); does not affect runtime but is stale.
4. **Localhost host_permissions** — `manifest.json` lists `http://localhost:5050/*` and `http://127.0.0.1:5050/*` for dev; `manifest.prod.json` should omit these (verify before next CWS submission).
