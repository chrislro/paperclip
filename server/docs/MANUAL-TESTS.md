# Toca Ficha Dr. — Manual Test Checklist (v2.2.0)

> Run on: **live G-Hosp session at UPA Bento Gonçalves**
> Extension version: 3.4.0 (reload in `chrome://extensions` first)
> Backend: see "Backend Choice" section below before testing

Everything below **must be done manually** — requires Chrome with the extension loaded, a live G-Hosp login, a microphone, and a real consultation in progress. Items already verified autonomously (backend health, CORS, JS syntax, manifest sanity, Tailscale IP removed) are in `DEPLOY-MVP.md` and not repeated here.

---

## Backend Choice — Local vs Cloud (decide first)

Both backends are live and healthy as of 2026-04-15 11:03 BRT:
- **Local (MacBook)** — `http://127.0.0.1:5050` → responding, Flask PID 23493
- **Cloud (Mac Mini via Tailscale)** — `http://100.97.14.32:5050` → responding

### Recommendation for MVP testing: **Keep using Cloud (Mac Mini)**

| Reason | Explanation |
|--------|-------------|
| **Same setup as before** | No config change needed — extension's `backendMode=cloud` is already your working state |
| **Matches production shape** | Cloud goes through the network, same latency/error profile as real doctors will see |
| **Frees your MacBook** | Audio transcription + OpenAI calls don't compete with Claude/dev tools for CPU |
| **Mac Mini has Postgres** | Your auth/billing Postgres already lives there; local mode would need a second DB to match |
| **Survives laptop sleep** | Finalize flow won't break if you close the MacBook lid between patients |

### When to switch to Local

Only switch to `backendMode=local` if:
- You're debugging a Flask code change and want live-reload without pushing to Mac Mini
- Mac Mini is offline (building, power-cut, or you're away from Tailscale)
- You're measuring raw Whisper latency without Tailscale hop (dev benchmarking only)

### How to verify your current setting

1. Click the Toca Ficha Dr. popup in Chrome toolbar
2. Check the **Backend** radio — should say "Cloud" selected, URL field shows `http://100.97.14.32:5050`
3. Click **Testar** → expect green ✓ "Conectado"

### What changes when Cloudflare Tunnel goes live

When `api.tocafichadr.com.br` resolves, switch the production API URL to the stable domain. Until then, Tailscale or Cloudflare tunnel is the production path.

---

## Pre-test setup

- [ ] Reloaded extension in `chrome://extensions` (version should read **3.4.0**)
- [ ] Chrome DevTools open on G-Hosp tab (Console + Network visible)
- [ ] Popup confirms `backendMode = cloud`, Testar = green
- [ ] One real patient ready to attend OR a test patient in the queue
- [ ] Microphone permission granted to the extension
- [ ] Flask log tail open on Mac Mini: `ssh christianoliveira@100.97.14.32 'tail -f ~/Dev/tocafichadr-extension/backend/logs/cloud-api.log'`

---

## A. HUD load & visibility

- [ ] **A1** HUD appears on `prbentogoncalves.g-hosp.com.br` patient page
- [ ] **A2** HUD does NOT appear on non-G-Hosp tabs
- [ ] **A3** Connection indicator in HUD = green
- [ ] **A4** No red errors at `chrome://extensions/?errors=<tocafichadr-id>`
- [ ] **A5** DevTools Console shows no uncaught errors on page load

## B. Audio → SOAP pipeline

- [ ] **B1** 10s recording in clear Portuguese → SOAP fields filled within 30s
- [ ] **B2** No "Failed to fetch" error in DevTools
- [ ] **B3** Flask log shows `transcribe_audio: audio size X.X KB` — audio < 500 KB
- [ ] **B4** Flask log: `whisper took < 8s`
- [ ] **B5** Flask log: `SOAP+CID parallel took < 5s`
- [ ] **B6** SOAP content is medically coherent (not hallucinated)
- [ ] **B7** If audio > 1 MB → bitrate is too high, report so we can lower MediaRecorder bitrate

## C. CID autofill

- [ ] **C1** AI-suggested CID → click → `#intcid_cid_id` gets code, `#cid_descricao` gets name
- [ ] **C2** Save form → reopen → CID persists (proves hidden field got the right ID via jQuery UI)
- [ ] **C3** DevTools Console does NOT show `[Toca Ficha Dr.] fillCid: jQuery not available` — if it does, G-Hosp stripped jQuery (major incident)
- [ ] **C4** Manual CID search (type code directly) also works

## D. Prescription — legacy template (Utilizar Padrões)

- [ ] **D1** Pick Gastro 1 → dialog opens
- [ ] **D2** `#padroes` template list appears (the "Utilizar Padrões" label click worked)
- [ ] **D3** Radio for Gastro 1 gets selected
- [ ] **D4** Inserir fires, editor shows template content
- [ ] **D5** Imprimir button opens G-Hosp print dialog
- [ ] **D6** Same flow works for Resfriado 1/2, Amoxicilina, etc.

## E. Prescription — Simples modifiable flow

- [ ] **E1** In popup, edit a template body (e.g. add "testando 123") → save
- [ ] **E2** HUD button reflects new name/body instantly (no reload)
- [ ] **E3** Click HUD template button → editor opens with title="Receita" + your custom body
- [ ] **E4** DevTools Console shows `[Toca Ficha Dr.] simples prescription ready for review: <name>`
- [ ] **E5** NO warning `simples: Inserir button not found` — if you see it, Simples selectors broke (capture full console group for me)
- [ ] **E6** NO warning `simples: title input #matmed_nome not found` — same as above
- [ ] **E7** Edit body in G-Hosp editor → click "Finalizar Receita" → saves + prints
- [ ] **E8** Test with a body that has special characters (quotes, accents) — no JS errors

## F. Discharge ("Alta do Paciente")

- [ ] **F1** Button clicked → Adicionar link fires → discharge form opens
- [ ] **F2** Referral select auto-set to "Sem encaminhamento" (value 100)
- [ ] **F3** Gravar fires → `#botao_gravar_alta` disappears within 4s
- [ ] **F4** HUD shows green success status
- [ ] **F5** **NEW TEST for v2.2.0 fix:** force a validation error (e.g. blank required field) → HUD shows red "Falha ao processar alta" within 1s, NOT after 4s hang
- [ ] **F6** Console shows `[Toca Ficha Dr.] discharge: error indicator detected, aborting wait:` with the error text

## G. Alta e voltar (discharge + return only)

- [ ] **G1** Click **Alta e voltar** → confirmation appears before discharge submit
- [ ] **G2** Confirm → "Registrando alta..." / "Processando alta..." → action completes in < 30s
- [ ] **G3** Ends on G-Hosp patient list page
- [ ] **G4** `/api/audit` endpoint shows `finalize_patient` entry with correct `internId`
- [ ] **G5** Cancel the confirmation → no discharge submit occurs and the patient remains in the current chart
- [ ] **G6** Force a discharge validation failure → UI shows a red actionable error and does not report success
- [ ] **G7** After success, active template button indicator clears

## H. Baú Médico

- [ ] **H1** Button opens `/ver_fichas?intern_id=<id>&id=5` in new tab
- [ ] **H2** Correct patient's chart loads (intern_id from URL matches)

## I. State hygiene / multi-patient

- [ ] **I1** Process 3 patients in sequence without page refresh → no stale `selectedTemplate` between them
- [ ] **I2** Each new patient triggers `chief_complaint` and weight extraction in HUD
- [ ] **I3** If `autoClearSoap` enabled in popup → new patient → SOAP fields auto-clear
- [ ] **I4** Active template button indicator resets after finalize

## J. Session & recovery

- [ ] **J1** After idle >4h, G-Hosp redirects to login → re-auth → extension still works without reload
- [ ] **J2** Restart Flask on Mac Mini mid-session → extension reconnects on next call (no extension reload needed)
- [ ] **J3** Close/reopen Chrome → extension state persists (chrome.storage.sync intact)

## K. Performance check

- [ ] **K1** HUD render < 50ms on patient switch (no visible flash)
- [ ] **K2** Chrome Task Manager: extension memory < 50 MB after 1h session
- [ ] **K3** One full real patient: stopwatch from audio-start → patient-list. **Target: < 60s**

## L. Real-world shift smoke test

- [ ] **L1** Process first 10 real patients of a shift — track any manual interventions
- [ ] **L2** Error rate < 5% across those 10 (i.e. ≤ 1 patient needed a manual step)
- [ ] **L3** Audit log in Flask shows 10 `finalize_patient` entries from **Alta e voltar**
- [ ] **L4** No patient took > 90s end-to-end

---

## What to report back to Claude

For any FAIL, capture:
1. **Which item failed** (e.g. "E5")
2. **DevTools Console output** — open the `[Toca Ficha Dr.]` group, copy the full text
3. **Network tab** — the last 2–3 requests before failure (status, URL, response body if JSON)
4. **Screenshot** of HUD state at moment of failure
5. **Flask log lines** from `~/Dev/tocafichadr-extension/backend/logs/cloud-api.log` matching the timestamp

Paste that into a new Claude session with the context "Toca Ficha Dr. MVP test failure at item [X]" — I'll debug from there.

---

## Definition of "MVP ready to ship to Chrome Web Store"

All items in Sections A–I pass, plus:
- Section K numbers meet targets
- Section L1 has been completed (10 real patients)
- L2 error rate < 5%

If L2 is between 5–15%, fix the top-2 failure modes before ship. Above 15%, stop and triage — we have a selector or flow regression.
