# Next Steps — 2026-05-02 (post-v3.0.4 + domain live)

> **Updated**: 2026-05-02 PM (post-v3.0.4 + production domain). The v3.0 Clerk migration plus four follow-on patch releases shipped in a 2-day window. **`tocafichadr.com.br` is now live** with valid SSL, served by Vercel via GitHub auto-deploy.
>
> **Current state**:
> - Extension at **v3.0.4** (`tocafichadr-extension @ ee08545`, tags `v3.0.0` / `v3.0.1` / `v3.0.3`).
> - Backend on Mac Mini at `81b77cc` — unified repo `backend/`, migrated from Pediatrics. PRs #3 (Clerk JWKS) + #4 (webhook) + #5 (SOAP plan extract) + #6 (test coverage) all merged. Auth gate **off** through cutover window.
> - Web Store zip ready: `tocafichadr-v3.0.4.zip` (1.78 MB compressed). Listing copy in `store/description.txt`. Submission walkthrough in [`v3.0-WEB-STORE-SUBMIT.md`](v3.0-WEB-STORE-SUBMIT.md).
> - Phase 002 plan: [`.planning/phases/002-clerk-migration/PLAN.md`](../.planning/phases/002-clerk-migration/PLAN.md) — 6/9 complete, 3 user-side pending.
> - Single source of truth for milestone planning: [`ROADMAP-v2.6-to-v2.9.md`](ROADMAP-v2.6-to-v2.9.md).
>
> **What shipped 2026-05-01 → 2026-05-02** (v3.0 release window):
>
> | Version | Commit | What |
> |---------|--------|------|
> | v3.0.0 | `088a052` | Clerk auth migration end-to-end (popup + SW + Flask + webhook + privacy) |
> | v3.0.1 | `2fa7fa6` | Spinner overlay during Gravar prescription save (mash-click footgun fix) |
> | v3.0.2 | `ce82ef9` | CID autocomplete jQuery lifecycle fix — `trigger(evt, [ui])` not `(evt, ui)`, plus close + change + blur events |
> | v3.0.3 | `24b5e31` | `fillRecomendas()` auto-populates `#recomendas_descricao` from extracted SOAP plan (unified repo, originally Pediatrics PR #5) |
> | v3.0.4 | `ee08545` | Seeded 10 pediatric posology defaults + "↺ Restaurar padrões" button |
> | infra | `a96a060` | Vercel + GitHub sync — `vercel.json` skips esbuild build, serves `landing/` static |
> | infra | `8674d49` | GitHub URL repo-rename fix + favicon + version stamp |
> | infra | `11d7a44` | `cleanUrls: true` so `/privacidade` resolves without `.html` |
> | domain | DNS | `tocafichadr.com.br` registered at HostGator (R$77/2yrs); A → 76.76.21.21, CNAME www → cname.vercel-dns.com; MX kept at HostGator for future email; Let's Encrypt SSL provisioned automatically |
> | Backend PR #5 | `81b77cc` | `_extract_plan_from_soap()` + `plan` response field (unified repo `backend/`) |
> | Backend PR #6 | `12e8ad3` | 23 Clerk auth + webhook tests (R-03 + R-04) (unified repo `backend/`) |

---

## What shipped since the last update (2026-04-22 → 2026-05-01)

| Date | Version | Highlights |
|------|---------|------------|
| 2026-05-01 | **v2.5.10** | Atestado completion flow (selectors, runAtestadoFlow, finalizeAtestado, HUD button + finalize bar). |
| 2026-05-01 | **v2.5.11** | HUD layout refresh (320 px wide, 2×2 action grid, shared finalize-bar styling, gradient record button). |
| 2026-05-01 | **v2.6.0** | Security & resilience milestone. Bearer-auth gate on Flask `/api/*` (deploy-safe — gated by `TOCAFICHADR_AUTH_REQUIRED` env var). Flask OpenAI client `max_retries=0, timeout=30`. SOAP HTML sanitizer verified. `track.mute` listener. |
| 2026-05-01 | **v2.6.1** | Service-worker `_authedFetch` + `_refreshAccessToken` with single-flight refresh, refresh-token rotation, 401-and-clear on rejected refresh. 6 Node tests covering happy path / refresh success / refresh rejected / concurrent 401s / no-refresh-token / skipRefresh short-circuit. Selftest 7/7 → 8/8. |
| 2026-05-01 | **strategy** | `docs/STRATEGY-saas.md` — decision to migrate to Clerk for v3.0 before Web Store submission. |
| 2026-05-01 | **v2.6.2** | Task 2.7.2 — `processDischarge` now pre-fills `#alta_data_alta` with today's date in DD/MM/YYYY when the field is empty. Defensive: never overwrites an existing value, never blocks discharge if pre-fill throws. Eliminates 8-18 manual focus events per shift. |
| 2026-05-01 | **v2.6.3** | Bundle: (a) light 2.7.5 — `openPrescription` retries the click once with 1.5 s backoff if dialog times out (covers transient 406 blips); (b) GSTACK P2-3 — CSP `script-src 'self'; object-src 'self'; base-uri 'none'` on `extension_pages`; (c) task 2.9.5 — `getEffectiveAudioConfig()` + `transcribe_success` audit log captures actual `audioBitsPerSecond` Chrome negotiated. |

Companion backend (unified repo `backend/`):

- **e7805bb** — Bearer-auth gate (`require_extension_or_user`) + OpenAI client hardening. Deployed on Mac Mini from `~/Dev/tocafichadr-extension/backend/` 2026-05-01. Smoke `/api/health` 200, `/api/transcribe` 400 (= optional_auth fallback intact, gate off).

---

## P0 — Post-v3.0 user-side handoff

### Web Store submission (v3.0.8) — **now unblocked**
Zip ready (`tocafichadr-v3.0.4.zip`). Walkthrough in [`v3.0-WEB-STORE-SUBMIT.md`](v3.0-WEB-STORE-SUBMIT.md). Privacy URL `https://tocafichadr.com.br/privacidade` is now live (was the last infra blocker). Need: 5x 1280×800 screenshots + Chrome Web Store dashboard login + privacy-practices form. Estimated 1 hour user time.

### Live-shift smoke (v3.0.6)
Real recording session with the new Clerk-authed flow before Web Store submission. Confirms: voice → SOAP, CID autofill, prescription template, atestado, finalize. ~3 hours of clinical use.

### Flipping `TOCAFICHADR_AUTH_REQUIRED=true` on Mac Mini
Add to plist via PlistBuddy after 24-48h soak with v3.0.x clients dominating. Old v2.6.x extensions (still on HS256) get hard-blocked once flipped — only safe after the Web Store rollout is widespread.

### Clerk webhook signing secret
Optional but recommended. Clerk dashboard → Webhooks → register `<tunnel>/clerk/webhook` for `user.created/updated/deleted`. Copy `whsec_...` → add to plist. Without this, `auth.py`'s lazy provisioning still creates User rows on first authenticated request, so it's non-blocking for v3.0.

---

## P1 — Code-only work (no user action required)

Each is a self-contained extension-side change with log evidence and selftest coverage. Strikethrough = shipped.

### ~~v2.7.2 — Pre-fill `#alta_data_alta` with today's date~~  ✅ shipped in v2.6.2
- `content/dom-engine.js` `processDischarge` step 2.5: empty-check → DD/MM/YYYY → input/change dispatch. Defensive, non-blocking.
- Eliminates 8-18 manual focus events per shift.

### ~~v2.7.5 (light) — retry-on-timeout on `openPrescription`~~  ✅ partially shipped in v2.6.3
- One-retry-with-1.5s-backoff if `_waitForDialogContent` times out. Covers transient 406 blips without G-Hosp DOM manipulation.
- **Still pending — full circuit-breaker**: detect `chrome-error://chromewebdata/` navigation via SW `chrome.webNavigation`, recover the patient page, then retry. Needs a dedicated session.
- **Evidence**: Apr 15 L412-L448 (10× HTTP 406 + 5× Reload + 4× Adicionar = 27 min lost on patient 1887000).

### ~~v2.7.3 — `#recomendas_descricao` auto-fill from SOAP plan~~  ✅ shipped in v3.0.3
- Unified repo `backend/` (originally Pediatrics PR #5, `81b77cc`) added `_extract_plan_from_soap()` + `plan` response field; extension `24b5e31` added `BUNDLED_SELECTORS.recomendas_field` + `fillRecomendas(planText)` utility + side panel wiring.
- Non-destructive — skips fill if doctor already typed content. Backwards-compat with pre-v3.0.5 Flask via empty-string no-op.

### ~~v2.6.5 — Spinner / disabled state during prescription save~~  ✅ shipped in v3.0.1
- `2fa7fa6`: `_lockDialog(message)` / `_unlockDialog()` utilities in `dom-engine.js`. Viewport-covering overlay (`.tfdr-dialog-lock` in `styles/hud.css`) with brand-color teal spinner panel. MutationObserver auto-unlocks if G-Hosp removes the host dialog. 30 s safety timeout. Print-link wait extended from 5 s → 30 s to match.
- Wired into `finalizeSimplesPrescription` — lock before Gravar click, unlock before printLink click and on every error path.

### ~~CSP on extension_pages~~  ✅ shipped in v2.6.3
- `manifest.json` `content_security_policy.extension_pages` = `script-src 'self'; object-src 'self'; base-uri 'none'`. Closes GSTACK P2-3.

### ~~Audit telemetry: capture actual audioBitsPerSecond~~  ✅ shipped in v2.6.3 (was P4 v2.9.5)
- `content/audio-capture.js` `getEffectiveAudioConfig()`; `content/hud.js` fires `logAudit('transcribe_success', { mimeType, audioBitsPerSecond, requestedBitsPerSecond, blobBytes })` after every successful transcribe. Useful for diagnosing rare quality complaints (Chrome may downshift 32 kbps on weak hardware).

---

## P2 — Code work that needs design + user choice

### ~~v2.7.4 — Favorite drugs panel~~  ✅ shipped in v3.0.4
- `ee08545`: seeded `DEFAULT_RX_TEMPLATES` with 10 common pediatric posologies (Amoxicilina, Ibuprofeno, Dipirona, Prednisolona, Salbutamol, SF nasal, Paracetamol, Tobramicina, Amoxiclav, Loratadina). Names mirror G-Hosp built-in 1080-1089 IDs from CLAUDE.md.
- New "↺ Restaurar padrões" button beside "+ Adicionar modelo" — confirms before clobbering existing user-edited templates.
- Resolved the "alongside vs replace" design question by reusing existing `prescriptionTemplates` (= the favorites feature, just initialized empty before).

### ~~v2.8.1 — Audio silence trimming~~  ✅ already shipped 2026-04-29 in commit `a00da17`
- Web Audio VAD with MediaRecorder.pause/resume during silence — more efficient than post-trim (skips at the source).
- Found during 2026-05-02 audit. NEXT-STEPS hadn't caught up.

### v2.8.2 — Solcab/radiology orders automation (deferred — needs G-Hosp UI observation)
- **Multi-row autocomplete loop**. Selectors: `#solcab_solexames_attributes_*_descricao` (dynamic IDs).
- **New HUD button** "Solicitar Exames" with comma-separated body input (`punho, mao, antebraço`).
- **Evidence**: log Apr 15 L4530, L4551, L4570 (3 sequential autocompletes for one patient).
- **Why deferred (2026-05-02)**: dynamic-ID multi-row autocomplete can't be implemented blindly — needs DevTools observation of the actual solcab dialog flow on a live patient. Owner: Chris (next live shift).
- **Effort**: ~6-8 h.

### ~~v2.8.4 — `#cid_descricao` autocomplete engagement~~  ✅ shipped in v3.0.2
- `ce82ef9`: bug fix in `fillCid` — `jQuery.trigger(evt, [ui])` array form (was passing object, jQuery flattened to single positional arg, ui sometimes `undefined` in handler signature). Plus added `autocompleteclose` + `autocompletechange` events to mimic full menu-click lifecycle, plus native `blur` for Rails UJS observers.

### v2.7.1 — `#tiporec_0` vs `#tiporec_1` browser verification (still pending — needs you)
- **Why deferred**: the CLAUDE.md is internally inconsistent on this; logs alone are ambiguous (doctor clicks `#tiporec_0` → `padraorec_*`, suggesting `#tiporec_0` is "Utilizar Padrões" not "Simples"). Touching `runSimplesPrescription` without DOM verification could break a working flow.
- **Action**: open G-Hosp prescription dialog, inspect both radios in DevTools, document mapping in `CLAUDE.md`. Then either fix `runSimplesPrescription` or document why current code is correct.
- **Owner**: Chris (browser action, not automatable).

---

## ~~P3 — v3.0 Clerk migration~~  ✅ functionally complete (6 of 9 plans landed)

| Plan | Status | Commit |
|------|--------|--------|
| 02-00 Clerk dashboard setup | ✅ done | dashboard `working-chow-0` |
| 02-01 Flask JWKS verify | ✅ done | Backend PR #3 (`e1c88e7`) (unified repo `backend/`) |
| 02-02 Popup → Clerk SignIn | ✅ done | extension `230f507` + CSP fixes |
| 02-03 Drop SW `_authedFetch` | ✅ done | extension `78a7b47` |
| 02-04 Clerk webhook | ✅ done | Backend PR #4 (`04b456f`) (unified repo `backend/`) |
| 02-05 Privacy policy | ✅ done | extension `3c6d1c4` |
| 02-06 Live-shift smoke | ⏸ user — record real consultation | — |
| 02-07 Web Store screenshots | ⚠️ partial — listing + zip done; 5 screenshots pending user | `tocafichadr-v3.0.4.zip` |
| 02-08 Submit to Chrome Web Store | ⏸ user — dashboard login required | — |

Full closeout in `.planning/phases/002-clerk-migration/SUMMARY.md`.

---

## P4 — Operational hygiene (v2.9.0)

| Task | Status |
|------|--------|
| ~~Replace stale `100.116.133.83` (retired) with `100.97.14.32` in `manifest.json`~~ | ✅ confirmed already done. |
| ~~Stand up `tocafichadr.com.br` DNS pointing to landing on Vercel~~ | ✅ shipped 2026-05-02 — apex + www both serve 200, Let's Encrypt SSL valid through 2026-07-31 (auto-renews via Vercel). HostGator MX kept for future email. |
| Set up `api.tocafichadr.com.br` DNS → Cloudflare named tunnel | Pending. Replaces rotating `*.trycloudflare.com` URL for the Mac Mini Flask backend. Subdomain only — apex already in use by landing. |
| Set up `contato@tocafichadr.com.br` mailbox | Pending. HostGator MX is in place — just needs the mailbox provisioned in HostGator cPanel. Privacy policy + listing copy already reference this address. |
| Transfer `tocafichadr.com.br` registration to Registro.br before 2028-09 | Calendar item. HostGator renewal jumps to R$135.98/yr after the R$77/2yrs intro — Registro.br direct is R$40/yr. Initiate transfer ~60 days before expiration. |
| ~~Centralize hostname allowlist regex into `content/config.js`~~ | ✅ closed as no-op 2026-05-02 — the regex only exists in `background/service-worker.src.js`; NEXT-STEPS overstated triplication. |
| ~~Audit telemetry: capture actual `MediaRecorder.audioBitsPerSecond`~~ | ✅ shipped in v2.6.3. |
| ~~Backend test coverage for Clerk auth + webhook~~ | ✅ shipped in Backend PR #6 (`12e8ad3`), 23/23 tests pass. (unified repo `backend/`) |
| ~~Bundle size investigation~~ | Logged as deferred, post-launch metric — popup + SW bundles are 2.5 MB each (Clerk SDK pulls in React); within Web Store limits, follow up if popup TTI in production becomes an issue. |

---

## Observations & memories — not plans

### Backend deploy state (2026-05-02)
- Mac Mini running unified repo backend from `~/Dev/tocafichadr-extension/backend/` via `launchctl` `gui/<uid>/com.pedbot.cloud-api`.
- `EnvironmentVariables` in `~/Library/LaunchAgents/com.pedbot.cloud-api.plist`: `PATH` + `SECRET_KEY` + `CLERK_SECRET_KEY` + `CLERK_AUTHORIZED_PARTIES` (incl. dev extension `chrome-extension://dldnbfjpobloegmdockjpbmpmgaahgan`). Auth gate (`TOCAFICHADR_AUTH_REQUIRED`) still **OFF** through cutover window.

### Backend deploy state (2026-05-01) — pre-unified repo
- Mac Mini at `e7805bb`, Flask via `launchctl` `gui/<uid>/com.pedbot.cloud-api`.
- `EnvironmentVariables` in `~/Library/LaunchAgents/com.pedbot.cloud-api.plist`: only `PATH` + `SECRET_KEY` (NOT `TOCAFICHADR_AUTH_REQUIRED` or `EXTENSION_API_KEY` — gate is off).
- `/api/health` 200; `/api/transcribe` 400 (no audio) = optional_auth fallback intact.
- `pgrep -lf run_cloud_api` returned nothing during inspection but tunnel was 200 — service runs under launchd-spawned bash.

### `#tiporec` ambiguity recap
- Logs show `#tiporec_0` clicked → then `padraorec_*` (template selection).
- CLAUDE.md says `#tiporec_0` = "Simples" in one place and `#tiporec_1` = "Simples" in another (contradictory).
- Modifiable Simples flow code uses `#tiporec_1`; if that's wrong, the simples-prescription flow is silently misfiring. Browser verification only.

### Live-shift checklist (when v3.0 is ready)
1. **Voice → SOAP**: 15-30 s dictation. SOAP fills correctly. Whisper timing in Flask log stays in 3-10 s.
2. **CID autofill**: most fragile selector path — confirm it persists on save.
3. **Prescription template flow**: click template → edit body → Finalizar Receita.
4. **Atestado flow**: open → optional companion text → Finalizar Atestado → IMPRIMIR SEM CID. (NEW in 2.5.10.)
5. **Alta e voltar**: doctor confirms discharge → return to list. SOAP/prescription/print are separate steps.
6. **Audit log**: after shift, check backend logs for uncaught errors.

---

## Index — where things live (current)

| Thing | Path |
|------|------|
| Extension source | `/Users/admin/Dev/tocafichadr-extension/` (this repo) |
| Flask backend | `backend/` in this repo locally; `/Users/christianoliveira/Dev/tocafichadr-extension/backend/` on Mac Mini |
| Mac Mini SSH | `ssh christianoliveira@100.97.14.32` (or `mac-mini-de-chris.tail606c16.ts.net`) |
| Cloudflare Tunnel URL (live) | `https://option-sperm-resolutions-marina.trycloudflare.com` (rotates on cloudflared restart) |
| Discovery gist | `https://gist.githubusercontent.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6/raw/tocafichadr-api-url.json` |
| Flask launchd plist | `~/Library/LaunchAgents/com.pedbot.cloud-api.plist` (LaunchAgent, NOT system daemon) |
| Flask logs | `backend/logs/cloud-api.log` and `cloud-api-error.log` |
| Interaction logs (gold mine) | legacy logs until desktop automation logging is moved |
| Roadmap | `docs/ROADMAP-v2.6-to-v2.9.md` |
| Strategy memo | `docs/STRATEGY-saas.md` |
| Web Store prep | `docs/WEB-STORE-PREP.md` |
| Manual test checklist | `docs/MANUAL-TESTS.md` |
| Phase 001 record | `.planning/phases/001-security-review-remediation/` |

---

*This is the operational follow-up list. Strategic decisions go in `STRATEGY-saas.md`. Milestone task tables go in `ROADMAP-v2.6-to-v2.9.md`.*
