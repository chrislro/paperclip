# Toca Ficha Dr. — 12-Factor Adaptation for Extensions

## Introduction

This document adapts the 12-Factor App methodology for browser extensions with a self-hosted backend. Extensions have unique constraints (MV3 lifecycle, content scripts, CSP) that require creative adaptations.

---

## Factor 1: Codebase

**Principle:** One codebase tracked in revision control, many deploys.

**Implementation:**
- Single Git repository
- Two deploy targets: Chrome Web Store (extension) and Mac Mini (backend)
- Extension and backend share codebase

**Status:** Compliant

---

## Factor 2: Dependencies

**Principle:** Explicitly declare and isolate dependencies.

**Implementation:**
- **Backend:** requirements.txt with pinned versions
- **Extension:** package.json with lock file
- **Isolation:** Python venv for backend, node_modules for build tools

**Status:** Compliant

---

## Factor 3: Config

**Principle:** Store config in environment variables.

**Implementation:**
- **Backend:** .env file (not committed)
- **Extension:** Chrome storage API (syncs across devices)
- **Content Scripts:** Config fetched from backend API

**Adaptation for Extensions:**
Extensions cannot use environment variables directly. We use:
- `chrome.storage.sync` for user settings
- Backend API for dynamic config (selectors, features)
- Manifest.json for static permissions

**Status:** Adapted

---

## Factor 4: Backing Services

**Principle:** Treat backing services as attached resources.

**Implementation:**
- **Backend:** SQLite (local), can switch to PostgreSQL
- **Transcription:** OpenAI Whisper / Groq (swappable)
- **Auth:** Clerk (external service)
- **Billing:** Stripe (external service)

**Status:** Compliant

---

## Factor 5: Build, Release, Run

**Principle:** Strictly separate build and run stages.

**Implementation:**
- **Build:** npm run build (bundles JS, copies assets)
- **Release:** ZIP upload to Chrome Web Store
- **Run:** Chrome loads extension, backend runs via launchd

**Status:** Compliant

---

## Factor 6: Processes

**Principle:** Execute the app as one or more stateless processes.

**Implementation:**
- **Backend:** Flask is stateless (no sessions)
- **Extension:** Service Worker is ephemeral (MV3 constraint)
- **State:** Stored in Chrome storage or backend database

**MV3 Adaptation:**
Service Workers in MV3 are terminated when idle. All state must be:
- Persisted to chrome.storage
- Re-fetched from backend on wake
- Never stored in global variables

**Status:** Adapted

---

## Factor 7: Port Binding

**Principle:** Export services via port binding.

**Implementation:**
- **Backend:** Port 5050 (Flask/Gunicorn)
- **Extension:** No port (communicates via Chrome APIs)

**Status:** Compliant

---

## Factor 8: Concurrency

**Principle:** Scale out via the process model.

**Implementation:**
- **Backend:** Single Flask instance (can use Gunicorn workers)
- **Extension:** Each browser instance is independent

**Status:** Partially Compliant

---

## Factor 9: Disposability

**Principle:** Maximize robustness with fast startup and graceful shutdown.

**Implementation:**
- **Backend:** Flask starts in ~1 second
- **Extension:** Service Worker wakes on events
- **launchd:** Auto-restarts backend on crash

**MV3 Adaptation:**
Service Workers must handle abrupt termination:
- All async operations use event.waitUntil()
- No long-running tasks in SW
- Offscreen document for audio capture

**Status:** Adapted

---

## Factor 10: Dev/Prod Parity

**Principle:** Keep development, staging, and production as similar as possible.

**Implementation:**
- Same Chrome version
- Same backend code
- Same G-Hosp target

**Gaps:**
- No staging G-Hosp environment
- Web Store review process delays updates
- Local backend vs. production backend

**Status:** Partially Compliant

---

## Factor 11: Logs

**Principle:** Treat logs as event streams.

**Implementation:**
- **Backend:** stdout/stderr → launchd logs
- **Extension:** Console API (visible in DevTools)
- **Audit:** Structured logs to SQLite

**Extension Logging:**
```javascript
// Use console-shipper.js for consistent logging
console.log('[TocaFicha] Action completed', {action, duration});
```

**Status:** Partially Compliant

---

## Factor 12: Admin Processes

**Principle:** Run admin/management tasks as one-off processes.

**Implementation:**
- **Database:** SQLite CLI or Python scripts
- **Selectors:** API endpoint to update config
- **Users:** Clerk dashboard

**Status:** Compliant

---

## Extension-Specific Adaptations

### Content Security Policy (CSP)

Extensions must declare all external connections:
```json
{
  "host_permissions": [
    "https://prbentogoncalves.g-hosp.com.br/*",
    "https://*.trycloudflare.com/*"
  ]
}
```

### Cross-Origin Requests

Extensions bypass CORS for declared host_permissions, but backend must still validate origins.

### Storage Limits

chrome.storage.sync has quotas:
- 8KB per item
- 100KB total

**Solution:** Store large data in backend, keep only IDs and settings in extension.

### Update Cycle

Chrome extensions update automatically, but:
- Review process takes 1-3 days
- Users can disable auto-updates
- Must maintain backward compatibility

---

## Current Score: 8/12

| Factor | Status | Notes |
|--------|--------|-------|
| 1. Codebase | Compliant | Single repo |
| 2. Dependencies | Compliant | Explicit + isolated |
| 3. Config | Adapted | Chrome storage + backend API |
| 4. Backing Services | Compliant | Swappable |
| 5. Build/Release/Run | Compliant | ZIP → Web Store |
| 6. Processes | Adapted | MV3 ephemeral SW |
| 7. Port Binding | Compliant | Port 5050 |
| 8. Concurrency | Partial | Single backend |
| 9. Disposability | Adapted | MV3 constraints |
| 10. Dev/Prod Parity | Partial | No staging G-Hosp |
| 11. Logs | Partial | DevTools + local files |
| 12. Admin Processes | Compliant | Scripts + API |

## Improvement Roadmap

1. **Staging Environment:** Mirror G-Hosp for testing
2. **Structured Logging:** JSON logs with correlation IDs
3. **Backend Scaling:** Gunicorn with multiple workers
4. **Log Aggregation:** Centralized logging
5. **Health Monitoring:** Automated alerts
6. **CI/CD:** Automated Web Store publishing
