# Roadmap v2.6.0 → v2.9.0

> **Status**: 2026-05-01 · Living document · Supersedes the unsorted TODO/NEXT_STEPS items at the repo root.
> **Current shipped**: v2.6.3 (productivity + security bundle).
> - Extension: `chrislro/tocafichadr-extension` @ `f05561a` (v2.6.3)
> - Backend (companion): `chrislro/automationsUPA` (Pediatrics) @ `e7805bb`, deployed on Mac Mini in safe-default mode (auth gate off).
>
> **⚠️ Strategic pivot inserted 2026-05-01**: Web Store submission (task 2.6.9)
> is being held until the **v3.0 Clerk migration** (see `docs/STRATEGY-saas.md`)
> ships. Reasoning: this product is being sold via the Chrome Web Store, not
> just used solo — submitting on custom auth would mean re-submitting after
> the Clerk migration. The v2.7/v2.8/v2.9 EMR-automation work is orthogonal
> to auth and remains valid as planned.

This plan sequences every open backlog item — from the GSTACK security review, the cross-app audio pipeline review, the 2026-05-01 interaction-log analysis, and operational follow-ups — into four releases. Each release ends with a live-shift validation gate. **No milestone advances without evidence.**

---

## Executive summary

| Release | Theme | Headline outcome | ETA | Blocks |
|---------|-------|------------------|-----|--------|
| **v2.6.0** | Production-ready | Bearer-authed Flask + defensive timeouts + safe SOAP write → ready for **Chrome Web Store submission** | ~2 sessions | Web Store launch |
| **v2.7.0** | Productivity | Eliminate the 5 highest-frequency manual click loops surfaced in interaction logs | ~3 sessions | — |
| **v2.8.0** | Performance | <5s end-to-end transcribe on typical clinic audio | ~2 sessions | Realtime opt-in |
| **v2.9.0** | Operational | Stable production domain, durable secrets, drop-stale-IP, infra cleanup | ~1 session | Long-term ops |

Three principles keep this honest:
1. **Live-shift gate** — no version bump merges without 1 successful real-patient run.
2. **Atomic commits per task** — every task ships its own commit; rollback is one `git revert`.
3. **Log evidence required for productivity work** — if it's not in `Pediatrics/logs/ghosp_interactions_*.jsonl`, it's not P1/P2 (push to backlog).

---

## Phase 0 — Pre-flight (no version bump)

These are pre-existing operational debts that must clear before / alongside v2.6 work. None require a release.

| ID | Item | Owner | Effort | Status |
|----|------|-------|--------|--------|
| 0.1 | Mac Mini Keychain populated with `OPENAI_OAUTH_ACCESS_TOKEN` (`security add-generic-password -s openai-api-key-pediatrics`) — must run on Mac Mini GUI terminal, not SSH | Chris (manual) | 5 min | per memory: keychain landed 04-24, **verify still valid** |
| 0.2 | Update `~/CLAUDE.md` Revenue table: `pedbot-extension` → `Toca Ficha Dr` | Claude | 5 min | known-stale (per memory) |
| 0.3 | Confirm `100.97.14.32` (mac-mini-de-chris) responds; the retired `100.116.133.83` is removed from any active automation | Chris | 5 min | tunnel mode unaffected; Tailscale-direct mode would fail |

---

## Milestone v2.6.0 — Production-ready

**Goal**: ship a Chrome Web Store submission with no known security holes and no known crash-on-network-stall paths.

**Success criteria**:
- All `/api/*` endpoints reject requests without a valid Bearer token (verified by `curl` smoke test).
- Whisper transcribe gives up cleanly at 30 s instead of stalling the HUD until the 90 s timeout.
- A compromised Flask cannot inject `<script>` into G-Hosp via `result.soap`.
- Doctor sees in-progress feedback during the 29.6 s `cria_receita_alta` saves observed in logs.
- `track.mute` revoke (mic permission revoke via `chrome://settings`) surfaces a clean error instead of silent failure.
- 1 live-shift dry run completes end-to-end with no console errors and no Flask 5xx.
- `tocafichadr-v2.6.0.zip` uploaded to the Chrome Web Store dashboard with screenshots + listing copy approved.

### Tasks

| Task ID | Item | File(s) | Status | Effort | Depends on | Evidence / source | Risk |
|---------|------|---------|--------|--------|------------|-------------------|------|
| **2.6.1** | **Bearer auth on Flask `/api/*`** — extension already sends header (since 2.3.3 SW proxy), enforce server-side. Reject without 401. Whitelist `/api/health` for SW connection check. | `Pediatrics/emr_automation/auth.py`, `dashboard/routes.py` | ✅ shipped `e7805bb` (Pediatrics) — gated off by default, enable via `TOCAFICHADR_AUTH_REQUIRED=true` env var | 2-3 h | 0.1, **2.6.10** | REVIEW.md P0-1, NEXT_STEPS line 17 | Med — wrong Bearer key bricks all clinical use; deploy outside shift hours, test before shift starts |
| **2.6.2** | **`AbortSignal.timeout(30000)` in SW `_handleTranscribe`** — current 90 s HUD timeout caught a real 89.6 s OpenAI stall (UAT phase 001 test 2). Convert upstream stalls to a clean retry path. | `background/service-worker.js:331` | ✅ already shipped pre-roadmap (verified `e3f22d3`) | 1 h | — | NEXT_STEPS #22, UAT-001 test 2 | Low — additive; failure mode is clearer error message |
| **2.6.3** | **`max_retries=0, timeout=30` on Flask OpenAI client** | `Pediatrics/emr_automation/openai_auth.py:139` | ✅ shipped `e7805bb` (Pediatrics) | 30 min | — | UAT-001 test 2 | Low |
| **2.6.4** | **Sanitize `result.soap` before rich-HTML write** — strip everything but `<br><b><i><p>` allowlist OR switch to `textContent` + manual `<br>` substitution. Defends against compromised-backend XSS into G-Hosp tab (same-origin with all clinical data). | `content/dom-engine.js:266-321` (`_sanitizeSoapHtml`) | ✅ already shipped pre-roadmap (verified `e3f22d3`) | 1-2 h | — | NEXT_STEPS #23 | Low — output formatting may shift slightly; visual regression check on next live shift |
| **2.6.5** | **Spinner + disabled state during prescription save** — when `runSimplesPrescription` triggers Gravar, inject a non-blocking overlay into `#dialog_formularios` showing "Salvando receita…" + disable form buttons. Remove on dialog close or 30 s timeout. | `content/dom-engine.js` (new `_lockDialog/_unlockDialog`), `styles/hud.css` | ⏳ pending | 2-3 h | — | log analysis: 29.6 s wait + 5 mash-clicks (2026-05-01 L3333-L3339) | Med — manipulates G-Hosp's own DOM; needs `MutationObserver` cleanup on dialog close |
| **2.6.6** | **`track.mute` listener** — `audio-capture.js:88-98` already has `track.ended`; add parallel `track.mute` (Chrome fires `mute` not `ended` on `chrome://settings` revoke per UAT-001 test 3). | `content/audio-capture.js` | ✅ shipped `e3f22d3` | 1 h | — | UAT-001 test 3, NEXT_STEPS #26 | Low |
| **2.6.7** | **Live-shift smoke test** — `docs/MANUAL-TESTS.md` 5-point checklist. Block release on console errors or Flask 5xx. | n/a | ⏳ pending | 1 shift | 2.6.1-2.6.6, 2.6.10 | docs/NEXT-STEPS.md "Live-shift checklist" | Critical — gate |
| **2.6.8** | **Chrome Web Store screenshots** — 5 × 1280×800 PNG, captured against the v2.6.0 HUD layout. Use the live HUD over a sanitized G-Hosp screenshot. | `store/` directory | ⏳ pending | 1-2 h | 2.6.7 | TODO.md "MISSING" | Low |
| **2.6.9** | **Submit to Web Store** — upload `tocafichadr-v2.6.0.zip` (built via `scripts/build-package.sh`), paste `store/description.txt`, host privacy policy at `tocafichadr.com.br/privacidade`, fill data-use disclosure. | n/a | ⏳ pending | 1 h + 1-3 day review | 2.6.8 | TODO.md Chrome Web Store Checklist | Low |
| **2.6.10** | **SW auto-refresh-on-401** — surfaced during 2.6.1 implementation. Today's SW silently fails on 401; popup has a `refreshToken` in storage but the SW never uses it. Required before flipping `TOCAFICHADR_AUTH_REQUIRED=true` on a long shift, or token expiry (24 h) bricks the extension mid-patient. Catch 401 in SW `request()` / `_handleTranscribe`, POST to `/auth/refresh` with the stored refresh token, retry the original request once with the new token. | `background/service-worker.js` | ✅ shipped in **v2.6.1**. New `_authedFetch` + `_refreshAccessToken` (single-flight, refresh-token rotation, clears storage on 401/403 from `/auth/refresh`). Wired into `_handleTranscribe`, `_handleFetch`, `_handleAudit`. 6 Node tests cover the contract. Selftest 8/8. | 2-3 h | — | Discovered in 2.6.1 review; popup login already stores `refreshToken` (`popup/popup.js:350,383`) but SW never reads it | Med — wrong refresh logic creates infinite-401 loops; test with deliberately-expired token |

### Out-of-scope for this milestone
- Productivity work (deferred to v2.7).
- Audio silence trimming (deferred to v2.8 — needs measurement baseline first).
- `#tiporec_0/1` browser verification (deferred to v2.7 — not safety-related).

### Cross-repo deployment notes (added 2026-05-01)

The Flask side of v2.6.0 lives in the **Pediatrics** repo
(`chrislro/automationsUPA`), not in the extension repo. Both must be
synced for the milestone to be effective:

| Layer | Repo | Commit |
|-------|------|--------|
| Extension | `chrislro/tocafichadr-extension` | `e3f22d3` |
| Backend | `chrislro/automationsUPA` (`Pediatrics/`) | `e7805bb` |

**To enable Bearer enforcement on the Mac Mini**:

1. `python3 -c "import secrets; print(secrets.token_hex(32))"` → copy the key.
2. Edit `~/Library/LaunchAgents/com.pedbot.cloud-api.plist` (or
   `/Library/LaunchDaemons/com.tocafichadr.cloud-api.plist` on the Mini),
   add `EnvironmentVariables` keys:
   ```
   TOCAFICHADR_AUTH_REQUIRED   true
   EXTENSION_API_KEY           <key from step 1>
   ```
3. `launchctl bootout system/com.pedbot.cloud-api && launchctl bootstrap system /Library/LaunchDaemons/com.pedbot.cloud-api.plist`.
4. Smoke test: `curl https://<tunnel>/api/transcribe` → expect HTTP 401.
   With `Authorization: Bearer <key>` and a multipart-form `audio` field,
   you should see the normal transcribe behavior (or HTTP 400 "audio file
   too small" if you POST an empty file).
5. Configure the extension to send the same key — either via the popup
   login flow (which produces a per-user JWT) OR by setting
   `chrome.storage.local.authToken` directly to the
   `EXTENSION_API_KEY` value.
6. **Do not enable enforcement until 2.6.10 (auto-refresh-on-401) ships**,
   or a 24 h JWT expiry will brick the extension mid-shift.

---

## Milestone v2.7.0 — Productivity

**Goal**: cut clicks-per-shift by 25-40 % on the highest-frequency manual loops surfaced in `ghosp_interactions_*.jsonl`. Every task must cite specific log evidence.

**Success criteria**:
- The 5 productivity tasks below each have at least 1 patient session in the next live shift where the doctor uses the new automation successfully.
- No regressions in the v2.6.0 success criteria.
- Interaction-log re-analysis after first post-2.7 shift shows reduced manual click count for the targeted flows.

### Tasks

| Task ID | Item | File(s) | Effort | Depends on | Evidence / source |
|---------|------|---------|--------|------------|-------------------|
| **2.7.1** | **Verify `#tiporec_0` vs `#tiporec_1` in browser** — open G-Hosp prescription dialog, inspect both radio elements, document the actual mapping in `CLAUDE.md`. The CLAUDE.md is internally inconsistent on this; logs show user clicks `#tiporec_0` then `padraorec_*` (template selection), suggesting `#tiporec_0` = "Utilizar Padrões". Confirm or refute, then either fix `runSimplesPrescription` or document why current code is correct. | `CLAUDE.md`, possibly `content/dom-engine.js:1104` | 30 min (browser) + 30 min (code) | live shift | log analysis (2026-05-01) — deferred from v2.5.10 |
| **2.7.2** | **Pre-fill `#alta_data_alta` with today's date** when discharge form opens — selector already bundled (v2.5.10). Hook into existing `processDischarge` flow; only set if currently empty. | `content/dom-engine.js` (extend `processDischarge`) | ✅ shipped in **v2.6.2**. Step 2.5 in `processDischarge`: empty-check → DD/MM/YYYY → input/change dispatch. Defensive, non-blocking. | 1 h | — | log analysis: 8/13/18 manual focus events per shift |
| **2.7.3** | **`#recomendas_descricao` selector + auto-fill from SOAP "P" plan field** — log shows free-text recommendations like `"solicito rx cranio e costelas Observacao ate 17h"` typed manually. The SOAP transcription already produces a Plan field; route it here. | `content/dom-engine.js` (BUNDLED + new utility), `content/hud.js` (wire to SOAP-applied event) | 2-3 h | — | log: 04-29 L3143 |
| **2.7.4** | **Favorite drugs panel** — 8-10 hardcoded posology templates derived from log analysis (paracetamol 4/4h, amoxi 8/8h, ibu 6/6h, prednisolona, salbutamol, SF nasal, dipirona, tobramicina ocular). User-editable via popup. Click → autofills `#matmed_nome` + `#modo_usar` (skipping the typed-prefix → autocomplete round-trip). | new `content/favorites.js`, `popup/popup.html`, `popup/popup.js`, `chrome.storage.sync` schema bump | 6-8 h | — | log: 34 `#modo_usar` inputs collapse to 5 templates; 10 `#matmed_nome` prefixes |
| **2.7.5** | **406 retry / circuit-breaker on `link_new_receitaalta`** — detect `chrome-error://chromewebdata/` nav after click, retry 3× with exponential backoff (500ms / 1s / 2s), then surface "G-Hosp não respondeu, tente recarregar" instead of letting the doctor mash buttons. | `content/dom-engine.js` (new `_clickWithRetry`) | ⚠️ **light version shipped in v2.6.3** — `openPrescription` retries the click once with 1.5 s backoff on dialog timeout. Full circuit-breaker (chrome-error nav detection via SW `chrome.webNavigation`) still pending. | 2 h | — | log: Apr 15 L412-L448 (10× 406 + 5× Reload + 4× Adicionar = 27 min lost on patient 1887000) |
| **2.7.6** | **Live-shift validation** — re-record interaction log, diff click counts on targeted flows. | n/a | 1 shift | 2.7.1-2.7.5 | gate |

### Out-of-scope
- Solcab/radiology automation (slipped to v2.8 — needs more log days to confirm flow stability).
- Realtime WebSocket transcription (v2.8).

---

## Milestone v2.8.0 — Performance & advanced flows

**Goal**: <5 s p50 transcribe end-to-end on 30-second clinic audio (current p50 ≈ 6-8 s on 156 KB test audio per timing baseline). Plus the second-tier productivity flows that need more design.

**Success criteria**:
- Whisper latency p50 ≤ 3.5 s after silence trim (currently 5-7 s).
- SOAP+CID parallel ≤ 2 s (already at 1.6 s — protect).
- Solcab automation works on at least 1 imaging patient in next shift.
- Realtime opt-in tested by doctor on 3 consecutive consultations without complaint.

### Tasks

| Task ID | Item | File(s) | Effort | Depends on | Evidence / source |
|---------|------|---------|--------|------------|-------------------|
| **2.8.1** | **Audio silence trimming** — Web Audio `AnalyserNode` detects sub-30 dB segments at start/end of recording, drops them before send. 32 kbps Opus already saves bandwidth; trim saves another 20-40 % and cuts Whisper latency on quiet doctor pauses. Reuse existing `vad-helpers.js` math. | `content/audio-capture.js` (extend), reuse `content/vad-helpers.js` | 4-6 h | — | NEXT_STEPS #24, "Cross-app silence trimming plan" appendix |
| **2.8.2** | **Solcab/radiology orders automation** — multi-row autocomplete loop. Selectors: `#solcab_solexames_attributes_*_descricao` (dynamic IDs like `_1776263829319_descricao`). New HUD button "Solicitar Exames" with comma-separated body input ("punho, mao, antebraço") that runs the loop. | `content/dom-engine.js` (regex selector + new `runSolcabOrders`), `content/hud.js` (new button), `popup/popup.js` (favorites for common imaging) | 6-8 h | 2.7.6 | log: Apr 15 L4530, L4551, L4570 (3 sequential autocompletes for one patient) |
| **2.8.3** | **Realtime WebSocket transcription** behind a settings toggle — code already built in `offscreen/offscreen.js` but only reachable from popup. Wire to HUD with per-user opt-in. Cap daily-minutes (cost is ~10× higher per minute). | `content/hud.js`, `offscreen/offscreen.js`, `popup/popup.js` (new toggle + minute cap) | 8-10 h | 2.6.7 | NEXT_STEPS #25 |
| **2.8.4** | **`#cid_descricao` autocomplete engagement** — current `fillCid` sets `.value` but doesn't engage the autocomplete on the description field, so the diagnosis may not lock in on save. Switch to jQuery UI `autocomplete("search", name)` + `select` event simulation. | `content/dom-engine.js:444` (`fillCid`) | 3-4 h | — | TODO.md "fillCid() untested and fragile"; log: doctor types `'otite'`→`'otite m'`→`'otite media aguda'` to engage the same autocomplete |
| **2.8.5** | **Live-shift validation** | n/a | 1 shift | 2.8.1-2.8.4 | gate |

### Out-of-scope
- Operational hygiene (v2.9).

---

## Milestone v2.9.0 — Operational hygiene

**Goal**: drop accumulated cruft from the rapid 2.x cycle. No new features.

**Success criteria**:
- `manifest.json` has no stale Tailscale IPs.
- Production traffic uses `api.tocafichadr.com.br` (DNS landing); `*.trycloudflare.com` becomes legacy fallback.
- `host_permissions` minimized to actual production endpoints.
- All P3 items from REVIEW.md closed or explicitly punted with rationale.

### Tasks

| Task ID | Item | File(s) | Effort |
|---------|------|---------|--------|
| **2.9.1** | Replace `http://100.116.133.83:5050/*` (retired `mac-mini-de-christian`) with `100.97.14.32:5050` — OR drop Tailscale-direct mode entirely and ship tunnel-only. | `manifest.json` host_permissions | ✅ confirmed already done — current manifest only has `100.97.14.32`. | 30 min |
| **2.9.2** | Stand up `api.tocafichadr.com.br` DNS → Cloudflare Tunnel (replaces `*.trycloudflare.com` URL); update extension to prefer stable domain, fall back to gist-discovered tunnel. | `popup/popup.js`, `background/service-worker.js`, infra | 4-6 h |
| **2.9.3** | Remove `https://gist.githubusercontent.com/chrislro/*` from `host_permissions` once stable domain is live. | `manifest.json` | 5 min |
| **2.9.4** | Centralize hostname allowlist regex into `content/config.js` (currently duplicated in popup, content scripts, and SW per NEXT_STEPS audio-pipeline review). | new `content/config.js`, refactor 3 sites | 2 h |
| **2.9.5** | Capture actual `MediaRecorder.audioBitsPerSecond` (Chrome may downshift on weak hardware) into audit telemetry. | `content/audio-capture.js`, `content/api-client.js` (logAudit payload) | ✅ shipped in v2.6.3 — `getEffectiveAudioConfig()` + `transcribe_success` audit log. | 1 h |
| **2.9.6** | Live-shift validation | n/a | 1 shift |

---

## Sequencing principles

1. **v2.6 strictly precedes v2.7+.** Without Bearer auth, the Cloudflare Tunnel URL is the credential — no productivity work justifies that exposure window.
2. **Tasks within a milestone can ship out of order**, each as its own commit, as long as the milestone gate (live-shift validation) is unbroken.
3. **Productivity work waits for log evidence.** If the next shift's interaction-log doesn't reproduce a problem, push to backlog. We don't speculate.
4. **`#tiporec_0/1` is browser-verified before any Simples-flow change.** Logs alone are ambiguous; this is the one task where reading the live DOM beats reading more JSONL.

## Risk management

| Risk | Mitigation |
|------|------------|
| Bearer auth deployed mid-shift bricks live patients | Deploy 2.6.1 outside clinical hours; smoke-test `/api/health` + `/api/transcribe` before shift starts; keep previous Flask binary available for `launchctl kickstart`-and-rollback |
| `result.soap` sanitization breaks legitimate formatting | Allowlist test with current SOAP samples from `Pediatrics/logs/`; visual regression on first live patient before mass rollout |
| Spinner overlay confuses or blocks G-Hosp's own UI | Use `position: absolute` inside `#dialog_formularios`, `pointer-events: none` on overlay, dispose via `MutationObserver` on dialog removal; test with `chrome://devtools` open |
| Favorites panel storage schema breaks v2.5 users | Schema bump with migration in `chrome.storage.onInstalled`; keep `prescriptionTemplates` key untouched |
| Realtime mode burns OpenAI quota silently | Hard daily-minute cap in popup settings; HUD shows minutes-used badge; default OFF |

## Rollback strategy

- Every commit is atomic and version-tagged in `manifest.json`. Rolling back means `git revert <hash>` + rebuild zip + reload extension.
- Flask server has `.bak` files for every change touched in this plan (per existing convention). Rollback via `cp X.py.bak-DATE X.py && launchctl kickstart -k gui/$(id -u)/com.pedbot.cloud-api`.
- Web Store rollback: keep prior `.zip` archives in repo root (gitignored, kept on disk) — re-upload to revert.

## Test infrastructure assumed

- `scripts/selftest.sh` (7/7 passing as of v2.5.11) — must stay green.
- `Pediatrics/emr_automation/interaction_logger.py` runs every shift — provides the data feedback loop.
- Mac Mini Flask launchd `com.pedbot.cloud-api` — primary deployment target.
- Cloudflare Tunnel `br.com.tocafichadr.tunnel` — primary inbound path.

## Open questions for next discuss-phase

1. Should the favorites panel (2.7.4) replace the existing `prescriptionTemplates` system or live alongside it? Current templates are 6 user-editable slots; favorites would be ~10 hardcoded common drugs. **Recommendation**: alongside, in a new section, since templates are already proven.
2. For 2.6.5 (prescription-save spinner): inject into G-Hosp's `#dialog_formularios`, or render a HUD-side overlay? **Lean**: HUD-side, less risk of fighting G-Hosp's own DOM.
3. For 2.7.4 favorites schema: per-clinic or per-doctor? **Lean**: per-doctor (`chrome.storage.sync`), since the user is currently solo.
4. For 2.9.2 stable domain: is DNS for `api.tocafichadr.com.br` already provisioned? If not, this becomes a 2-part task (DNS + Cloudflare Tunnel reconfig).

## Session-by-session execution order (suggested)

```
Session 1 (v2.6 security): 2.6.1 + 2.6.3 + 2.6.2 + 2.6.4 + 2.6.6 → live-shift smoke
Session 2 (v2.6 finish):   2.6.5 + 2.6.8 + 2.6.9 → Web Store submit
                           ⟶ 1-3 days review
Session 3 (v2.7 quick):    2.7.1 + 2.7.2 + 2.7.3 + 2.7.5 → live-shift A
Session 4 (v2.7 favs):     2.7.4 → live-shift B → 2.7.6 gate
Session 5 (v2.8 perf):     2.8.1 + 2.8.4 → live-shift
Session 6 (v2.8 reach):    2.8.2 + 2.8.3 → live-shift
Session 7 (v2.9 ops):      all of 2.9 + final live-shift
```

---

*This document is the source of truth for v2.6-v2.9 work. Update task statuses inline as they ship; archive to `docs/archive/` when v2.9 closes.*

---

## v3.0 Clerk migration — see `docs/STRATEGY-saas.md`

The strategic memo at `docs/STRATEGY-saas.md` documents why Web Store
submission is being held until v3.0 ships. Summary:

- Custom JWT today is fine for solo use, not fine for a SaaS product
  that needs email verification, password reset, MFA, and an LGPD-ready
  audit trail.
- Clerk has an official Chrome extension SDK (`@clerk/chrome-extension`)
  with built-in MV3 service-worker support — solves at a higher level
  the same problem v2.6.10 solved with custom code.
- 50K free MAU; user already has Clerk in conduta-rapida.
- ~9-13 h to migrate vs ~40-80 h to build MFA + verification + reset
  to LGPD standard from scratch.
- Brazil + EU mutual adequacy decision (Jan 26 2026) means Clerk's
  EU/US hosting is now legally streamlined for Brazilian doctors.

Effort breakdown, sequencing, and decision matrix are all in the memo.
