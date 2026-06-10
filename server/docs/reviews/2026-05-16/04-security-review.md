# Security Review — tocafichadr-extension
**Date:** 2026-05-17  
**Phase:** 006-code-quality-sweep-2026-05-16  
**Reviewer:** Paperclip Researcher (CHRA-885)  
**Scope:** Extension source (content scripts, SW, popup, sidepanel, shared, manifest, backend spot-check)

---

## Summary

| Severity | Count | Notes |
|---|---|---|
| Critical | 0 | — |
| High | 1 | GitHub PAT in git remote URL (in `.git/config`, not in tracked source) |
| Medium | 1 | Old secret material in git history (pre-rotation; keys already rotated by CHRA-858) |
| Low | 3 | Cookie stripping gap in proxy, large supply-chain surface via Clerk deps, stale `refreshToken` in local storage |
| Info | 3 | Publishable key embedded (intentional), `TOCAFICHADR_AUTH_REQUIRED` now enabled, auth required config verified |

**Overall posture: ACCEPTABLE for current stage.** No unmitigated critical or exploitable high findings in tracked source. The GitHub PAT in the remote URL is a process finding that needs rotation/cleanup, not an immediate exfiltration risk (it lives in `.git/config`, not pushed source). The git-history secret exposure is remediated (CHRA-858).

---

## HIGH Findings

### HIGH-SEC-1: GitHub PAT embedded in git remote URL

**Evidence:** `git remote get-url origin` returns a URL of the form `https://<PAT>@github.com/chrislro/tocafichadr-extension.git`

**What it is:** The repository was cloned (or remote was set) using a GitHub Personal Access Token embedded directly in the URL. This PAT lives in `.git/config` of every checkout/worktree of this repo.

**Risk:**
- Any process or agent that reads `.git/config` (or runs `git remote -v`) gains the PAT.
- If the PAT has `repo` or `write` scope, it can push to the repository or enumerate private repos.
- The worktree at `~/Dev/tocafichadr-extension-sweep-2026-05-16` also exposes it via `.git` (symlink to the main worktree's git dir).

**Disposition:** This was flagged in CEO Phase 0 commit comment. Mentioned in CHRA-885 issue body as a known finding.

**Recommended action (Phase 2 child issue):**
1. Rotate the PAT immediately.
2. Re-set the remote using SSH (`git remote set-url origin git@github.com:chrislro/tocafichadr-extension.git`) or a credential-manager-backed HTTPS URL (no token in the URL itself).
3. Ensure no agent or CI secret stores the PAT in git config going forward.

---

## MEDIUM Findings

### MED-SEC-1: Old secret material in git history (pre-rotation)

**Evidence:** Commits before `8d6c2ab` (`security: remove tracked .env.bak secrets`) contain `backend/.env.bak` files with real credentials (Groq, OpenAI, Clerk keys).

**Commits containing secrets:**
- `d89ef52` — `security: remove tracked secret file and harden .gitignore`
- `c319231` — same (WIP stash)

**Disposition:** All vendor keys were rotated by CHRA-858 (confirmed in issue body). The old key strings are now inert. History rewrite (BFG / git-filter-repo) to eliminate the old blobs would be the cleanest solution but requires force-push to `main` and coordination across all clones.

**Recommended action (Phase 2 child issue):**
1. Confirm with CEO: is force-rewrite of git history approved? Requires all worktrees/clones to be re-synced.
2. If yes: use `git filter-repo --path backend/.env.bak --invert-paths` and force-push (with branch protection temporarily disabled).
3. If no: document this as "intentional, inert, rotated" in `SECURITY.md` under a known-history-exposure section.

---

## LOW Findings

### LOW-SEC-1: `Cookie` / `Set-Cookie` headers not stripped in `_handleFetch` proxy

**File:** `background/service-worker.src.js:560-578`

The generic HTTP proxy strips and replaces the `Authorization` header (correct) but does not remove `cookie` or `set-cookie` headers from inbound requests. A content script could craft a `TOCAFICHADR_FETCH` message with `headers: { cookie: "..." }` targeting an API path. The `api.tocafichadr.com.br` backend is JWT-based, not cookie-based, so exploitation would require both a confused-deputy attack AND a backend implementation that reads cookies — currently unlikely. Defensive depth would benefit from stripping these headers.

**Recommended action:** Add to the header strip block:
```js
const HEADER_STRIP = new Set(['authorization', 'cookie', 'set-cookie']);
for (const k of Object.keys(inbound)) {
  if (!HEADER_STRIP.has(k.toLowerCase())) headers[k] = inbound[k];
}
```

---

### LOW-SEC-2: 2.5 MB bundles include react-native and viem (large supply chain surface)

**Evidence:** `esbuild` bundles are 2.5 MB each. `npm warn cleanup` shows `react-native` and `viem` packages being pulled in as transitive deps of `@clerk/chrome-extension`.

**Risk:** The extension's content security policy (`script-src 'self'`) means only bundled code runs — no remote scripts. However, 2.5 MB bundles that include `react-native` (a mobile UI library with no extension use case) represent a significant supply-chain surface. A compromise of any of those transitive packages could inject malicious code.

**Recommended action (Phase 2):**
1. Run `npm ls` to identify why `react-native` and `viem` are in the dep tree (likely indirect Clerk deps).
2. Evaluate whether a lighter Clerk integration (e.g., only the JWKS verification part) would reduce the bundle.
3. Consider `esbuild --external:react-native` or similar tree-shaking improvements.

---

### LOW-SEC-3: Expired `authToken` persists in `chrome.storage.local` across browser sessions

**Files:** `content/api-client.js:37-41`, `background/service-worker.src.js:196-217`

`authToken` is stored in `chrome.storage.local` and loaded on content script init. If the Clerk session expires (JWT TTL ~1h) and the user doesn't open the popup to trigger a refresh, the stale token persists in storage. On next page load the content script loads the expired token and sends it with API requests, getting 401s before the SW fallback kicks in.

On shared clinical workstations (doctor logs out of Chrome but doesn't sign out of the extension), the token remains in local storage until it expires server-side.

**Recommended action:** Hook into Clerk's `signedOut` / session-expired events and explicitly call `chrome.storage.local.remove(['authToken', 'refreshToken'])`.

---

## INFO / Verified Good

### INFO-SEC-1: `CLERK_PUBLISHABLE_KEY` hardcoded in service worker

**File:** `background/service-worker.src.js:12`

`const CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsudG9jYWZpY2hhZHIuY29tLmJyJA'`

This is the Clerk **publishable** key (prefix `pk_live_`), not the secret key (`sk_live_`). Publishable keys are designed to be embedded in client-side code and published — they are used to initialize the Clerk client and are visible to any user who loads the extension. This is by design and not a vulnerability.

---

### INFO-SEC-2: `TOCAFICHADR_AUTH_REQUIRED` now enabled in production

**Evidence:** Commit `8d6c2ab` enables `TOCAFICHADR_AUTH_REQUIRED` server-side. Previously, API endpoints could be called unauthenticated, which was flagged in prior security reviews.

**Status: RESOLVED.** All API routes now require a valid Clerk JWT. The `auth.py` decorator (`@require_auth`) is applied to extension API routes per the spot-check of `extension_api.py` and `routes.py`.

---

### INFO-SEC-3: Sender allowlisting and message-type gating are correctly implemented

**Files:** `background/service-worker.src.js:234-278`

The SW's `onMessage` listener:
1. Rejects any message from an untrusted sender (not extension-own URL and not Clerk hosted UI).
2. Restricts telemetry-only senders (Clerk hosted UI) to `TOCAFICHADR_DEBUG_LOG` messages only.
3. Returns `{ ok: false, __error: 'Untrusted sender' }` for all other cases.

This correctly mitigates confused-deputy attacks where a malicious web page's content script tries to send messages to the extension's SW. **This is industry-grade for a Chrome extension.**

---

## Previously Disclosed / Tracked

| Finding | Status | Tracking |
|---|---|---|
| Old vendor keys (Groq, OpenAI, Clerk) in `backend/.env.bak` git history | Keys rotated | CHRA-858 |
| Embedded GitHub PAT in git remote URL | Not yet rotated | CHRA-885 Phase 0 comment |
| `TOCAFICHADR_AUTH_REQUIRED` disabled server-side | Fixed in commit 8d6c2ab | — |

---

## Manifest Permissions Audit

| Permission | Justification | Risk |
|---|---|---|
| `activeTab` | Content script needs active tab info | Low — scoped to active tab |
| `storage` | Extension state, user config, auth token | Low — local to extension |
| `cookies` | Clerk session cookie sync | Medium — read all cookies for host_permissions hosts |
| `scripting` | `executeScript` for `DISARM_BEFOREUNLOAD` | Low — whitelisted to specific tab IDs |
| `clipboardWrite` | Copy SOAP/CID to clipboard | Low |
| `sidePanel` | Side panel UI | Low |
| `offscreen` | Audio capture via offscreen document | Low |

**Host permissions** are scoped to: one G-Hosp instance (`prbentogoncalves.g-hosp.com.br`), localhost/dev ports, the production API domain, Cloudflare tunnels (wildcard `*.trycloudflare.com`), GitHub gist (discovery), and Clerk domains.

**Notable:** `*.trycloudflare.com/*` is a wildcard for all Cloudflare tunnel URLs — necessary for dev workflow but means any trycloudflare tunnel that the extension's SW talks to gets full API access. This is controlled by the discovery allowlist (`API_HOSTS_ALLOWLIST`) in the SW, which limits actual communication to the validated URL. Host permissions alone don't restrict what the extension *actually* talks to.

---

## Conclusion

No unmitigated critical findings. One high finding (GitHub PAT rotation) is a process issue with a clear remediation path. The old secret material in history is inert (keys rotated). The active codebase demonstrates strong security thinking: sender allowlisting, auth token management, API proxy URL validation, PII hygiene, and Clerk JWT verification. Phase 2 should track the PAT rotation and cookie-stripping as separate child issues.
