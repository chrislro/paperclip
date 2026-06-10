---
skill: /gsd-audit-fix
source: audit-uat
dry-run: true
date: 2026-05-17
phase: 006-code-quality-sweep-2026-05-17
---

# Audit Fix Classification — tocafichadr-extension

**Mode:** dry-run (no code changes made — classification only)

This report classifies all 18 findings from the Phase 006 sweep (code review + security review + CSO) into fix categories: auto-fixable, semi-automated, manual, and deferred. The classification informs the CTO triage and follow-up issue creation.

---

## Classification Matrix

| ID | Severity | Fix Category | Effort | Risk of Fix |
|---|---|---|---|---|
| CSO-001 | Critical | **Manual — Out-of-band** | High | Medium (force-push, notify collaborators) |
| CSO-002 | High | **Auto-fixable** | Low | Very Low |
| CSO-003 | High | **Semi-automated** | Medium | Low |
| CSO-004 | High | **Manual** | Medium | Medium (test auth flow after) |
| CSO-005 | Medium | **Manual — Investigation** | Low | Low |
| CSO-006 | Medium | **Deferred** | Low | None (doc only) |
| CSO-007 | Medium | **Manual — Verification** | Low | None (verify prod manifest) |
| CSO-008 | Medium | **Manual** | Medium | Low |
| CSO-009 | Medium | **Manual** | Medium | Low |
| CSO-010 | Medium | **Deferred** | Low | None (accept risk or restrict) |
| CSO-011 | Low | **Auto-fixable** | Low | Very Low |
| CSO-012 | Low | **Auto-fixable** | Low | Very Low |
| CSO-013 | Low | **Auto-fixable** | Low | Very Low |
| CSO-014 | Low | **Auto-fixable** | Low | Very Low |
| CSO-015 | Low | **Auto-fixable** | Low | Very Low |
| CSO-016 | Info | **Semi-automated** | Medium | Low |
| CSO-017 | Info | **Auto-fixable** | Low | None |
| CSO-018 | Info | **Manual — Investigation** | Low | None |

---

## Batch 1 — Auto-fixable (implement in one PR)

These can be fixed safely without architectural decisions:

| ID | Fix |
|---|---|
| CSO-002 | Redact `code=`, `state=`, `session_token=` in `clerk-tap.js` URL logging |
| CSO-011 | Add default case in SW message handler |
| CSO-012 | Add `chrome.offscreen.hasDocument()` guard before offscreen message sends |
| CSO-013 | Add `window.addEventListener('beforeunload', _vadTeardown)` in `audio-capture.js` |
| CSO-014 | Change fallback in `user-config-client.js:_resolveApiBase()` to `https://api.tocafichadr.com.br` |
| CSO-015 | `git rm --cached popup/popup.bundle.js` |
| CSO-017 | Update `package.json` name + URLs to `tocafichadr-extension` |

**Estimated implementation time:** 45–60 minutes total. No test suite changes needed; verify with `npm run test` afterward.

---

## Batch 2 — Semi-automated (requires focused implementation + testing)

| ID | Fix | Notes |
|---|---|---|
| CSO-003 | Add PII scrubber to `console-shipper.js` | Add 200-char truncation + CID pattern redaction. Test by checking debug-log entries in staging. |
| CSO-016 | Extract `_normalizeApiError` to `shared/error-helpers.js` | Must update both `background/service-worker.src.js` (import) and `content/api-client.js` (script load order). Verify bundling in both contexts. |

---

## Batch 3 — Manual / Investigation Required

| ID | Fix | Blocker |
|---|---|---|
| CSO-001 | BFG history scrub + secret rotation | Needs MacBook (git force-push). Confirm secrets already rotated first. |
| CSO-004 | Remove auth token from content-script memory | Audit all callers of `window.TOCAFICHADR_api.getToken()` (if any) before removing the load. May break callers. |
| CSO-005 | Audit Clerk SDK `cookies` requirement | Check `@clerk/chrome-extension` v3.x release notes for background mode requirements. |
| CSO-008 | Mirror API discovery at first-party URL | Requires backend change to add `/config/api-url.json` endpoint. Cross-repo change. |
| CSO-009 | Add auth token expiry check | Requires storing expiry alongside token (Clerk JWT `exp` claim). Coordinate with Clerk auth flow changes in phase 005. |

---

## Batch 4 — Deferred / Accept Risk

| ID | Finding | Disposition |
|---|---|---|
| CSO-006 | `style-src unsafe-inline` | Document which component requires it. Defer fix to TypeScript migration or component refactor. Create tracking ticket. |
| CSO-007 | Dev host permissions in prod manifest | Verify `manifest.prod.json` already excludes them (likely done). Close as verified. |
| CSO-010 | `*.trycloudflare.com` wildcard | Accepted risk for current dev workflow. Document in security policy. |
| CSO-018 | `vercel.json` in extension repo | Investigate at next code session. Low priority. |

---

## Recommended Fix Sequencing (for CTO triage)

1. **Immediately (CTO judgment):** CSO-001 — BFG scrub. Secret rotation must be confirmed first.
2. **Next PR after CSO-001:** Batch 1 auto-fixes (CSO-002, 011–015, 017) — one PR, one review, minimal risk.
3. **Separate PR:** Batch 2 semi-automated (CSO-003, 016) — needs test verification.
4. **Phase 005 completion gate:** CSO-004 and CSO-009 — defer until Clerk migration in phase 005 is done to avoid touching auth flow twice.
5. **Backend coordination:** CSO-008 — cross-repo change, create child issue targeting the backend repo.
6. **Deferred/accepted:** CSO-006, CSO-007, CSO-010, CSO-018 — no action or verify-then-close.

---

## npm audit findings (FYI)

```
Vulnerabilities: 0 (info: 0, low: 0, moderate: 0, high: 0, critical: 0)
Total packages: 511
```

No dependency vulnerabilities to fix.
