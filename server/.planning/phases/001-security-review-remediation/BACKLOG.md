# Phase 001 Backlog — items deferred from the 2026-04-22 review

Items from the review that are **not** being executed as plans in phase 001. Reasons per item.

## Deferred to a different repo (Flask backend, Mac Mini)

These live in `/Users/admin/Dev/Pediatrics/` and must be shipped there with coordinated testing against the live tunnel.

- **P0-1-flask** — Enforce `Authorization: Bearer` on `/api/transcribe`, `/api/health`, `/api/selectors`, `/api/audit/*`, `/api/error-log`. **Highest remaining severity** — until this ships, the Cloudflare Tunnel URL is effectively the credential. Suggested: add a `@require_bearer` decorator in `emr_automation/auth.py` and wrap all `routes.py` views that currently call the OpenAI client. Verify via curl from a laptop without Tailscale.
- **P1-3 (server half)** — Match the SW error-port-closed translation server-side: Flask should return `{error: 'timeout'}` with a 504 rather than hanging past the SW's 30 s. Client half (friendlier error message + audio blob cache for retry) is in-repo but deferred to a follow-up phase because it needs this server change to be useful.
- **P1-8** — Short-lived access tokens (≤15 min) + rotating refresh tokens with server-side revocation. Needs a revocation store on Flask (Redis or in-memory with TTL). Non-trivial; schedule with the cloud-product milestone.
- **P1-9 (server half)** — Scrub `chief_complaint` and `intern_id` from Flask request logs; document raw-audio retention (target ≤24 h); add an LGPD data-processing agreement section to `PRIVACY_POLICY.md`. Client half (strip `intern_id` from `logAudit` payloads) can ship separately.

## Deferred because they need live-shift verification

These change behavior in the clinical path and cannot be autonomously executed — they require a pediatrician physically testing on the live G-Hosp against a real patient.

- **P0-4** — Rework `verifyDischargeComplete` to drop the "no error after 4 s = success" fallback; return *inconclusive* when no strong signal; surface "não foi possível confirmar alta — verifique manualmente" in the HUD and skip `goToMainList()`. Known risk: the current behavior favors false-positives (doctor advances to the next patient even when discharge actually failed). The fix is obvious in code but the calibration of signals (success-toast selector, delay window) needs live observation.
- **P0-5** — Stop `innerHTML`-assigning LLM-generated SOAP into the wysihtml5 iframe. Safer approach: return plaintext from Flask, reconstruct paragraphs via `textContent` + `<br>` DOM nodes. Depends on Flask returning plaintext (coordinated rollout). Needs visual regression check on a real patient's SOAP to confirm line breaks still render as expected.
- **P1-6** — Rewrite the `MutationObserver` in `content.js` to fire only on URL-change (wrap `history.pushState` + `popstate`). Add `if (state.recording || state.processing) return` guard in `autoSetupPatientPage` to prevent mid-record SOAP clearing. Risk: SPA nav timing on G-Hosp is subtle; incorrect gating can stop the observer from firing at all.

## Deferred to a later phase / quality backlog

Lower priority but tracked so they aren't forgotten:

- **P2-1** — Signed discovery document (detached signature verified with an embedded pubkey) for the apiBaseUrl gist. The 2026-04-22 hostname allowlist closes the worst case; signing is the stricter follow-up.
- **P2-2** — Clipboard auto-copy of SOAP becomes opt-in (default off) with a 30s TTL clear.
- **P2-3** — Add explicit CSP to `manifest.json`: `extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'"`.
- **P2-5** — `api-client.js` retry after 401: `delete options.headers['Authorization']` before recursion.
- **P2-6** — SOAP textarea/editor HTML-entity sync.
- **P2-7** — Either implement server-side FREE_DAILY_LIMIT gating or remove the misleading free-tier UI copy in `hud.js`.
- **P2-8** — Drop unused `scripting` permission from manifest; drop `canvas@^3.2.3` from `package.json`.
- **P2-9** — Route popup `/api/health` call through the SW proxy for consistency. Depends on P0-1-flask (the endpoint must require auth first).
- **P3-*** — LGPD data-subject-access endpoint, SAST/dep-scanning CI, prompt-injection guards in Flask, truncated UA/stack in error telemetry, migration of `pedbot*` storage keys, `noopener,noreferrer` on external window.open.

## How to re-activate an item

When a deferred item becomes actionable (e.g. Flask repo has capacity, or we're planning a live-shift to test P0-4), create a new phase file:

1. Copy an existing plan (e.g. `01-01-PLAN.md`) as a template.
2. Rename to `NN-MM-PLAN.md` under the target phase directory.
3. Remove the item from this BACKLOG.md.
4. Update `ROADMAP.md` with the new phase and its plans.
