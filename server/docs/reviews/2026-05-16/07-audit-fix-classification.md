# Audit-Fix Classification — tocafichadr-extension
**Date:** 2026-05-17  
**Phase:** 006-code-quality-sweep-2026-05-16  
**Source:** audit-uat (manual classification from 006-REVIEW + 04-security-review + 05-cso.json)  
**Mode:** DRY RUN — no changes made, no issues created yet  
**Reviewer:** Paperclip Researcher (CHRA-885)

---

## Classification Summary

Phase 2 will triage these findings into per-finding child issues. This file classifies each finding by:
- **Fix type:** `code_fix` / `config_change` / `process_change` / `documentation` / `skip`
- **Scope:** `extension-frontend` / `extension-sw` / `backend` / `ci` / `devops`
- **Effort:** `trivial` (<30 min) / `small` (1-4h) / `medium` (half day) / `large` (1+ day)
- **Priority:** `P0` (blocker) / `P1` (next sprint) / `P2` (backlog)
- **Dependency blocks?** — yes/no; if yes, what does it unblock

---

## Findings → Actions

### CSO-001 / HIGH-SEC-1: GitHub PAT in git remote URL
| Field | Value |
|---|---|
| Fix type | `process_change` + `config_change` |
| Scope | `devops` |
| Effort | trivial |
| Priority | P1 |
| Blocks? | No |

**Dry-run action:** Rotate PAT on GitHub. Run `git remote set-url origin git@github.com:chrislro/tocafichadr-extension.git` on all checkouts (main + all worktrees). Document in `CONTRIBUTING.md` that remotes must use SSH, not HTTPS+PAT.

---

### CSO-002 / MED-SEC-1: Vendor secrets in git history
| Field | Value |
|---|---|
| Fix type | `process_change` |
| Scope | `devops` |
| Effort | medium |
| Priority | P2 |
| Blocks? | No (keys already rotated) |

**Dry-run action:** Decision needed from CEO (CHRA-885 Phase 2 board). Two paths:
- **Path A (clean):** `git filter-repo --path backend/.env.bak --invert-paths` + force-push. Requires disabling branch protection temporarily; all worktrees must re-clone.
- **Path B (document):** Add "Known history exposure — keys rotated CHRA-858" section to `SECURITY.md`. Mark CSO-002 as permanently-mitigated-not-remediated.

**Recommend Path B** given active Clerk migration (CHRA-651) and multiple open worktrees.

---

### CSO-003 / LOW-SEC-3: Stale authToken in storage on sign-out
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `extension-sw` + `extension-frontend` |
| Effort | small |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** In popup's Clerk `addListener` handler, add `chrome.storage.local.remove(['authToken', 'refreshToken'])` on `signedOut` / `sessionTokenObtained` (when new session replaces old). Also add explicit clear in `api-client.js:clearToken()` (already does this — verify it's called on sign-out).

---

### CSO-004 / HIGH-1 (code): Dual auth-token storage race
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `extension-sw` + `extension-frontend` |
| Effort | medium |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Architectural refactor — single source of truth for auth. Defer to Phase 3 (post-Clerk migration CHRA-651). For now, ensure popup always calls `setToken(freshToken)` after every `clerk.session.getToken()` call.

---

### CSO-005 / LOW-1 (code): Cookie headers not stripped in proxy
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `extension-sw` |
| Effort | trivial |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** One-line change in `_handleFetch`: extend header strip to include `cookie` and `set-cookie`.

```js
// Current:
if (k.toLowerCase() !== 'authorization') headers[k] = inbound[k];
// Fix:
const STRIP = new Set(['authorization', 'cookie', 'set-cookie']);
if (!STRIP.has(k.toLowerCase())) headers[k] = inbound[k];
```

---

### CSO-006 / LOW-SEC-2: Large bundle / supply-chain surface
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `ci` + `extension-frontend` |
| Effort | large |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Spike task — investigate which Clerk import path produces the lightest bundle. Try `@clerk/chrome-extension/browser` vs `@clerk/chrome-extension`. Add bundle-size check to CI (fail if bundle > 3 MB). Not urgent: current 2.5 MB is within Chrome Web Store limit.

---

### CSO-007 / MED-4: canvas in dependencies
| Field | Value |
|---|---|
| Fix type | `config_change` |
| Scope | `ci` |
| Effort | trivial |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Move `canvas` from `dependencies` to `devDependencies` in `package.json`. Verify `npm ci --production` still passes the selftest.

---

### CSO-008 / LOW-1 (code): Hardcoded G-Hosp hostname in trusted-origin list
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `extension-sw` |
| Effort | small |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Add `emrBaseUrl` to `chrome.storage.sync` defaults (defaulting to the hardcoded value). Have `_isTrustedSender` load from storage at startup. This makes the EMR host remotely configurable without an extension update.

---

### CSO-009 / LOW-5: _swDebugLog rate limit
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `extension-sw` |
| Effort | trivial |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Add `let _swDiagCount = 0; let _swDiagResetAt = Date.now() + 60000;` guard at the top of `_swDebugLog`. Increment on each call; reset at window boundary. Skip POST when `_swDiagCount > 10` until window resets.

---

### CSO-010 / LOW-2: 150ms setTimeout in offscreen startup
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `extension-sw` |
| Effort | small |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Replace `await new Promise(r => setTimeout(r, 150))` with `await new Promise(r => { offscreenReadyResolver = r; })` (the resolver is already set when `OFFSCREEN_READY` arrives). Requires verifying no other code path resets `offscreenReadyResolver` to null prematurely.

---

### MED-1 / Code quality: _normalizeApiError duplicated
| Field | Value |
|---|---|
| Fix type | `code_fix` |
| Scope | `extension-frontend` + `extension-sw` |
| Effort | small |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Extract to `shared/error-normalize.js`. Bundle into both SW (esbuild `--bundle`) and inject as content script (alongside `shared/console-shipper.js`). Keep the function identical; add an integration test that both contexts produce the same error string for the same input.

---

### NIT-1: package.json name field stale
| Field | Value |
|---|---|
| Fix type | `config_change` |
| Scope | `ci` |
| Effort | trivial |
| Priority | P2 |
| Blocks? | No |

**Dry-run action:** Change `"name": "pedbot-extension"` to `"name": "tocafichadr-extension"` in `package.json`.

---

### NIT-4: store/description.txt references "PedBot"
| Field | Value |
|---|---|
| Fix type | `documentation` |
| Scope | `devops` |
| Effort | trivial |
| Priority | P1 |
| Blocks? | Yes — Chrome Web Store listing accuracy |

**Dry-run action:** Update `store/description.txt` to remove "PedBot" references. This affects the Chrome Web Store listing — fix before next submission.

---

## Findings Classified as SKIP / No Action

| Finding | Reason |
|---|---|
| INFO-SEC-1: CLERK_PUBLISHABLE_KEY hardcoded | Intentional; publishable key is meant to be embedded |
| INFO-SEC-2: TOCAFICHADR_AUTH_REQUIRED enabled | Already fixed; no action needed |
| INFO-SEC-3: Sender allowlisting | Correct implementation; no action needed |
| INFO-SEC-4: API proxy validation | Correct implementation; no action needed |
| NIT-2: Manifest action explanation | Documentation-only; no code change needed |
| NIT-3: CHANGELOG.md size | Nice-to-have; not a blocker |
| NIT-5: tokens.css in sidepanel | Needs investigation; add to Phase 2 backlog |

---

## Proposed Phase 2 Child Issues

| Priority | Issue | Effort | Type |
|---|---|---|---|
| P1 | Rotate GitHub PAT + switch remote to SSH | trivial | devops |
| P1 | Fix store/description.txt PedBot references | trivial | copy |
| P2 | Strip cookie headers in _handleFetch proxy | trivial | code |
| P2 | Add _swDebugLog rate limit | trivial | code |
| P2 | Move canvas to devDependencies | trivial | config |
| P2 | Fix package.json name field | trivial | config |
| P2 | Replace 150ms sleep with offscreenReadyResolver in SW | small | code |
| P2 | Add Clerk signedOut hook to clear authToken from storage | small | code |
| P2 | Spike: reduce bundle size (react-native/viem in Clerk deps) | large | code |
| P2 | Document git history exposure in SECURITY.md (Path B) | small | docs |

**Total P2 trivial/small fixes: 8 issues, estimated 4-6h total engineering time.**

---

## Phase 005 Verification

```
git diff main -- .planning/phases/005-production-clerk-migration/
```
Output: (empty) — **Phase 005 is UNTOUCHED. ✓**
