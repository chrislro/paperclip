# Toca Ficha Dr. — Full Technical Review & Go-to-Market Plan
> **Goal:** Turn the current G-Hosp automation into a sellable Chrome Web Store MVP.  
> **Focus:** Audio recording pipeline, transcription engine (Realtime vs. Whisper vs. alternatives), and EMR-agnostic architecture.  
> **Date:** 2026-04-27

---

## 1. Current Architecture Audit

### 1.1 What Works Well ✅
| Component | Assessment |
|-----------|------------|
| **Audio Capture** (`audio-capture.js`) | Clean `MediaRecorder` wrapper. 32 kbps Opus is optimal for speech. Handles `track.ended` events gracefully. |
| **Transport** (SW proxy) | Correctly uses the Service Worker to bypass Mixed Content / Private Network Access (PNA) blocks when the content script is on HTTPS G-Hosp and the backend is HTTP localhost. |
| **Security** | Sender allowlist, URL path restrictions (`/api/*`), auth token stripped from caller. Good MV3 hygiene. |
| **Error Handling** | Extensive `chrome.runtime.lastError` checks, context-invalidation detection, fire-and-forget telemetry. |
| **Billing Infra** | Stripe + usage tracking scaffolding is present. |

### 1.2 Critical Weaknesses ⚠️
| Component | Problem | Impact on CWS MVP |
|-----------|---------|-------------------|
| **Hardcoded EMR** | Content script only injects on `prbentogoncalves.g-hosp.com.br`. `dom-engine.js`, `selectors.json`, and `fillCid()` are tightly coupled to one hospital's G-Hosp instance. | **Cannot sell on the Chrome Web Store.** A store extension must work for any doctor on any EMR. |
| **Batch Latency** | Record → base64 encode → SW → Flask → Whisper → GPT-4o-mini → response. For a 60s dictation this is ~5–12s end-to-end. | Acceptable for automation, but uncompetitive against modern "ambient scribes" that draft notes in real time. |
| **Base64 Overhead** | Audio is base64-encoded for JSON messaging. 33% size bloat. | Slower uploads, higher memory pressure in the content script. Use `ArrayBuffer` + chrome extension messaging if possible, or stream directly. |
| **Local Backend Dependency** | Free tier requires the user to run a local Flask server on port 5050. | Massive friction for a store MVP. 99% of doctors will bounce. Cloud backend must be the default. |
| **No Offscreen Document** | MV3 Service Workers cannot maintain long-lived WebSockets (they terminate after ~5 min of inactivity). This blocks true real-time streaming architectures. | Must introduce an Offscreen Document if we want to use OpenAI Realtime API or any streaming STT. |

---

## 2. Transcription Engine: The Big Decision

You asked specifically about **OpenAI Realtime API** vs. **Whisper** vs. other options. Here's the breakdown based on the latest benchmarks (2025–2026) and your specific use case (Brazilian Portuguese medical dictation).

### 2.1 Option A: OpenAI Realtime API (Audio → Text)
**How it works:** You open a WebSocket to `wss://api.openai.com/v1/realtime` and stream raw audio chunks (PCM16). The model transcribes *and* reasons in the same session. You instruct it via `session.update` to output a structured SOAP note in Portuguese.

**Pros:**
- **Lowest latency:** First words appear in ~300–800ms. The note drafts *as the doctor speaks*.
- **Single API:** No separate "transcribe then format" pipeline. The model hears audio and outputs formatted text.
- **Turn detection:** Native voice activity detection (VAD) means you don't have to build a "stop recording" button if you don't want to.

**Cons:**
- **Cost:** This is the most expensive option by far.
  - GPT-4o Realtime: **$0.06 / min** audio input + text output tokens.
  - GPT-4o Mini Realtime: **$0.025 / min** audio input + text output tokens.
  - A doctor dictating for 30 min/day = **$45–$108 / month per user** in API costs alone. Your current Pro tier is R$49 (~$8.50). **This is economically impossible unless you charge >R$300/mo.**
- **MV3 Complexity:** Service Workers kill WebSockets. You must use an **Offscreen Document** to hold the WS connection. This is doable but adds architectural complexity.
- **Overkill for dictation:** Realtime API is designed for *conversational* AI (turn-taking, interruptions). For a one-way medical dictation, you're paying for features you don't need.

**Verdict:** ❌ **Not recommended for the MVP batch tier.** Reserve it for a future "Live Scribe" premium tier only.

---

### 2.2 Option B: Whisper Batch (Current) + LLM
**How it works:** Record full audio → upload to backend → Whisper transcribes → GPT-4o-mini formats SOAP.

**Pros:**
- **Cheapest:** GPT-4o Mini Transcribe is **$0.003 / min**. GPT-4o Transcribe is **$0.006 / min**.
  - 30 min/day = **$2.70 / month per user**. Fits comfortably inside a R$49/mo price point.
- **Proven:** Your current backend already does this.
- **High accuracy:** GPT-4o-transcribe is the current benchmark leader for general transcription.

**Cons:**
- **Latency:** 5–12s wait after stopping recording.
- **No diarization:** If there are multiple speakers (doctor + patient + parent), Whisper won't label them. For your use case (single-doctor dictation), this doesn't matter.
- **25MB file limit:** At 32kbps, this is ~100 minutes. You're fine.

**Verdict:** ✅ **Keep this as the default engine for the MVP.** It's the only economically viable option for a R$49/mo SaaS.

---

### 2.3 Option C: Deepgram (Streaming or Batch)
**How it works:** Deepgram Nova-3 is a purpose-built STT model with a medical vocabulary mode.

**Pros:**
- **Medical accuracy:** Deepgram Nova-3 Medical is specifically trained on clinical audio.
- **Streaming available:** ~200–400ms latency if you want real-time later.
- **Cheap batch:** **$0.0043 / min** (slightly cheaper than Whisper).
- **Brazilian Portuguese:** Deepgram has strong multilingual support.
- **HIPAA BAA available:** Important if you ever expand to the US or need enterprise contracts.

**Cons:**
- **Adds a vendor:** You're already using OpenAI for LLM. Adding Deepgram means managing two API keys and two billing relationships.
- **You still need an LLM:** Deepgram only gives you raw text. You still need GPT/Claude to format the SOAP note.

**Verdict:** ⚠️ **Strong alternative to Whisper.** Consider switching if you find Whisper struggling with pediatric medical terms (e.g., "cefaleia", "exantema", "otorreia"). Best used if you decide to build a **streaming** pipeline later.

---

### 2.4 Option D: Groq Whisper
**How it works:** Whisper Large V3 hosted on Groq's LPU inference engine.

**Pros:**
- **Fastest batch:** Processes 60 min of audio in ~30 seconds (vs. 6–12 min on OpenAI).
- **Cheapest:** **$0.002 / min**.

**Cons:**
- **No advanced features:** No diarization, no medical fine-tuning.
- **Smaller ecosystem:** Less tooling than OpenAI or Deepgram.

**Verdict:** ✅ **Best "drop-in" replacement for your current Whisper backend if you want to cut costs by 60% and speed up processing.**

---

### 2.5 Decision Matrix

| Criteria | OpenAI Realtime | Whisper Batch (OpenAI) | Deepgram Batch | Groq Whisper |
|----------|----------------|------------------------|----------------|--------------|
| **Cost / 30 min day** | ~$45–$108 | ~$2.70 | ~$3.87 | ~$1.80 |
| **Latency** | ~300ms | ~5–12s | ~3–8s | ~1–3s |
| **Medical Accuracy** | Good | Good | **Excellent** (Nova-3 Medical) | Good |
| **Portuguese (BR)** | Good | Good | Good | Good |
| **MV3 Complexity** | High (Offscreen Doc) | Low | Low | Low |
| **Viable at R$49/mo** | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes |

---

## 3. The MVP Pivot: From "G-Hosp Hack" to "Ambient Scribe"

### 3.1 The Core Insight
Your current extension is an **automation robot** for one specific EMR. To sell on the Chrome Web Store, it must become a **universal medical scribe** that works on *any* EMR or even a blank Google Doc.

**Why?**
- Chrome Web Store reviewers will reject an extension that requests host permissions for `*.g-hosp.com.br` unless you own that domain.
- Doctors use dozens of EMRs (SoulMV, Tasy, MV, PEP, etc.). Limiting to G-Hosp caps your TAM (Total Addressable Market) at ~hundreds of users.
- DOM automation is fragile. Every EMR update breaks your extension and triggers negative reviews.

### 3.2 The New User Flow
1. Doctor clicks extension icon (or uses hotkey).
2. A floating panel (or side panel) opens.
3. Doctor presses **Record** and dictates the consultation.
4. Doctor presses **Stop**.
5. Extension shows the SOAP note in a clean, editable text area.
6. Doctor presses **Copy** and pastes into their EMR.

This is how **Nuance DAX**, **Abridge**, and **Nabla Copilot** work. It's copy-paste, but it's **universal and robust**.

### 3.3 What To Keep vs. What To Kill

| Keep | Kill |
|------|------|
| `audio-capture.js` (with minor tweaks) | `dom-engine.js` (entire file) |
| `api-client.js` (backend transport) | `selectors.json` |
| `cid.js` (as a lookup helper, not auto-fill) | `content.js` (EMR-specific injection) |
| Service Worker + proxy pattern | Hardcoded G-Hosp host permissions |
| HUD floating panel UI | "Finalizar Paciente" one-click automation |

---

## 4. Recommended Architecture for the MVP

### 4.1 Tier 1: "Batch Scribe" (Launch This First)
**Engine:** Groq Whisper ($0.002/min) or OpenAI GPT-4o Mini Transcribe ($0.003/min).  
**Backend:** Deployed Flask/FastAPI on Railway or Fly.io.  
**Extension:**
- Popup-based UI (or Side Panel API).
- Record → Upload → Wait → Show SOAP.
- Copy-to-clipboard + "Insert into page" (optional, via `document.execCommand('insertText')` on focused text area).

**Why launch this first:**
- It works today.
- It's cheap.
- It can be built in 2–3 weeks.
- It validates whether doctors will *pay* for a scribe before you invest in real-time infrastructure.

### 4.2 Tier 2: "Live Scribe" (Phase 2)
**Engine:** OpenAI Realtime API OR Deepgram Streaming + GPT-4o.  
**Extension:**
- Use Chrome's **Offscreen Document API** to maintain a persistent WebSocket connection.
- Stream audio from the content script → Offscreen Doc → API.
- Show a "live draft" that updates word-by-word as the doctor speaks.
- Requires a higher price point (R$149+/mo) to cover API costs.

**Why delay this:**
- High engineering complexity.
- High API burn rate.
- You need a user base to A/B test whether live drafting is actually better than batch (some doctors find live text distracting).

---

## 5. Implementation Roadmap

### Phase 1: Refactor to Universal Scribe (Weeks 1–3)
- [ ] **Strip EMR logic:** Remove `dom-engine.js`, `selectors.json`, and G-Hosp-specific host permissions.
- [ ] **New UI:** Build a popup/side-panel recorder. Show SOAP in a `<textarea>` inside the popup.
- [ ] **Copy/Paste:** Implement "Copy SOAP" and "Copy Prescription" buttons.
- [ ] **Backend Deploy:** Move Flask backend to Railway/Fly.io with a stable domain (`api.tocafichadr.com.br`).
- [ ] **Auth:** Keep JWT auth. Every user gets a 14-day trial.
- [ ] **Limits:** Enforce usage limits server-side (not client-side like today).

### Phase 2: Store Submission (Week 4)
- [ ] **Screenshots:** 5 screenshots (1280×800) showing: popup, recording state, SOAP result, prescription template, settings.
- [ ] **Description:** Write for *all* doctors, not just G-Hosp users. Emphasize "works in any EMR".
- [ ] **Privacy Policy:** Ensure HTTPS live URL. State LGPD compliance, no PHI storage, audio deleted after transcription.
- [ ] **Permissions:** Minimal permissions. `activeTab`, `storage`, `clipboardWrite`, `host_permissions: <all_urls>` (only if using content script injection; otherwise host permissions are unnecessary for a popup-only extension!).
- [ ] **Pay $5** developer fee and submit.

### Phase 3: Realtime Experiment (Month 2–3)
- [ ] **Offscreen Document:** Build a prototype that streams audio to OpenAI Realtime API.
- [ ] **Cost Analysis:** Run 20 test consultations. Calculate exact token burn.
- [ ] **Pricing:** If viable, launch "Toca Ficha Pro Ultra" at R$149/mo for live mode.
- [ ] **Fallback:** If Realtime is too expensive, build a "pseudo-live" mode using Deepgram streaming + GPT-4o (cheaper, slightly higher latency but still sub-second).

### Phase 4: Compliance & Scale (Month 3+)
- [ ] **CFM 2.454/2026:** Add a mandatory checkbox: "Eu revisei e confirmo que este prontuário reflete a consulta." (This is naturally satisfied if the user copy-pastes manually, but explicit UI is safer).
- [ ] **LGPD:** Add a Data Processing Agreement (DPA) to your terms. Use a Brazilian cloud provider (e.g., AWS São Paulo region) if storing any data.
- [ ] **CID-10 & Prescriptions:** Keep these as "smart templates" the user can insert into the SOAP text area, not as DOM automation.

---

## 6. Business Model & Pricing

| Plan | Price | What's Included | Engine |
|------|-------|-----------------|--------|
| **Free** | R$0 | 5 patients/day (or 30 min audio). Watermarked output. | Batch (Groq or OpenAI) |
| **Pro** | R$49/mo | Unlimited patients. Prescription templates. CID suggestion. | Batch (Groq or OpenAI) |
| **Pro Ultra** | R$149/mo | Live drafting. Priority speed. | Realtime or Streaming |

**Unit economics (Pro tier):**
- Average dictation: 3 min/patient.
- 30 patients/day × 3 min = 90 min/day.
- 90 min × 22 work days = 1,980 min/month.
- Cost at $0.003/min (OpenAI Mini) = **$5.94 / user / month**.
- Cost at $0.002/min (Groq) = **$3.96 / user / month**.
- **Margin:** R$49 ≈ $8.50. After API costs, you have ~$2.50–$4.50 per user for infrastructure + profit. Tight, but viable at scale.

---

## 7. Immediate Next Steps (This Week)

1. **Decision:** Do you agree with the "Universal Scribe" pivot? If yes, we start stripping `dom-engine.js` and rebuilding the popup.
2. **Backend:** Choose between keeping OpenAI ($0.003/min) or switching to Groq ($0.002/min) for the batch tier. Groq is a 1-line code change (swap the API URL/key).
3. **Offscreen Doc Spike:** If you're excited about Realtime, I can build a 50-line proof-of-concept this week to stream your mic to OpenAI and print the SOAP draft in the console. This will give us real cost data.

---

## 8. Sources & Further Reading

- OpenAI Realtime API Pricing: https://platform.openai.com/docs/guides/realtime
- Groq Whisper Pricing: https://groq.com/pricing/
- Deepgram Nova-3 Medical: https://deepgram.com/learn/best-speech-to-text-apis
- AssemblyAI Medical Scribe: https://www.assemblyai.com/blog/speech-to-text-api-for-ai-medical-ambient-scribes
- Chrome MV3 Offscreen Documents: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- CFM Resolution 2.454/2026 (AI in Medicine): Monitor for final publication.

---

*Ready to proceed? Tell me which Phase 1 task you want to tackle first.*
