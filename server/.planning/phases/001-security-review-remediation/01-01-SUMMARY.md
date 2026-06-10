---
phase: 001-security-review-remediation
plan: 01
subsystem: security
tags: [service-worker, url-allowlist, bearer-auth, ssrf-prevention]
requirements-completed: [P0-3, P1-2]
affects: [01-02, 01-03, 01-04, 01-05, future API endpoints]
key-files:
  modified: [background/service-worker.js]
commit: 02f3ab3
completed: 2026-04-22
---

# Plan 01-01 — SW URL allowlist + transcribe return shape

**SW no longer accepts arbitrary fetch targets from callers; transcribe results are now SW-authoritative for `ok`.**

## Accomplishments

- `_handleFetch` enforces origin-match against the configured `apiBaseUrl` and requires `/api/*` path prefix. Rejects non-matching URLs with `{ok:false, status:0, text:"url not allowed"}` and unparseable URLs with `{text:"invalid url"}`.
- Caller-supplied `Authorization` header is stripped case-insensitively; a fresh `Bearer <authToken>` is attached from `chrome.storage.local`, making the SW the sole source of auth.
- `_handleTranscribe` final return is now `{ ...json, ok: resp.ok }` — SW-authoritative `ok`, so content-script callers no longer depend on Flask's JSON shape echoing an `ok` field.
- Sender-validation gate from `66f0f7a` untouched; retry-on-network-error path untouched; `api-client.request()` response shape `{ok, status, text}` preserved.

## Files

- `background/service-worker.js` — +41 / -2

## Commit

`02f3ab3` — `sec: allowlist _handleFetch URLs + normalize transcribe return shape`

## Manual smoke-test expectations

Reload the extension → open SW inspector → run:

1. `chrome.runtime.sendMessage({type:'TOCAFICHADR_FETCH', url:'https://example.com/api/transcribe', method:'GET'}, r => console.log(r))` → expect `{ok:false, status:0, text:"url not allowed"}`.
2. `chrome.runtime.sendMessage({type:'TOCAFICHADR_FETCH', url:'<current-apiBaseUrl>/evil', method:'GET'}, r => console.log(r))` → expect `{ok:false, status:0, text:"url not allowed"}` (path mismatch).
3. Include a malicious `headers.Authorization` in the message — Flask access log should show only the stored user token, not the attacker value.

## Deviations

None. Plan executed as specified.

## Follow-ups

- Plan's Task 1 second `<verify>` grep has a premature closing quote (`headers['Authorization'] = 'Bearer'` — real literal is `'Bearer ' + authData.authToken`). Semantic verification was satisfied via line 173 of the modified SW.
