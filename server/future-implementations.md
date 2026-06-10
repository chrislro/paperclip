# Future Implementations — Anthropic Claude Cookbook Patterns

> Evaluated against the Toca Ficha Dr. Chrome Extension codebase on 2026-04-14.
> Cookbook source: `~/Dev/claude-cookbooks/`

Toca Ficha Dr. is a Chrome MV3 extension that automates pediatric EMR workflows in G-Hosp. The AI pipeline currently runs on a Flask backend (Whisper for transcription, GPT-4o-mini for SOAP generation and CID suggestion). All AI calls flow through `content/api-client.js` -> `background/service-worker.js` -> Flask `/api/transcribe`.

This document evaluates which Anthropic Claude Cookbook patterns are applicable if/when the backend migrates from OpenAI to Claude, or for new AI-powered features.

---

## Applicable Patterns

### 1. Prompt Caching

**Notebook:** `misc/prompt_caching.ipynb`

**Why it applies:** The Flask backend sends a SOAP formatting prompt on every single patient encounter. The system prompt (Portuguese pediatric SOAP instructions, field mapping for G-Hosp's 6 wysihtml5 editors, CID-10 suggestion rules) is identical across all requests — only the transcribed text and chief complaint vary. With 20-40 patients per shift, the same system prompt is sent 20-40 times. The `customInstructions` field (from `popup.js` settings, stored in `chrome.storage.sync`) changes rarely (per-doctor, not per-patient).

**How to implement:**
- In the Flask backend's SOAP generation endpoint, add `cache_control: {"type": "ephemeral"}` to the system message containing the SOAP formatting instructions and CID rules.
- The ~164 CID-10 codes from `content/cid.js` could be included as a cached reference block in the system prompt so Claude can do fuzzy matching server-side without a separate API call (currently `api-client.js` exposes both `suggestCid()` and `formatSoap()` as separate endpoints).
- Merge the SOAP + CID calls (currently parallelized via `ThreadPoolExecutor` in the Flask backend) into a single Claude call with a cached system prompt, reducing both latency and cost.

**Priority:** **NOW** — This is the single highest-impact optimization. The SOAP system prompt is large and repetitive; 90% token cost reduction on input tokens across a full shift is significant. Cache TTL (5 minutes) fits perfectly: a pediatrician rarely goes 5 minutes between patients during a busy shift.

---

### 2. Evaluator-Optimizer

**Notebook:** `patterns/agents/evaluator_optimizer.ipynb`

**Why it applies:** SOAP note quality is critical — these notes go into medical records. Currently, GPT-4o-mini generates the SOAP note in a single pass with no validation. Known issues: the `[OBJETIVO_PLACEHOLDER]` substitution in `_postprocess_soap()` is a workaround for output quality; `customInstructions` from the popup are appended but their effect is unverified. A generate-then-evaluate loop would catch:
- Missing SOAP sections (S/O/A/P)
- CID code mismatches (suggested CID doesn't match the assessment)
- Portuguese medical terminology errors
- Hallucinated medications or dosages

**How to implement:**
- **Generator:** Claude Haiku generates the SOAP note from the Whisper transcript (fast, cheap).
- **Evaluator:** A second Claude call (Haiku or Sonnet) checks: all 4 SOAP sections present, CID code matches assessment, no fabricated exam findings, Portuguese grammar. Returns pass/fail + specific feedback.
- **Refinement:** If evaluator fails, the original note + feedback go back to the generator (max 1 retry to stay within latency budget).
- Wire this into the Flask `/api/transcribe` endpoint. Add a toggle in `popup.js` settings (`enhancedSoapQuality: true/false`) so doctors can opt in.
- Latency budget: current SOAP generation is ~3.2s; the evaluate-refine loop should stay under 6s total (Haiku is fast enough).

**Priority:** **THIS_MONTH** — Quality matters more than speed for medical notes, but the current single-pass approach works acceptably. Implement after prompt caching is in place to control costs.

---

### 3. Prompt Caching + CID-10 Database (combined with context engineering)

**Notebook:** `misc/prompt_caching.ipynb` (applied to domain data)

**Why it applies:** `content/cid.js` contains 164 hardcoded pediatric CID-10 codes with only substring matching (`TOCAFICHADR_cidSearch` does case-insensitive substring on code or name). This misses: misspellings, synonyms (e.g., "gripe" should match J06.9), partial descriptions. The full CID-10 has ~70,000 codes; the 164-code subset was hand-picked.

**How to implement:**
- Include the full 164-code pediatric CID database as a cached block in the SOAP system prompt.
- Claude can do fuzzy/semantic CID matching as part of SOAP generation — understanding that "crianca com tosse e febre" maps to J06.9, not just substring matching.
- This eliminates the separate `/api/suggest-cid` endpoint in `api-client.js` and the client-side `cid.js` fuzzy search for AI-suggested codes (keep client-side search for manual CID lookup in the HUD input field).

**Priority:** **NOW** — Combine with prompt caching implementation above. Zero additional cost if the CID list is part of the cached system prompt.

---

### 4. Basic Workflows — Chaining

**Notebook:** `patterns/agents/basic_workflows.ipynb`

**Why it applies:** The "Finalizar Paciente" flow in `hud.js` is a sequential chain: save form -> open prescription -> select template -> insert -> print -> discharge -> return to list. Each step depends on the previous one succeeding. Currently, this chain is hardcoded in `hud.js` with manual `waitFor()` calls and fragile DOM selectors. If any step fails, the whole chain stops.

A chained workflow pattern applies to the **backend transcription pipeline** specifically: Audio -> Whisper transcription -> SOAP formatting -> CID suggestion -> (optional) prescription suggestion. Each step transforms output for the next.

**How to implement:**
- In the Flask backend, structure the transcription pipeline as an explicit chain where each step's output feeds the next.
- Step 1: Transcribe audio (Whisper or Claude audio input).
- Step 2: Format SOAP from transcript + chief complaint (Claude with cached prompt).
- Step 3: Suggest CID from SOAP assessment section (Claude, same call or chained).
- Step 4 (new): Suggest prescription based on diagnosis (e.g., J06.9 -> "SF nasal 6/6h" from template library).
- Gate: if Step 1 confidence is low, ask for re-recording instead of proceeding.

**Priority:** **THIS_MONTH** — The current `ThreadPoolExecutor` parallel approach works but loses the ability to pass SOAP context into CID suggestion. Chaining lets the CID step see the full SOAP note.

---

### 5. Building Evals

**Notebook:** `misc/building_evals.ipynb`

**Why it applies:** Toca Ficha Dr. has **zero automated tests** (`package.json` has `"test": "echo \"Error: no test specified\" && exit 1"`). The SOAP generation quality, CID suggestion accuracy, and prompt effectiveness are completely untested. For a medical product, this is a risk. Evals would catch regressions when:
- Switching from GPT-4o-mini to Claude
- Modifying the SOAP system prompt
- Changing the CID suggestion logic
- Adding `customInstructions` support

**How to implement:**
- Create a test corpus: 20-30 anonymized audio transcripts with expected SOAP outputs and CID codes (from real shift data, de-identified).
- Define eval criteria:
  - SOAP completeness: all 4 sections present and non-empty
  - CID accuracy: suggested code matches a pediatric expert's choice
  - Portuguese quality: no English leakage, correct medical terminology
  - Latency: end-to-end under 8 seconds
- Use Claude as an LLM judge (per the cookbook pattern) to grade SOAP notes against reference outputs.
- Run evals on every prompt change, model change, or backend update.
- Store results in a `tests/evals/` directory with timestamped results.

**Priority:** **NOW** — This should be implemented before any model migration. Without evals, switching from GPT-4o-mini to Claude is a blind change. The cookbook's LLM-as-judge pattern is perfect for grading medical notes where exact-match is too strict.

---

### 6. Extended Thinking

**Notebook:** `extended_thinking/extended_thinking.ipynb`

**Why it applies:** Two specific use cases in Toca Ficha Dr. benefit from deeper reasoning:
1. **Complex differential diagnosis:** When a child presents with ambiguous symptoms (e.g., "febre + dor abdominal + vomitos"), the CID suggestion requires reasoning through differentials (appendicitis vs. gastroenteritis vs. UTI). Currently, GPT-4o-mini picks the most common match.
2. **Custom instructions interpretation:** The `customInstructions` field in popup settings lets doctors add free-text rules (e.g., "sempre incluir peso-dose na conduta", "nao usar antibiotico para IVAS"). Interpreting these correctly requires understanding medical context.

**How to implement:**
- Add an optional "deep analysis" mode triggered when the SOAP assessment is ambiguous (e.g., multiple possible diagnoses detected).
- Use Claude with extended thinking for the CID suggestion step only (not the full SOAP — that needs to stay fast).
- In the Flask backend, detect ambiguity (e.g., SOAP assessment mentions 2+ conditions) and route to extended thinking.
- Budget: 2,000 thinking tokens max to keep latency under 5s for this step.

**Priority:** **WHEN_NEEDED** — The current single-pass CID suggestion is adequate for common pediatric presentations (which are 80% of cases). Extended thinking adds latency and cost for marginal improvement on straightforward cases.

---

### 7. Memory Cookbook

**Notebook:** `tool_use/memory_cookbook.ipynb`

**Why it applies:** Toca Ficha Dr. currently has no cross-session learning. Each patient encounter is independent. But patterns exist:
- A doctor's `customInstructions` are static text, but their actual preferences evolve (e.g., they always edit the SOAP "Plano" section to add "retorno em 48h" — Toca Ficha Dr. could learn this).
- Prescription template usage patterns: if a doctor always uses "Amoxicilina 50mg/kg" for J03.9 (amigdalite), Toca Ficha Dr. could auto-suggest that template.
- CID correction patterns: if the doctor overrides the AI-suggested CID 40% of the time for a specific chief complaint, the system should learn.

**How to implement:**
- Add a `memory` table in the Flask backend (or use `chrome.storage.local` for client-side memory).
- Track: CID overrides (suggested vs. actually used), prescription template selections per diagnosis, SOAP edit patterns (which sections the doctor always modifies).
- Feed learned preferences into the SOAP system prompt as few-shot examples: "This doctor prefers X for Y."
- Use the cookbook's memory tool pattern: after each "Finalizar Paciente," extract and store preferences. Before the next SOAP generation, retrieve relevant memories.

**Priority:** **THIS_MONTH** — High-value feature that differentiates Toca Ficha Dr. from generic transcription tools. Requires the audit logging infrastructure (`api-client.js` already has `logAudit()`) to capture CID overrides and template selections.

---

## Patterns Evaluated but Not Applicable

### Managed Agents API (`managed_agents/`)
Toca Ficha Dr. is a Chrome extension with a thin Flask backend. There is no server-side agent that needs human-in-the-loop approval, webhook orchestration, or long-running sessions. The transcription pipeline is a simple request-response flow (audio in, SOAP out). Managed agents are designed for autonomous server-side workflows — Toca Ficha Dr.'s automation is entirely client-side DOM manipulation orchestrated by `hud.js`.

### Orchestrator-Workers (`patterns/agents/orchestrator_workers.ipynb`)
The "Finalizar Paciente" flow could theoretically be decomposed by an orchestrator, but the tasks are strictly sequential (save -> prescribe -> print -> discharge) with no dynamic decomposition needed. The steps are fixed and deterministic — DOM automation, not AI reasoning. An orchestrator adds complexity without benefit.

### Tool Search with Embeddings (`tool_use/tool_search_with_embeddings.ipynb`)
Toca Ficha Dr. has a small, fixed set of actions (record, SOAP, CID, prescribe, discharge). There are no "tools" to discover dynamically. The 164 CID codes could use embeddings for search, but prompt caching with Claude's native understanding is simpler and cheaper.

### Context Compaction (`tool_use/automatic-context-compaction.ipynb`)
Toca Ficha Dr.'s API calls are stateless request-response — there are no long-running conversations or multi-turn sessions that accumulate context. Each patient encounter is a single API call (audio -> SOAP). No context window pressure.
