# Service Worker Lifecycle & Wake/Sleep Audit

**Issue:** [chrislro/tocafichadr-extension#68](https://github.com/chrislro/tocafichadr-extension/issues/68)  
**Branch:** `chra-1913/sw-lifecycle-audit`  
**Date:** 2026-05-28  
**Auditor:** Engineer (Paperclip)

---

## 1. Event Listeners in Async Context

**Severity:** INFO — None found

All `chrome.runtime.onMessage.addListener`, `onConnect`, `onAlarm`, `onInstalled`, and `onStartup` registrations are at the **top level** (synchronous) in `background/service-worker.src.js`.

- `onInstalled` — line 58
- `onStartup` — line 72
- `alarms.create` / `onAlarm` — lines 306-326
- `onMessageExternal` — line 369
- `onMessage` — line 403
- `onConnect` — line 533

**No violations.** All listeners are registered synchronously during the initial script evaluation.

---

## 2. Missing Keepalive

**Severity:** HIGH — **FIXED**

### Problem
The extension uses `chrome.alarms` for token refresh (period: 30s), which keeps the SW alive briefly every 30s. However, this is a side effect, not an intentional keepalive strategy.

No explicit keepalive existed for long-running operations:
- **Transcription** can take 7-90s (Whisper latency). The SW could be killed mid-flight.
- **SOAP streaming** via Port holds the connection open, but the SW had no keepalive during the stream.

### Fix (CHRA-1913)
Added `ACTIVE_OPS_KEEPALIVE_ALARM` (`tocafichadr-active-ops-keepalive`) that fires every 30s while an operation is active.

**Files changed:**
- `background/service-worker.src.js` — new helpers `_acquireActiveOpsKeepalive()` and `_releaseActiveOpsKeepalive()` (lines ~327-358)

**Usage:**
- `_handleTranscribe()` acquires keepalive before starting and releases it in `.finally()`
- SOAP stream handler acquires keepalive on `SOAP_STREAM_START` and releases it in `finally` + `onDisconnect`

**Rationale:** Chrome wakes the SW for each alarm tick. A 30s period (minimum allowed by `chrome.alarms`) is sufficient to prevent the 30s inactivity timeout from firing during long operations.

---

## 3. State Stored in Memory (Wiped on Restart)

**Severity:** CRITICAL — **PARTIALLY FIXED**

### Variables audited

| Variable | Purpose | Risk | Status |
|----------|---------|------|--------|
| `_clerkPromise` | Cached Clerk client | Re-initialisation cost + potential auth flicker | **ACCEPTED** — Re-init is fast; Clerk SDK handles its own caching |
| `_transcribeInFlight` | Single-flight guard for transcription | **Duplicate transcription requests possible after restart** | **FIXED** |
| `offscreenReadyResolver` | Offscreen doc readiness promise resolver | Realtime audio init may hang; was an **implicit global** | **FIXED** |
| `aborter` / `done` / `fullSoap` | SSE streaming state | Stream corruption or orphaning on SW death | **MITIGATED** — Port disconnects on SW death; content script handles `onDisconnect` with error callback. Keepalive now reduces likelihood of SW death mid-stream |

### Fix 1: `_transcribeInFlight` → `chrome.storage.session` (CHRA-1913)

**File:** `background/service-worker.src.js`

Replaced module-scope `let _transcribeInFlight = null` with:
- `TRANSCRIBE_IN_FLIGHT_KEY = '_transcribeInFlight'`
- `_isTranscribeInFlight()` — reads from `chrome.storage.session`, ignores entries older than 5 min
- `_setTranscribeInFlight(boolean)` — writes/removes the session key

This ensures that if the SW is killed and restarted while a transcription is in flight, the new SW instance will still reject duplicate requests until the first one completes or the 5-min TTL expires.

### Fix 2: `offscreenReadyResolver` implicit global (CHRA-1913)

**File:** `background/service-worker.src.js`

Added explicit declaration at module scope:
```js
let offscreenReadyResolver = null;
```

This variable was referenced in the `OFFSCREEN_READY` message handler (line ~477) but was never declared, making it an implicit global. In strict mode or after SW restart this could cause a `ReferenceError`.

---

## 4. Port Usage After SW Restart

**Severity:** MEDIUM — **ACCEPTED WITH MITIGATION**

### Current behaviour
- The SOAP streaming Port (`chrome.runtime.connect({ name: "TOCAFICHADR_SOAP_STREAM" })`) is created fresh per stream in `content/api-client.js:242`.
- If the SW restarts mid-stream, the Port disconnects. The content script's `onDisconnect` handler (line 261) fires and calls `onError`.

### Gap
There is no automatic retry or resume logic. The doctor must click again.

### Mitigation applied
- Keepalive alarm (see §2) reduces the probability of SW termination mid-stream.
- Content script already surfaces a clear error: `"Conexão de streaming encerrada"`.

**Recommendation for future:** Consider adding a 1-click retry in the HUD when `SOAP_ERROR` or `onDisconnect` fires, rather than requiring the doctor to re-open the side panel and re-click.

---

## Build Verification

```bash
cd ~/Dev/tocafichadr-extension
npm run build
```

Expected: esbuild completes for both popup and service worker with no errors.

---

## Summary

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | Event listeners in async context | INFO | None needed |
| 2 | Missing keepalive for long operations | HIGH | Added `_acquireActiveOpsKeepalive` / `_releaseActiveOpsKeepalive` |
| 3a | `_transcribeInFlight` lost on SW restart | CRITICAL | Migrated to `chrome.storage.session` |
| 3b | `offscreenReadyResolver` implicit global | CRITICAL | Added explicit `let` declaration |
| 4 | Port disconnect on SW restart | MEDIUM | Mitigated with keepalive + existing error handler |
