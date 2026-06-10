# Toca Ficha Dr. Extension — Launch TODO

Generated: 2026-03-28

## Done (Session 2026-04-22 — Landing redesign)
- [x] Replaced dark-emerald landing with "G" variant (white/teal, Inter, before/after hero, "E se a IA errar?" section, real-shift timeline, sticky CTA, self-playing HUD) — commit b302140
- [x] Restyled privacidade.html to match; added Conformidade CFM 2.454/2026 section
- [x] Stripped vendor model names (Whisper, GPT-4o-mini) from both pages; preserved OpenAI where LGPD-required
- [x] Archived 8-variant exploration at `.planning/sketches/001-landing-redesign/` with `winner-g.html` + rationale README

## Done (Session 2026-03-29 — Audit & Verification)
- [x] Verified workflow.js.bak was deleted (not found in repo)
- [x] Verified medical disclaimer exists in landing/index.html, README.md, and store/description.txt
- [x] Audited TODO accuracy — all completed items confirmed

## Done (Session 2026-03-28)
- [x] Deleted workflow.js.bak (dead code)
- [x] Fixed updateAuthBadge() selector bug (getElementById to querySelector)
- [x] Added confirmation dialog to "Finalizar Paciente"
- [x] Added confirmation dialog to "Alta do Paciente"
- [x] Added 13 critical pediatric CID-10 codes (now 71 total)
- [x] Update README.md — references updated to dom-engine.js, Flask backend architecture
- [x] Update CLAUDE.md — message flow, architecture, and references updated
- [x] Wire up autoCid toggle (reads autoCid from chrome.storage.sync before showing CID suggestions)
- [x] Sync BUNDLED_SELECTORS with selectors.json (discharge_referral_select, discharge_submit_button, discharge_form synced)
- [x] No timeout on transcription fetch — 90s timeout added in hud.js onRecordingStop
- [x] Medical disclaimer in landing page (footer disclaimer added)

## Blockers (Before Chrome Web Store)
- [ ] Validate DOM selectors on live G-Hosp (CID filling, prescription dialog, discharge form)
- [ ] fillCid() untested and fragile — 7 selector strategies, never confirmed to persist on save
- [ ] Host privacy policy at a live URL (tocafichadr.com.br/privacidade or GitHub Pages)
- [ ] host_permissions locked to single hospital (prbentogoncalves.g-hosp.com.br) — decide: wildcard *.g-hosp.com.br or per-hospital
- [ ] Cloud backend (api.tocafichadr.com.br) not deployed
- [ ] Create Chrome Web Store screenshots (1280x800)

## High Priority
- [ ] Prescription template IDs hardcoded (1080-1083) — not configurable per hospital
- [ ] No error recovery if finalize fails mid-workflow (partial completion risk)

## Medium Priority
- [ ] SOAP only fills field 0 of 6 G-Hosp fields — test if fields 1-5 can be empty
- [ ] No rate limiting awareness (free tier 5 SOAP/day — no UI indicator)
- [ ] Add more CID-10 codes (currently 71, target 150+)

## Landing launch (new landing already in main, not yet deployed)
- [ ] `cd landing && vercel --prod` — deploy G to tocafichadr.com.br
- [ ] Validate OG preview (https://cards-dev.twitter.com/validator) + canonical URL
- [ ] Record 45s demo video (or convert self-playing HUD to muted autoplay MP4) → wire to "Ver demo" button at `landing/index.html:308`
- [ ] Legal re-read of `privacidade.html` by Brazilian data-privacy lawyer before beta invites
- [ ] Chrome Web Store URL → replace `#` on install buttons at `landing/index.html:299,307,572`
- [ ] Signup flow URL → replace `#` on pricing CTAs at `landing/index.html:541,553`
- [ ] `/entrar` or auth page → replace `#` on nav "Entrar" at `landing/index.html:298` (button kept intentionally for future auth)
- [ ] Visual consistency: check extension popup/Chrome Web Store tile match landing's `#0891B2` teal brand

## Chrome Web Store Checklist
- [x] Manifest V3
- [x] Icons (16, 48, 128 PNG)
- [x] Store description (store/description.txt)
- [x] No remote code / obfuscation
- [ ] Privacy policy URL — NEEDS HOSTING
- [ ] Screenshots (1280x800) — MISSING
- [ ] Data use disclosure — NEEDS SETUP
- [ ] host_permissions scope — DECISION NEEDED
- [ ] Promotional tile (440x280) — OPTIONAL

## Legal
- [ ] LGPD: hospital DPA (Data Processing Agreement) for EMR data access
- [ ] CFM 2.454/2026: physician must review AI-generated SOAP notes
- [ ] ANVISA: keep as automation tool (data entry), avoid clinical interpretation features
