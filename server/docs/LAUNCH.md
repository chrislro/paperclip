# Toca Ficha Dr. — Launch Plan

> **Updated:** 2026-05-08
> **Status:** Landing live at `tocafichadr.com.br`. Extension v3.4.0 in `main`, not yet on Chrome Web Store. Backend on Mac Mini + Cloudflare Tunnel. Unified repo (`backend/` in this repo) deployed on Mac Mini.

This is the canonical "what do I do next" document. Update on every session that ships. Related docs are pointed to from each section — they go deeper, this one stays high-level.

---

## ✅ What's live right now

| Surface | URL / Location | Notes |
|---|---|---|
| Landing page | https://tocafichadr.com.br | Deployed via Vercel, auto-sync from GitHub |
| Privacy policy | https://tocafichadr.com.br/privacidade | Includes CFM 2.454/2026 compliance + Clerk sub-processor disclosure |
| Extension | Local unpacked only, v3.4.0 | Not on Chrome Web Store yet |
| Flask backend | Mac Mini `100.97.14.32:5050` via Tailscale + Cloudflare Tunnel | Source lives in `backend/` of this repo; tunnel is live |
| Backend stable URL | `https://api.tocafichadr.com.br` | DNS target set; not yet resolving |

---

## 🎯 Pick up here

### Immediate — less than a working day of effort total

- [x] **Fix Vercel Root Directory** — set to `landing/`, auto-deploys from GitHub.
- [x] **Register `tocafichadr.com.br`** — registered at HostGator, R$77/2yrs.
- [x] **Point DNS at Vercel** — apex A → 76.76.21.21, www CNAME → cname.vercel-dns.com. SSL auto-provisioned.
- [ ] **Named Cloudflare Tunnel** — set up `api.tocafichadr.com.br` as a named tunnel to the Mac Mini. See `docs/DEPLOY-MVP.md` Part 1 for the flow.
- [ ] **Update production API URL** — switch from rotating `*.trycloudflare.com` to `https://api.tocafichadr.com.br`. Remove ephemeral URL from `manifest.json` `host_permissions` in production builds.

### Pre–Chrome Web Store polish

- [ ] **Live-shift test of v3.4.0** — validate 32kbps audio quality on a real plantão. If Whisper accuracy drops, bump to 48kbps in `content/audio-capture.js`. Measure via `backend/logs/cloud-api-error.log`.
- [ ] **Test CID autofill on live shift** — still `⚠️ Untested`. Most fragile selector path (`fillCid()` in `content/dom-engine.js`).
- [ ] **Test prescription templates (Simples flow)** on live shift — still `⚠️ Untested`.
- [ ] **Test "Alta e voltar" discharge flow** — current behavior is discharge + return only. Confirm confirmation prompt and return-to-list work.
- [ ] **Record a 45-second demo video** — one patient end-to-end. Host unlisted on YouTube; embed in modal on "Ver demo · 45s" CTA. *Alternative:* replace the JS self-playing HUD with a muted autoplay `<video>` of the same animation — cheaper to maintain and immune to JS state-machine drift.
- [ ] **Legal re-read of `landing/privacidade.html`** — Brazilian data-privacy lawyer must verify the "nothing is stored" claim against the actual Flask `/transcribe` implementation. Required before beta invites. Check for alignment with LGPD Art. 19 and CFM Resolução 2.454/2026.

### Chrome Web Store submission (see `docs/WEB-STORE-PREP.md` + `docs/DEPLOY-MVP.md` Part 3)

- [ ] **Take 5 screenshots** at 1280×800 — side panel, voice recording, SOAP result, CID suggestion, Alta e voltar flow
- [ ] **Write listing copy** in Portuguese (description, features, changelog)
- [ ] **Verify privacy policy URL** is reachable at `https://tocafichadr.com.br/privacidade.html`
- [ ] **Finalize `host_permissions`** — decide: wildcard `*.g-hosp.com.br/*` (broader; catches all hospitals) vs per-hospital request (tighter but worse UX). Recommend wildcard for v1.
- [ ] **Run `./scripts/build-package.sh`** → produces `tocafichadr-v2.4.1.zip`
- [ ] **Submit for review** — 1–3 business days typical turnaround
- [ ] **On approval:** tighten `CORS_ORIGINS` env var on Mac Mini Flask to the specific `chrome-extension://<approved-id>`

### After Web Store approval — wire the `#` placeholders

These are currently `#` in `landing/index.html` because the external URLs don't exist yet:

- [ ] `landing/index.html:299,307,572` — "Instalar grátis" / "Instalar no Chrome" → Chrome Web Store listing URL
- [ ] `landing/index.html:298` — "Entrar" → `/entrar` or account page (auth flow decision needed)
- [ ] `landing/index.html:308` — "Ver demo · 45s" → YouTube/Loom URL from the demo video task above
- [ ] `landing/index.html:541,553` — pricing CTAs → signup flow URL
- [ ] `landing/index.html:472` — review-mockup "Descartar" / "Aprovar e salvar" are decorative (inside simulated UI); leave as `#`

### Post-launch polish

- [ ] **Error telemetry** — route content-script errors to Flask. Critical gap before paid customers. See `CLAUDE.md` Known Fragility section for current logging holes.
- [ ] **Sentry integration** (extension + Flask) before doctor beta invites
- [ ] **Expand CID-10 library** — 71 today, target 150+ pediatric codes
- [ ] **Multi-hospital expansion** — prescription template IDs (1080–1089) are G-Hosp-specific; surface a per-hospital config in popup. See `PRD.md` Milestone 4.
- [ ] **Server-side usage enforcement** — `content/hud.js:1087` TODO, Free-tier 5/day limit is client-only today
- [ ] **Test Baú Médico** on live shift — still `⚠️ Untested`

---

## Reference docs

- `CLAUDE.md` — architecture, message flow, confirmed G-Hosp selectors, session work logs
- `docs/MVP-STATUS.md` — full MVP status dashboard with 20 tiered improvements
- `docs/DEPLOY-MVP.md` — Cloudflare Tunnel + 50-item technical checklist
- `docs/WEB-STORE-PREP.md` — Chrome Web Store listing details
- `docs/MANUAL-TESTS.md` — shift-time test script
- `TODO.md` — session-by-session checklist (append-only log)
- `PRD.md` — product requirements + 4-milestone launch plan
- `.planning/sketches/001-landing-redesign/` — landing design provenance (8-variant archive + winner + rationale README)
- `NEXT_STEPS.md` — **gitignored** per-developer scratchpad; ignore for shared planning
