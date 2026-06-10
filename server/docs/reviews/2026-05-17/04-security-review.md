---
skill: /security-review
date: 2026-05-17
phase: 006-code-quality-sweep-2026-05-17
focus: MV3 permissions, content-script CSP, Clerk auth integration, message-passing leaks
---

# Security Review — tocafichadr-extension

## Scope

Full security review of the `tocafichadr-extension` Chrome MV3 extension codebase (HEAD: `8d6c2ab`). Focus areas per task brief: MV3 permissions, content-script CSP, Clerk auth integration, and message-passing leaks.

## Risk Rating

| Area | Rating | Notes |
|---|---|---|
| MV3 Permissions | 🟡 Medium | `cookies` permission broader than needed |
| Content-Script CSP | 🟡 Medium | `style-src 'unsafe-inline'` in extension pages |
| Clerk Auth Integration | 🟠 High | OAuth callback URLs logged with auth codes |
| Message-Passing | 🟡 Medium | No explicit unknown-type handler in SW |
| Secret Management | 🔴 Critical | BFG scrub pending on git history |
| Data Privacy / LGPD | 🟠 High | Console shipper can leak clinical data |

---

## MV3 Permissions Review

**Declared permissions (`manifest.json`):**
```json
["activeTab", "storage", "cookies", "scripting", "clipboardWrite", "sidePanel", "offscreen"]
```

### `cookies` — Broader Than Needed

The `cookies` permission grants read/write access to all cookies on host-permission-matched domains. No extension JS directly calls `chrome.cookies.*`. The Clerk SDK (`@clerk/chrome-extension/background`) likely requires this for background authentication session handling.

**Risk:** If an XSS vulnerability were found in the extension's extension pages, an attacker could exfiltrate cookies from matched domains including the G-Hosp medical records system.

**Recommendation:** Audit Clerk SDK changelog to confirm whether background mode requires `cookies`. If it can be dropped, remove it. If not, document the requirement.

### `scripting` — Correctly Used

Used for programmatic content-script injection in test-mode gates. Scope is limited to `host_permissions` domains. Acceptable.

### `sidePanel` + `offscreen` — Correctly Used

Both are required for the core feature set (persistent side panel UI, offscreen MediaRecorder). No concerns.

### Host Permissions

```json
"https://prbentogoncalves.g-hosp.com.br/*",
"http://localhost:5050/*",
"http://127.0.0.1:5050/*",
"http://100.97.14.32:5050/*",
"https://*.trycloudflare.com/*",
"https://api.tocafichadr.com.br/*",
"https://gist.githubusercontent.com/chrislro/*",
"https://clerk.tocafichadr.com.br/*",
"https://accounts.tocafichadr.com.br/*",
"https://*.clerk.accounts.dev/*",
"https://*.accounts.dev/*"
```

**Issues:**
- `http://localhost:5050/*` and `http://127.0.0.1:5050/*` and `http://100.97.14.32:5050/*` are dev-only. These should be removed from production builds. Verify `manifest.prod.json` omits them.
- `https://*.trycloudflare.com/*` is a wildcard on Cloudflare Tunnel domains. Any Cloudflare tunnel URL would match. This is intentional for dev tunnels but is effectively an open wildcard for the Cloudflare domain space.
- `https://*.accounts.dev/*` is broad — Clerk dev-mode domain. Verify this is needed in production and not only in dev/staging.

---

## Content-Script CSP Review

**Extension pages CSP:**
```
script-src 'self' 'wasm-unsafe-eval';
object-src 'self';
base-uri 'none';
connect-src 'self' https://clerk.tocafichadr.com.br ... ;
frame-src 'self' ... ;
img-src 'self' https://img.clerk.com data: blob:;
style-src 'self' 'unsafe-inline'
```

### `style-src 'unsafe-inline'` — MEDIUM Risk

Allows inline styles in extension pages (popup, side panel). If any extension page renders user-supplied content (e.g., prescription templates from the server) that gets turned into inline styles, an attacker who can write to the database could inject malicious style properties.

**Note:** Content script pages (G-Hosp tabs) are not governed by this CSP. The extension's CSP only applies to extension-owned pages.

### `wasm-unsafe-eval` — Acceptable

Required for WASM-based audio processing. Properly scoped to `script-src` only.

### `img-src data: blob:` — Low Risk

Allows `data:` URI images in extension pages. This is typical for audio waveform canvas rendering. Low risk given the extension controls all image generation.

### Content Scripts (No Extension CSP)

Content scripts run in the page context with the page's CSP. The G-Hosp page's CSP governs what content scripts can do. No extension-side restriction applies here. The extension correctly does not inject inline scripts (uses `content_scripts` injection, not `eval` or `insertAdjacentHTML`).

---

## Clerk Auth Integration Review

### Token Storage Pattern

Auth tokens (Clerk JWT) and refresh tokens are stored in `chrome.storage.local`:

```js
// content/api-client.js
chrome.storage.local.get(["authToken", "refreshToken"], (result) => {
  if (result.authToken) authToken = result.authToken;
  if (result.refreshToken) refreshToken = result.refreshToken;
});
```

**Risk:** `chrome.storage.local` is accessible to all extension scripts and also to other extensions if the user has installed a malicious extension with the `storage` permission. JWTs stored here are effectively global to the extension bundle.

**Mitigations present:** SW handles token refresh via Clerk SDK's background mode. Content scripts send API requests through the SW proxy (TOCAFICHADR_FETCH message), which attaches the Bearer token server-side — content scripts don't need to hold the token at all for API calls.

**Recommendation:** Consider not loading `authToken` into content-script memory at all. The SW proxy pattern already handles authorization — content scripts only need to send messages to the SW. Remove the `chrome.storage.local.get(["authToken", ...])` in `api-client.js` if it's not needed for non-proxied calls.

### OAuth Callback URL Logging — HIGH Risk

**File:** `shared/clerk-tap.js`

```js
console.warn('[Toca Ficha CLERKTAP] page-load url=' + String(location.href).slice(0, 800));
```

This is intercepted by `console-shipper.js` and shipped to `/api/debug-log`. Clerk's OAuth flow routes through URLs like:

```
https://accounts.tocafichadr.com.br/...?code=AUTHCODE&state=STATE
```

The `code` and `state` parameters are OAuth one-time-use tokens. While they expire quickly, logging them creates a window for replay attacks if the debug log is compromised.

**Fix (high priority):**
```js
// In clerk-tap.js, before the console.warn
var safeUrl = String(location.href)
  .replace(/([?&])(code|state|session_token|__clerk_token)=[^&]*/gi, '$1$2=[redacted]')
  .slice(0, 800);
console.warn('[Toca Ficha CLERKTAP] page-load url=' + safeUrl);
```

### Background Auth (Service Worker)

The SW uses `createClerkClient({ publishableKey, ... })` with `background: true`. The Clerk publishable key (`pk_live_...`) is embedded in source code — this is the Clerk-endorsed pattern for client-side use. The key is intentionally public. No concern here.

---

## Message-Passing Security Review

### `TOCAFICHADR_FETCH` — SW Proxy Pattern

Content scripts send `{type: 'TOCAFICHADR_FETCH', url, method, headers, body}` to the SW. The SW attaches the Bearer token and forwards to the backend.

**Review:**
- URL is validated against `API_HOSTS_ALLOWLIST` regex: `/^(?:api\.tocafichadr\.com\.br|[a-z0-9-]+\.trycloudflare\.com)$/i`. This is a hostname-only check on the parsed URL hostname. Good.
- The SW uses `new URL(url)` for parsing, so URL injection is not possible via string manipulation.
- Method is passed through without restriction. A content script could send a `DELETE` request if it wanted. This is acceptable since the content scripts are first-party.

**Gap:** No origin check on `chrome.runtime.onMessage`. Any extension with the extension ID could send `TOCAFICHADR_FETCH` messages to the SW. This is a standard Chrome extension trust model limitation — `chrome.runtime.sendMessage` to the same extension is implicitly trusted.

### `TOCAFICHADR_DEBUG_LOG` — Console Shipper

Messages from `console-shipper.js` are shipped to `/api/debug-log`. The SW receives these and POSTs to the backend. 

**Risk:** Clinical note text (SOAP fields, CID codes, patient URLs) can appear in `console.warn` calls from content scripts and will be shipped verbatim. See M-001 above.

### Message Response Handling

Content scripts that send messages to the SW all check `chrome.runtime.lastError` in the callback. This is correct — prevents "Unchecked runtime.lastError" warnings and handles the case where the SW is asleep.

**Gap:** Some message senders (e.g., `user-config-client.js:_swFetch`) resolve with `{ ok: false }` on error, but the callers don't uniformly log or surface these failures to the user. Silent failures in config hydration may leave the UI in an indeterminate state.

---

## Critical: Git History Contains Secrets

**Severity: CRITICAL — Action Required**

PR #23 commit message explicitly states secrets were committed and BFG scrub is still pending. The secrets included:
- Live EMR credentials (G-Hosp login)
- Flask `SECRET_KEY`
- OpenAI API token

**Required actions (in order):**
1. Confirm all three secrets have been rotated (invalidated + replaced). If not, rotate NOW.
2. Run BFG Repo Cleaner: `bfg --delete-files .env.bak <repo>` followed by `git push --force`.
3. Notify all collaborators who have cloned the repo to re-clone from the force-pushed state.
4. Add `*.bak*` and `*.env*` patterns to `.gitignore` (partially done in PR #23).

---

## Summary Finding Counts

| Severity | Count |
|---|---|
| Critical | 1 (BFG scrub) |
| High | 2 (OAuth URL logging, token in content script memory) |
| Medium | 4 (cookies permission, unsafe-inline, console shipper PII, dev host permissions) |
| Low | 3 (no unknown-type handler, offscreen reconnect, vercel.json location) |
| **Total** | **10** |
