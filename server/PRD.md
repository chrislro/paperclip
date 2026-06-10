# PRD — Toca Ficha Dr. Chrome Extension

**Status:** MVP built locally | **Stage:** Pre-launch (Chrome Web Store submission pending)
**Last updated:** 2026-05-08

---

## Overview

Toca Ficha Dr. is a Chrome MV3 extension that automates the G-Hosp EMR workflow for Brazilian pediatricians. It reduces documentation from 25–35 DOM actions per patient to 4–6 by combining voice dictation, AI-generated SOAP notes, CID-10 suggestion, prescription templates, and a confirmed "Alta e voltar" action for discharge plus return to the patient list.

**Core insight:** A pediatrician seeing 30 patients per shift wastes ~40 minutes on repetitive EMR clicks. Toca Ficha Dr. eliminates this with voice + one button.

---

## Problem

Brazilian pediatricians using G-Hosp EMR must manually navigate 25–35 steps per patient: clear fields, type SOAP notes, find CID codes, open prescription dialog, select template, print, discharge, and return to queue. This is repetitive, error-prone, and exhausting at high volumes.

---

## Target Users

**Primary:** Brazilian pediatricians working shifts at hospitals using G-Hosp EMR.
- Sees 20–40 patients per shift
- Uses Chrome browser
- Technical comfort: moderate (can install Chrome extension)

**Initial beachhead:** Single hospital (prbentogoncalves.g-hosp.com.br). Expand to other G-Hosp instances after validation.

---

## Current State

| Feature | Status |
|---------|--------|
| Voice recording + Whisper transcription | ✅ Working |
| SOAP generation (GPT-4o-mini, Portuguese) | ✅ Working |
| CID-10 suggestion (164 pediatric codes) | ✅ Working |
| Prescription templates (10 pediatric) | ✅ Working |
| "Alta e voltar" discharge-return action | ✅ Working |
| Auto-clear SOAP fields | ✅ Working |
| Side panel architecture | ✅ Working |
| Free/Pro tier + Stripe + usage tracking | ✅ Working |
| Local Flask backend (localhost:5050) | ✅ Working |
| Cloud backend (Mac Mini + Cloudflare Tunnel) | ✅ Running |
| Stable domain (`api.tocafichadr.com.br`) | ⚠️ DNS target set; not yet resolving |
| DOM selector validation on live G-Hosp | ❌ Untested in production |
| Chrome Web Store screenshots | ❌ Missing |
| Privacy policy at live HTTPS URL | ⚠️ GitHub Pages (needs verification) |
| Host permissions finalized | ⚠️ Decision pending |

---

## Goals

### Milestone 1 — Production Validation (Week 1–2)

**Goal:** Confirm the extension works on the real target hospital's G-Hosp instance.

**This is the highest-risk item — DOM selectors may break on production.**

**Tasks:**
1. Install extension locally on target hospital machine
2. Test each selector manually:
   - CID filling (`fillCid()`) — highest risk; 7 selector strategies
   - Prescription dialog open + template selection
   - Discharge form navigation + field completion
3. Document which selectors work; update `selectors.json` as needed
4. Test `window.print()` flow (browser dialog; user presses Enter)
5. Confirm `wysihtml5` SOAP field injection works on live instance

**Success criteria:** "Alta e voltar" submits discharge successfully on live G-Hosp and returns to the patient list after explicit doctor confirmation.

---

### Milestone 2 — Cloud Backend Deployment (Week 2–3)

**Goal:** Deploy the Flask backend so Pro tier works without local setup.

**Tasks:**
1. Deploy Flask API to Railway (easiest) or Mac Mini via Cloudflare Tunnel
2. Configure `api.tocafichadr.com.br` DNS → Railway/Mac Mini
3. Set env vars: `OPENAI_API_KEY`, `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
4. Test cloud transcription end-to-end
5. Test Pro subscription → checkout → unlimited usage enforcement

**Success criteria:** Cloud mode works; Pro subscription can be purchased and used.

---

### Milestone 3 — Chrome Web Store Submission (Week 3–4)

**Goal:** Extension live on Chrome Web Store.

**Tasks:**
1. Take 5 screenshots (1280×800) showing: side panel, voice recording, SOAP result, CID suggestion, Alta e voltar flow
2. Write Chrome Web Store description (Portuguese + English)
3. Verify privacy policy URL is live at HTTPS
4. Finalize `host_permissions` scope:
   - Option A: `*.g-hosp.com.br/*` (broader; catches all hospitals; simpler)
   - Option B: Per-hospital permission request (more secure; harder UX) — **Recommend Option A**
5. Submit for review (3–5 business days)
6. Set developer account ($5 one-time fee)

**Success criteria:** Extension approved and listed on Chrome Web Store.

---

### Milestone 4 — Multi-Hospital Expansion (Month 2–3)

**Goal:** Expand beyond single hospital; onboard 5 hospitals.

**Challenge:** Prescription template IDs (1080–1089) are hardcoded for one G-Hosp instance. Different hospitals may have different IDs.

**Tasks:**
1. Build "Hospital Setup" wizard in extension popup:
   - Select hospital from list OR enter custom G-Hosp URL
   - Auto-detect template IDs on first run (scan prescription dialog dropdown)
2. Store per-hospital config in `chrome.storage.sync`
3. Use remote selector config API (`/api/selectors/{emr}`) for DOM updates without re-releasing
4. Expand CID-10 library (current: 164 codes; target: 300+ general pediatric codes)
5. Add hospitalization-specific protocols (not just emergency/outpatient)

**Success criteria:** 3 additional hospitals onboarded with zero code changes.

---

## Pricing

| Plan | Price | Limit | Notes |
|------|-------|-------|-------|
| Free | R$0 | 5 patients/day | User provides own OpenAI API key + local Flask |
| Pro | R$49/month | Unlimited | Cloud backend (no API key needed); auto-selector updates; priority support |

**14-day free trial** for all new Pro users.

---

## Metrics

| Metric | Now | Month 1 | Month 3 |
|--------|-----|---------|---------|
| Chrome Web Store installs | 0 | 1 (initial hospital) | 20 |
| Pro subscribers | 0 | 1 | 10 |
| MRR | R$0 | R$49 | R$490 |
| Hospitals onboarded | 0 | 1 | 4 |

---

## Out of Scope

- Firefox / Safari support (Chrome-only MV3; G-Hosp likely only used in Chrome)
- Support for EMRs other than G-Hosp (Phase 2 after 10+ hospitals)
- Mobile (EMR access on mobile is impractical for this workflow)

---

## Technical Debt

1. No test framework — add at minimum unit tests for CID fuzzy search and calculation logic
2. No error telemetry — add `chrome.runtime.sendMessage` error reporting to backend
3. Prescription template IDs hardcoded — high priority for multi-hospital expansion
4. `window.print()` can't bypass browser dialog — document this as known limitation; workaround: configure Chrome kiosk print settings
5. `fillCid()` uses 7 strategies + jQuery UI event simulation — fragile; consider replacing with clipboard paste approach if autocomplete proves unreliable

---

## Risks

| Risk | Mitigation |
|------|-----------|
| G-Hosp DOM update breaks selectors | Remote selector config API allows push fixes without re-releasing extension |
| Chrome Web Store rejection | Follow all policies; ensure privacy policy is live; no undeclared permissions |
| CFM 2.454/2026 (August 2026) | Add physician confirmation step before note is saved (click to approve AI output) |
| ANVISA: extension interpreted as medical device | Position as "documentation automation tool"; never auto-suggest diagnosis |
| Single-hospital concentration | Validate on live instance first; expand to 3+ hospitals before investing in multi-hospital infra |
