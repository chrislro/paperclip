# Logger-Driven Insights — 2026-05-25

Suggestions surfaced by running the new `backend/scripts/` analyzers (PR #45) against ~191,000 real interaction events from `~/Dev/Pediatrics/logs/`. Not implemented — captured here as data-backed ideas to revisit when prioritizing the next round of UX work.

## Idea 1 — Heavy prior on CID **J00** for the suggestion model

### Data
`cid_accuracy.py --logs-dir ~/Dev/Pediatrics/logs` on 48 patient sessions with confirmed CID selections:

| Rank | CID | Count | % |
|------|-----|-------|----|
| 1 | **J00** (Nasofaringite aguda / common cold) | **44** | **92%** |
| 2 | J06.9 (URTI unspecified) | 2 | 4% |
| 3 | J02.9 (Acute pharyngitis unspecified) | 1 | 2% |
| 4 | H10.9 (Conjunctivitis unspecified) | 1 | 2% |

All 4 distinct CIDs across 48 sessions are **upper-respiratory or conjunctivitis** — pediatric UPA in Bento Gonçalves is overwhelmingly cold/flu triage.

### Current behavior
`/api/suggest-cid` prompts Groq llama-3.3 (or GPT-4o-mini fallback) to pick from 164 pediatric CID codes with no prior knowledge that 92% of selections land on one code. The model decides per-call from chief complaint + SOAP text.

### Suggested change
Bias the prompt toward J00 when the transcript shows **no** explicit non-respiratory/non-conjunctivitis keyword (e.g. add a prompt rule: "If the symptoms are consistent with a viral upper-respiratory illness OR no clear alternative system is implicated, prefer J00"). The model still picks freely when the transcript explicitly says gastro/dermato/trauma/etc.

### Tradeoffs
- **Pro**: cheaper inference (the bias can short-circuit some calls), faster doctor confirmation (suggested code is right 92% of the time by definition), and the model stops occasionally picking weird-but-technically-valid CIDs for ambiguous transcripts.
- **Con**: ~8% of consultations are NOT J00. If the bias is too strong the doctor has to override more often than the model surfaces a wrong suggestion today. The doctor must remain the source of truth.
- **Mitigation**: A/B the prior strength (no bias / soft bias / hard bias) via the existing audit log — `cid_suggested` + `cid_input` events let us measure suggested-vs-accepted divergence per variant without UI changes.

### Where to make the change
- Prompt: `backend/emr_automation/extension_api.py` → `_build_cid_prompt()` (or similar)
- Audit: already in place via `audit.log_action(action_type="cid_suggested", ...)` from PR #45 Task 4

---

## Idea 2 — Auto-click **#gerar** (ATENDER) for pediatric patients

### Data
`detect_gaps.py --logs-dir ~/Dev/Pediatrics/logs` top manual workflow gaps (clicks not covered by extension automation):

| Occurrences | CSS Selector | What it is |
|---|---|---|
| **263** | **`#gerar`** | **ATENDER** (start consultation) |
| 284 | `a.btn-i-editar` | Edit (generic) |
| 277 | `a.botao.btn-2nd` | IMPRIMIR RECEITA |
| 263 | (same `#gerar` row) | (paired) |
| 140 | `a.botao.btn-2nd.mini-btn` | IMPRIMIR SEM CID |
| 133 | `#link_new_presatestados` | Adicionar atestado |
| 33 | `#link_new_receita` | Adicionar receita |

**`#gerar` is the single highest-frequency unautomated event** — biggest absolute click-count saving per shift of any automation candidate not yet shipped.

### Current behavior
The doctor scans the waiting-room list, identifies the next patient (pediatric or otherwise), clicks the patient row's **ATENDER** button. G-Hosp opens the consultation page. Then the extension's existing automation takes over (SOAP, CID, prescription, discharge).

### Suggested change
Auto-click `#gerar` when **both** hold:
1. The doctor has explicitly chosen a patient in the extension (e.g. via Check EMR's pediatric Telegram alert, or by clicking a "next pediatric patient" affordance in the side panel)
2. The row's text content includes pediatric markers ("(0a", "(1a", ... "(11a", or "Criança", per the `check_emr.py` extraction logic)

If only one is true, surface a confirm button instead of auto-clicking.

### Tradeoffs
- **Pro**: 263 clicks/window across the logged sessions — single biggest gap. Workflow becomes "alert → confirm → consult" instead of "alert → switch tab → find patient → click ATENDER → consult".
- **Con**: auto-clicking patient-row actions is high-stakes. Wrong patient = wrong chart. The two-condition gate is a partial defense but not foolproof. G-Hosp shows multiple patients per row sometimes (multiple visits same day) — selection drift risk.
- **Mitigation**: ship as opt-in (popup toggle, default OFF) for the first 1-2 shifts; require an explicit click on a confirm affordance for the first month before consider auto-firing.

### Where to make the change
- Trigger: a new sidepanel button "Atender próximo pediátrico" OR an existing Check EMR Telegram-alert deep link
- Logic: `content/dom-engine.js` — new `clickAtenderForRow(internId)` helper using `#gerar` as primary selector + row pediatric-content verification
- Audit: log `auto_atender_clicked` with `{intern_id, source: "telegram_deeplink" | "manual_button"}` so the post-deploy validation can confirm we're not auto-clicking the wrong patient

---

## Other observations from the same analyzer runs (informational)

- **prescription_save p95 = 1814ms** — confirmed and addressed via PR #48 (sleep 1500 → 2500ms)
- **cid_autocomplete tail latency**: p99=3809ms is 3× p95 — worth investigating G-Hosp's autocomplete endpoint, may be a backend slow query under load
- **analyze_selectors.py picks broad selectors** for 3 keys (`a`, `input`, `input`) when frequency overwhelms specificity — open bug in the scoring algorithm; needs a min-specificity floor

## Provenance

Generated from real production interaction logs:
- 98 JSONL files in `~/Dev/Pediatrics/logs/`
- 191,628 total events
- 537 patient sessions identified
- Source scripts: `backend/scripts/{analyze_selectors,calibrate_timings,detect_gaps,cid_accuracy}.py` (PR #45)
