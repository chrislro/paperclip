# Phase 003 — User-Account-Linked Config (v3.5.x)

> **Status**: planning · 4 plans queued · 03-01 about to execute
> **Strategic source**: 2026-05-10 conversation — "each config should be linked to each user's accounts, which are accessible via Clerk. The user can't modify anything before logging in."
> **Depends on**: phase 002 (Clerk migration) — ✅ landed `v3.0.0`. `g.user_id` is populated by `auth.require_auth` from a verified Clerk JWT.

## Status as of 2026-05-10

Today's behavior:

- All personal config (prescription templates, SOAP voices, custom instructions, doctor name, toggles) lives in `chrome.storage.sync`.
- `chrome.storage.sync` is bound to whichever Google account is signed into Chrome — not to the doctor's Clerk identity.
- On a **shared hospital Chrome** with one Google login, multiple doctors using tocafichadr would write into the same bucket. Every doctor would inherit the previous doctor's templates / voices / SOAP rules.
- Editing the templates is possible without a Clerk session at all. Auth is only enforced today on `/api/transcribe`, `/api/suggest-cid`, `/api/format-soap`, `/api/audit/manual`, billing, and rx-stats.

Goal of this phase:

- All user-specific config lives **server-side**, keyed to the Clerk userId (`User.id` resolved via `auth._resolve_user_id`).
- The extension UI **requires an active Clerk session before any config can be read or edited**. Signed-out state shows only the sign-in CTA.
- `chrome.storage.local[<key>_<uid>]` is a hydrated cache, wiped on signout.
- `chrome.storage.sync` is **retired for personal data**. Non-personal global settings (e.g. `apiBaseUrl` discovery cache) may stay there.
- First sign-in for a new user → backend seeds `DEFAULT_RX_TEMPLATES` (mirror of `DEFAULT_TEMPLATES_V31`) into the user's row.

## Success criteria (what must be TRUE)

1. **Backend has a `user_configs` table**, one row per `users.id`, with JSON columns for `rx_templates` and `voices`, plus scalar columns for `custom_instructions`, `doctor_name`, and the three boolean toggles.
2. **`GET /api/me/config` and `PATCH /api/me/config`** are gated by `@require_auth`. Unauthed → 401. First GET for a new user lazily seeds defaults and returns them.
3. **Extension side panel and popup render a `<div id="auth-gate">` sign-in CTA when no Clerk session.** The receita section, the editor, the action buttons, and the atestado drawer are all hidden when signed out.
4. **All personal `chrome.storage.sync` reads/writes are replaced** by `chrome.storage.local[<key>_<uid>]` cache + `PATCH /api/me/config` write-through. A static-analysis tripwire fails if `chrome.storage.sync.get(['prescriptionTemplates'...])` reappears in any personal-config code path.
5. **Sign-out clears the user's local cache key** (`chrome.storage.local.remove('config_<uid>')`).
6. **Migration**: legacy `chrome.storage.sync.prescriptionTemplates` is **discarded** on first authed hydrate (no upload, no prompt) — the shared-hospital-machine constraint makes any "upload local data" dangerous.

## Plans

| # | Plan | Type | Files | Status |
|---|---|---|---|---|
| 03-01 | Backend: `UserConfig` model + `GET/PATCH /api/me/config` + seed defaults + tests | execute | `backend/emr_automation/{constants,models}.py`, `backend/emr_automation/dashboard/routes.py`, `backend/tests/test_user_config.py` | pending |
| 03-02 | Side panel + popup: sign-in gate UI (`#auth-gate`, `body[data-authed]`, hide gated UI when signed out) | execute | `sidepanel/sidepanel.html`, `sidepanel/sidepanel-prontuario.js`, `popup/popup.bundle.js` (or src), CSS | pending |
| 03-03 | Replace `chrome.storage.sync` reads/writes for personal data with hydrator + cache + write-through `PATCH` | execute | `sidepanel/sidepanel-prontuario.js`, `popup/popup.src.js`, `background/service-worker.src.js` (allowlist for `/api/me/config`) | pending |
| 03-04 | Tests + parity guards: endpoint smoke tests, signed-out-blocked tests, hydrator tests, regex tripwires for `chrome.storage.sync` in personal-config paths | execute | `backend/tests/`, `scripts/test-config-gate.js`, `scripts/selftest.sh` | pending |

## Out of scope (this phase)

- **Cross-device offline conflict resolution.** Last-writer-wins by `updated_at` is the policy; no merge UI.
- **Server-side analytics on individual templates.** `/api/rx-stats` already aggregates by `template_used` string from `audit_log`; we don't add per-template-row queries server-side.
- **Migration of voices / custom_instructions from old `chrome.storage.sync` keys.** Legacy data is discarded on first authed hydrate. If a doctor wants to keep their voices, they re-add them once.
- **Soft-delete + restore UI for templates.** Hard delete from the `rx_templates` JSON array is fine for v1.
- **Per-template granular endpoints** (`PUT /api/me/config/rx-templates/:id`). The PATCH-the-whole-array shape is sufficient for the side-panel debounce-and-write pattern.
- **Backfill of existing User rows.** Lazy-seed on first `GET /api/me/config` is sufficient — every existing user will trigger it on next sign-in after this phase ships.

## Migration & rollout notes

- **No client breaking change** when 03-01 alone ships — the new endpoints exist but nobody calls them yet. Risk is contained to the new test suite.
- **03-02 + 03-03 ship together** as the user-facing change. Without 03-02 (sign-in gate), 03-03's hydrator has no signal to wait for. Without 03-03, 03-02 displays a logged-in UI that still reads from `chrome.storage.sync`.
- **`v3.5.0` is the current manifest version** — bump to `v3.6.0` on the 03-02 + 03-03 ship since signed-out behavior is a user-visible change.
- **Mac Mini deploy after 03-01**: run pytest, then `launchctl kickstart -k gui/$(id -u)/com.tocafichadr.cloud-api` to pick up the new model + routes. SQLite auto-creates the `user_configs` table on next request via `Base.metadata.create_all`.
