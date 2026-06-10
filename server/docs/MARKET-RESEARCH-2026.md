# Toca Ficha Dr. Market Research Report

**Date:** March 31, 2026
**Product:** Toca Ficha Dr. -- Chrome Extension for Pediatric EMR Automation (G-Hosp)
**Author:** Market Research (AI-Assisted)
**Status:** Pre-launch intelligence

---

## Executive Summary

Toca Ficha Dr. enters a nascent but rapidly growing market at the intersection of AI clinical documentation, EMR automation, and Brazilian healthcare IT. The Brazilian EMR market is valued at ~US$671M (2025) and projected to reach US$1.1B by 2030 (CAGR 10.57%). Voice-first clinical documentation is a global megatrend, with the healthcare voice recognition market expected to grow from US$8.56B (2023) to US$24.1B (2031).

Toca Ficha Dr.'s niche -- a lightweight Chrome extension automating pediatric workflows specifically within G-Hosp -- has **no direct competitor**. The closest alternatives are either enterprise-scale EMR platforms (MV, Tasy, Pixeon) that sell to hospital IT departments, or general-purpose AI scribes (DoctorAssistant.ai, Medgical) that generate notes but do not automate EMR DOM interactions. Toca Ficha Dr.'s unique value proposition is end-to-end workflow automation: voice-to-SOAP, CID-10 suggestion, prescription templating, and one-click patient finalization -- all inside the EMR, without requiring hospital IT involvement.

At R$49/month, Toca Ficha Dr. would be priced **3x below** the cheapest Brazilian AI scribe (DoctorAssistant.ai at R$139.90/month) while offering deeper EMR integration. The primary risks are DOM fragility (G-Hosp UI changes), regulatory compliance with CFM Resolution 2.454/2026 (effective August 2026), and the inherently narrow initial addressable market (G-Hosp pediatric users only).

**Recommendation:** Launch at R$49/month as a physician-direct tool. Validate at 1-2 hospitals, then expand to other G-Hosp specialties and instances before considering multi-EMR support.

---

## Key Findings

1. **No direct competitor exists** for Chrome-extension-based EMR workflow automation in Brazil targeting G-Hosp.
2. **G-Hosp serves 200+ municipalities across 10 Brazilian states**, benefiting 12M+ citizens, but is a tier-2 EMR behind MV (800+ institutions) and Philips Tasy.
3. **DoctorAssistant.ai** (R$139.90/month) is the closest Brazilian AI scribe competitor but lacks EMR DOM integration.
4. **CFM Resolution 2.454/2026** (effective August 2026) mandates disclosing AI use in medical records -- Toca Ficha Dr. must add a visible annotation in SOAP notes.
5. **ANVISA RDC 657/2022** likely classifies Toca Ficha Dr. as low-risk or exempt (documentation/workflow automation, not diagnostic), but requires legal review.
6. **R$49/month is highly competitive** -- global AI scribes charge US$99-800/month; Brazilian alternatives start at R$139.90/month.
7. **Physician-led adoption** (bottom-up) is viable for Chrome extensions, as demonstrated by Pippen, PhysicianUX, and Diagnoss internationally.
8. **Brazil's SUS is investing R$1.7B** in smart hospital infrastructure starting 2026, signaling strong government tailwinds for health IT adoption.

---

## 1. Competitive Analysis

### 1.1 Enterprise EMR Platforms (Indirect Competitors)

These are the EMR systems themselves -- not plugins. They compete only if they build native automation features that eliminate Toca Ficha Dr.'s use case.

| Competitor | Type | Pricing | Traction | AI/Voice Features | Threat Level |
|---|---|---|---|---|---|
| **MV Sistemas (SOUL)** | Full EMR suite | Enterprise licensing (undisclosed) | 800+ institutions, 80K+ physicians, #1 in Brazil | Limited voice; no AI scribe built-in as of 2026 | Medium -- if they add native AI scribe |
| **Philips Tasy** | Full EMR suite | Enterprise licensing (undisclosed) | Major presence in Latin America, expanding globally | AI Virtual Assistant launched (LLM-based), voice navigation, data extraction from clinical notes | High -- actively building AI features |
| **Pixeon (SmartHealth)** | Full EMR suite | Enterprise licensing (undisclosed) | Strong in imaging/diagnostics; smaller in hospital EMR | Workflow automation, EHR integration; no dedicated AI scribe | Low |
| **G-Hosp (Inovadora)** | Full EMR suite | Government/municipal contracts | 200+ municipalities, 10 states, 12M+ citizens | No AI features; no voice; no automation layer | Low (but they could block extensions) |

**Key insight:** MV and Tasy are adding AI features, but these are enterprise products that take 12-24 months to roll out. Toca Ficha Dr. can move faster as a lightweight overlay. G-Hosp itself has no AI roadmap visible, creating a clear gap.

#### Strengths/Weaknesses of Enterprise Players

- **MV Sistemas:** Dominant market share, trusted by large hospital networks. Weakness: slow innovation cycle, enterprise sales model, no physician-direct tools.
- **Philips Tasy:** Most advanced AI features (AI Virtual Assistant with LLM). Weakness: expensive, requires full Tasy deployment, not available for G-Hosp users.
- **Pixeon:** Strong in diagnostics/imaging. Weakness: smaller hospital EMR footprint, AI features focused on radiology not clinical documentation.
- **G-Hosp:** Affordable for public hospitals, modular. Weakness: no AI/voice features, limited development resources compared to MV/Tasy.

### 1.2 AI Medical Scribes (Direct Competitors)

These generate clinical notes from voice but do not integrate with EMR DOM.

| Competitor | Type | Pricing | Traction | Key Features | vs. Toca Ficha Dr. |
|---|---|---|---|---|---|
| **DoctorAssistant.ai** | AI Scribe (Brazilian) | R$139.90/month (Pro); Free tier: 10 consults/mo | First Brazilian AI scribe; integrations with GoClin, Amplimed, iMedicina | Voice-to-ReSOAP, CID suggestion, Portuguese NLP, LGPD compliant, no audio storage | Generates notes but requires manual copy-paste into EMR. No DOM automation. |
| **Medgical AI** | AI Scribe (Portuguese-language) | Undisclosed | Growing; 16+ report templates | Audio transcription, clinical summarization, multi-specialty templates | Similar to DoctorAssistant; no EMR-specific integration |
| **Freed** | AI Scribe (US-based) | US$39-119/month | 60K+ clinicians (US) | Real-time scribe, custom templates, works on any device | English-only; no Brazilian EMR support; no CID-10 |
| **DeepScribe** | AI Scribe (US-based, enterprise) | ~US$750/month/clinician | Enterprise (oncology, cardiology focus) | Ambient listening, E&M coding, EHR integration (US systems) | English-only; enterprise pricing; no Brazil presence |
| **Abridge** | AI Scribe (US-based, enterprise) | US$300-500/month | Large US health systems | Ambient AI, structured notes, Epic/Cerner integration | English-only; requires IT deployment |

**Key insight:** No Brazilian AI scribe offers DOM-level EMR automation. They all stop at "generate note, copy to clipboard." Toca Ficha Dr.'s one-click finalization flow (save, prescribe, print, discharge) is a category-defining differentiator.

### 1.3 Healthcare RPA (Tangential Competitors)

| Competitor | Type | Pricing | Relevance |
|---|---|---|---|
| **UiPath (Healthcare)** | Enterprise RPA platform | Enterprise licensing (US$10K+/year) | Claims processing, billing, scheduling -- not clinical documentation. Overkill for single-workflow automation. |
| **Automation Anywhere** | Enterprise RPA platform | Enterprise licensing | Similar to UiPath. No physician-facing tools. |
| **Robo Laura** | Clinical AI (Brazilian) | Undisclosed (hospital contracts) | Patient risk prediction, mortality reduction. Not documentation automation. Different category entirely. |

**Key insight:** RPA tools are designed for back-office hospital operations (billing, scheduling), not for physician-facing clinical workflows. Robo Laura is clinical AI but focused on patient safety/risk prediction, not documentation. None compete with Toca Ficha Dr.'s specific use case.

---

## 2. Market Sizing

### 2.1 Brazilian Healthcare Infrastructure

| Metric | Value | Source |
|---|---|---|
| Total hospitals in Brazil | ~6,500 (CNES 2024) | DATASUS/CNES |
| Public hospitals | ~40% (~2,600) | CNES |
| Private hospitals | ~60% (~3,900) | CNES |
| Total health regions | 450 | DATASUS |
| Municipalities with hospitals | 5,570 | DATASUS |

### 2.2 Brazilian EMR Market

| Metric | Value | Source |
|---|---|---|
| Market size (2025) | US$670.98M | Knowledge Sourcing Intelligence |
| Projected market size (2030) | US$1,108.98M | Knowledge Sourcing Intelligence |
| CAGR | 10.57% | Knowledge Sourcing Intelligence |
| Key players | MV Sistemas (#1), Philips Tasy (#2), Pixeon, G-Hosp (tier 2) | KLAS Research, market reports |

### 2.3 G-Hosp Addressable Market

| Metric | Value | Notes |
|---|---|---|
| Municipalities served | 200+ | Inovadora Sistemas website |
| States covered | 10 | Inovadora Sistemas website |
| Citizens benefited | 12M+ | Inovadora Sistemas website |
| Estimated hospitals using G-Hosp | 150-300 (estimate) | Based on 200+ municipalities; many smaller/public hospitals |
| Hospital types | Predominantly public, small-to-medium | Municipal and state hospital contracts |

### 2.4 Pediatric Market Segment

| Metric | Value | Notes |
|---|---|---|
| Pediatric departments in Brazil | Estimated 3,000-4,000 | Most general hospitals have pediatric ER/ward |
| Pediatric departments in G-Hosp hospitals | Estimated 100-250 | Subset of G-Hosp hospital base |
| Pediatricians per department (shift-based) | 3-8 | Typical rotation model |
| Estimated pediatricians on G-Hosp | 400-1,500 | Conservative range |

### 2.5 TAM / SAM / SOM

| Market Layer | Calculation | Annual Revenue |
|---|---|---|
| **TAM** (All physicians on Brazilian EMRs who could use AI scribes) | 250,000 physicians x R$49/mo x 12 | R$147M/year |
| **SAM** (Pediatricians + ER physicians on G-Hosp) | ~1,500 physicians x R$49/mo x 12 | R$882K/year |
| **SOM** (Realistic Year 1: single hospital expanding to 5-10) | 30-80 physicians x R$49/mo x 12 | R$17.6K-47K/year |

**Note:** The SOM is modest but validates the model. The real growth path is expanding beyond pediatrics (all G-Hosp specialties) and then beyond G-Hosp (multi-EMR support).

---

## 3. Pricing Intelligence

### 3.1 Brazilian Healthcare Software Pricing Models

| Model | Examples | Typical Range |
|---|---|---|
| Per-physician/month SaaS | DoctorAssistant.ai, telemedicine platforms | R$99-300/month |
| Per-institution licensing | MV, Tasy, Pixeon | R$5,000-50,000+/month (varies by size) |
| Per-transaction/API call | Whisper API, GPT-4o-mini | Variable (usage-based) |
| Freemium + Pro | DoctorAssistant.ai (10 free consults/mo) | Free tier + R$139.90/mo Pro |

### 3.2 Competitive Pricing Comparison

| Product | Price | Market | Integration Level |
|---|---|---|---|
| **Toca Ficha Dr. (proposed)** | **R$49/month** | Brazil (G-Hosp) | Deep (DOM automation) |
| DoctorAssistant.ai | R$139.90/month | Brazil (generic) | Shallow (copy-paste) |
| Freed (US) | ~R$200-600/month (US$39-119) | US | Moderate (templates) |
| DeepScribe (US) | ~R$3,800/month (US$750) | US (enterprise) | Deep (US EHRs only) |
| Abridge (US) | ~R$1,500-2,500/month (US$300-500) | US (enterprise) | Deep (US EHRs only) |

### 3.3 Is R$49/month Competitive?

**Yes, extremely competitive.** Key rationale:

- **3x cheaper** than the nearest Brazilian competitor (DoctorAssistant.ai at R$139.90).
- **Deeper integration** -- Toca Ficha Dr. automates the full workflow, not just note generation.
- **Physician affordability** -- Brazilian physician salaries in public hospitals are lower than US counterparts. R$49/month is ~0.3% of a typical plantao income.
- **API cost basis** -- At ~R$0.05-0.15 per transcription (Whisper + GPT-4o-mini), a physician doing 30 patients/shift x 10 shifts/month = 300 calls = ~R$15-45 in API costs. R$49/month provides thin but positive margins.

**Risk:** At R$49/month with 300 API calls, margins are razor-thin. Consider R$69/month or a tiered model (e.g., Free: 50 patients/month, Pro: unlimited at R$49-79/month) to ensure sustainability.

---

## 4. Distribution Strategy

### 4.1 Distribution Channels

| Channel | Viability | Notes |
|---|---|---|
| **Chrome Web Store** | Medium | Discoverable but low organic traffic for medical tools. Portuguese keywords essential. |
| **Physician-to-physician (word of mouth)** | High | Physicians trust peer recommendations. One champion at a hospital can drive adoption. |
| **WhatsApp groups** | High | Brazilian physicians organize in specialty WhatsApp groups. Direct outreach is effective. |
| **Medical conferences** | Medium | Events like CBPED (Congresso Brasileiro de Pediatria) for targeted exposure. |
| **Hospital IT procurement** | Low (initially) | Complex, slow, requires compliance documentation. Better for later-stage expansion. |
| **Medical influencers / social media** | Medium-High | Instagram and YouTube medical content creators in Brazil could drive awareness. |

### 4.2 Adoption Model: Bottom-Up Physician-Led

The Chrome extension model enables **bottom-up adoption** without hospital IT involvement:

1. **Individual physician installs** the extension on their personal Chrome profile.
2. **No server-side changes** required at the hospital (Toca Ficha Dr. overlays the existing G-Hosp web UI).
3. **No IT approval needed** for initial use (though formalization is recommended for compliance).
4. **Viral mechanics** -- colleagues see the physician finishing patients 5x faster and ask about the tool.

This model mirrors how Diagnoss (ICD coding Chrome extension for AthenaHealth) and PhysicianUX (AI EMR overlay) achieved adoption in the US market.

### 4.3 Key Distribution Risks

- **Hospital IT may block Chrome extensions** via group policy.
- **G-Hosp could change their ToS** to prohibit third-party browser automation.
- **Chrome Web Store review** may flag the extension's `host_permissions` scope for `*.g-hosp.com.br`.

---

## 5. Regulatory Landscape

### 5.1 CFM Resolution 2.454/2026 (AI in Medicine)

**Status:** Published February 11, 2026. **Effective: August 10, 2026** (180-day grace period).

| Requirement | Impact on Toca Ficha Dr. | Action Required |
|---|---|---|
| AI use must be documented in patient records | Toca Ficha Dr.-generated SOAP notes must include a disclosure that AI was used | Add visible annotation: "Nota gerada com auxilio de IA (Toca Ficha Dr.)" |
| Physician retains final decision authority | Toca Ficha Dr. already requires physician review before saving | Document in UI that notes are "sugestoes" requiring physician confirmation |
| Patient has right to know about AI use | Hospital/physician must inform patients | Provide template consent language for physicians |
| Risk classification (low/medium/high/unacceptable) | Toca Ficha Dr. likely classifies as **low risk** (documentation assistance, no diagnostic decisions) | Document risk classification rationale |
| AI must not replace physician-patient communication | Toca Ficha Dr. assists documentation, does not interact with patients | Already compliant by design |
| Data protection per LGPD | All patient data must be handled per LGPD | Already addressed (no audio storage, encrypted transmission) |

**Assessment:** Toca Ficha Dr.'s architecture (voice dictation by physician, AI-suggested notes reviewed by physician, no diagnostic functionality) positions it as **low-risk** under CFM 2.454/2026. Compliance requires minor UI changes and documentation.

### 5.2 ANVISA RDC 657/2022 (Software as Medical Device / SaMD)

| Question | Analysis |
|---|---|
| Is Toca Ficha Dr. a medical device? | **Likely no.** Software exclusively for recording/viewing medical records is explicitly excluded from SaMD classification. |
| What about CID-10 suggestions? | **Gray area.** CID suggestion could be interpreted as clinical decision support. If the suggestion influences diagnosis, it may fall under Rule 9 (Class I or II). |
| What about prescription templates? | **Low risk.** Pre-defined templates selected by the physician are not prescriptive AI. |

**Recommendation:** Obtain formal legal opinion on ANVISA classification. Label CID-10 suggestions clearly as "sugestoes" (suggestions) and ensure the physician manually selects/confirms the code.

### 5.3 LGPD (Data Protection)

| Requirement | Toca Ficha Dr. Status |
|---|---|
| Legal basis for processing health data | Tutela da saude (health protection) by healthcare professional -- no separate consent needed for data processing for care purposes |
| Voice recording consent | **Required.** Physician must obtain patient consent before recording. Toca Ficha Dr. should display a reminder/prompt. |
| Audio storage | Toca Ficha Dr. Flask backend should not store audio after transcription (already the design) |
| Data minimization | Transcription text should be processed and not retained beyond the session |
| Cross-border data transfer | If using OpenAI API (US servers), requires adequate safeguards. Consider adding a disclosure. |

### 5.4 Regulatory Summary

| Regulation | Risk Level | Priority |
|---|---|---|
| CFM 2.454/2026 | Medium | Must comply by August 2026. Add AI disclosure to SOAP notes. |
| ANVISA RDC 657/2022 | Low-Medium | Likely exempt, but CID suggestion is a gray area. Get legal opinion. |
| LGPD | Medium | Voice recording consent flow needed. Document data handling. |

---

## 6. Market Trends

### 6.1 Voice-First Clinical Documentation (Global)

- The healthcare voice recognition market is projected to reach **US$24.1B by 2031** (from US$8.56B in 2023, CAGR 13.8%).
- In February 2026, major EHR providers began embedding real-time Voice AI as core infrastructure within AI-native EHR platforms.
- AI scribes are the fastest-growing category in health IT, with US adoption exceeding 60K+ clinicians for leading tools (Freed alone).

### 6.2 Healthcare AI in Brazil

- **SUS Smart Hospital Initiative (2026):** R$1.7B investment in smart ICUs, AI, 5G, and robotic surgery across 14 major cities. Signals strong government support for health IT.
- **Robo Laura expansion:** Now in hospitals across Parana, Rio Grande do Sul, Santa Catarina, and Sergipe, demonstrating Brazilian hospital willingness to adopt AI tools.
- **DoctorAssistant.ai emergence:** First Brazilian AI scribe, proving local market demand exists for Portuguese-language clinical documentation tools.

### 6.3 EMR Chrome Extension Ecosystem

- International precedent exists: Pippen, PhysicianUX, Diagnoss, and Comprehend all offer Chrome extensions that overlay browser-based EMRs.
- The model works because modern EMRs are web-based, making Chrome extensions a low-friction integration path.
- No Brazilian company has yet built an EMR-specific Chrome extension with AI capabilities.

### 6.4 Healthcare RPA Adoption

- Global healthcare RPA market valued at US$5.5B (2025), growing at 20% CAGR.
- Primarily focused on back-office operations (billing, claims, scheduling) rather than clinical documentation.
- Brazilian adoption remains early-stage, concentrated in large hospital networks.

---

## 7. Risks

### 7.1 Product Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| G-Hosp UI changes break DOM selectors | Critical | High (over 12+ months) | Remote selector config (already built), MutationObserver resilience, rapid patch capability |
| G-Hosp blocks third-party extensions | Critical | Low-Medium | Build relationship with Inovadora Sistemas; offer revenue share or partnership |
| Chrome Web Store rejects extension | High | Low | Follow Manifest V3 best practices; narrow host_permissions; clear privacy policy |
| Audio quality issues in noisy hospitals | Medium | Medium | Test noise cancellation; consider directional mic recommendation |

### 7.2 Market Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| G-Hosp market is too small for sustainable revenue | High | Medium | Expand to other specialties and EMRs |
| MV or Tasy builds native AI scribe | High | Medium (12-24 months) | Move fast; build physician loyalty; expand EMR coverage |
| DoctorAssistant.ai adds EMR integration | Medium | Medium | Toca Ficha Dr.'s DOM automation is technically harder to replicate |
| Physician reluctance to pay R$49/month | Medium | Medium | ROI is clear (40 min saved per shift); offer free trial |

### 7.3 Regulatory Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| CFM 2.454/2026 non-compliance | High | Low (if addressed proactively) | Add AI disclosure to SOAP notes before August 2026 |
| ANVISA classifies Toca Ficha Dr. as SaMD | Medium | Low | Get legal opinion; label CID suggestions as non-diagnostic |
| LGPD violation from voice recording | High | Low (if consent flow added) | Add consent reminder in HUD before recording |

---

## 8. Recommendations

### 8.1 Launch Strategy

1. **Price at R$49/month** with a generous free tier (e.g., 10 patients/day or 100/month). This undercuts DoctorAssistant.ai by 3x while covering API costs.
2. **Launch physician-direct** via Chrome Web Store + WhatsApp medical groups. Skip hospital IT procurement initially.
3. **Validate at 2-3 G-Hosp hospitals** in Rio Grande do Sul (developer's home region) before broader expansion.

### 8.2 Regulatory Compliance (Before August 2026)

4. **Add AI disclosure** to all generated SOAP notes: "Nota gerada com auxilio de IA - revisada pelo medico responsavel."
5. **Add voice recording consent prompt** in HUD before first recording per patient.
6. **Obtain legal opinion** on ANVISA SaMD classification for CID-10 suggestion feature.

### 8.3 Growth Path

7. **Phase 1 (Q2-Q3 2026):** Pediatrics on G-Hosp. Validate product-market fit.
8. **Phase 2 (Q4 2026):** Expand to other G-Hosp specialties (clinica medica, ER). Add specialty-specific templates and CID databases.
9. **Phase 3 (2027):** Multi-EMR support. Target MV Soul (800+ institutions) with a similar Chrome extension approach.
10. **Phase 4 (2027+):** API/white-label offering for EMR vendors who want to add AI documentation without building it themselves.

### 8.4 Competitive Moat

- **EMR-specific DOM automation** is hard to replicate and creates switching costs.
- **Config-driven selectors** (already built) enable rapid adaptation to EMR UI changes.
- **Physician habit formation** -- once a physician integrates Toca Ficha Dr. into their workflow, switching cost is high (back to 25-35 manual actions).

---

## Sources

### Competitors and Market Players
- [MV Sistemas - Insight Partners Portfolio](https://www.insightpartners.com/portfolio/mv-sistemas/)
- [MV SOUL - KLAS Research](https://klasresearch.com/review/mv-soul-mv-global-mostly-brazil/186071)
- [Philips Tasy AI Virtual Assistant - ABES](https://abes.org.br/en/philips-lanca-assistente-virtual-de-ia-e-colabora-com-aws-para-transformar-a-experiencia-do-emr-com-uso-de-ia/)
- [Pixeon - Hospital System](https://www.pixeon.com/en/system/hospitals/)
- [Pixeon SmartHealth - KLAS Research](https://klasresearch.com/review/pixeon-smarthealth-global-brazil-only/212509)
- [DoctorAssistant.ai](https://doctorassistant.ai/)
- [DoctorAssistant.ai - Neural Saude Review](https://neuralsaude.com.br/doctor-assistant-ia-brasileira-ai-scribes/)
- [Medgical AI](https://medgicalai.com/)
- [Robo Laura - Saude Business](https://www.saudebusiness.com/voc-informa/rob-laura-amplia-nmero-de-hospitais-atendidos-no-brasil)
- [Robo Laura - Rio Times](https://www.riotimesonline.com/brazil-news/brazil/how-brazilian-laura-startup-reduces-hospitalizations-and-mortality-and-received-us1-9-million/)
- [Pippen Chrome Extension](https://pippen.ai/blog/introducing-the-pippen-chrome-extension-your-ai-powered-physician-assistant-now-in-your-emr/)
- [PhysicianUX EMR Overlay](https://physicianux.com/emr-overlay/)
- [Diagnoss Chrome Plugin - Kwanso Case Study](https://kwanso.com/case-studies/diagnoss)

### Market Sizing
- [Brazil EMR Market Forecast 2025-2030 - Research and Markets](https://www.researchandmarkets.com/reports/5397905/brazil-electronic-medical-record-emr-market)
- [Brazil EMR Market - Knowledge Sourcing](https://www.knowledge-sourcing.com/report/brazil-emr-electronic-medical-record-market)
- [Hospital EMR Systems Market 2026-2034 - Fortune Business Insights](https://www.fortunebusinessinsights.com/hospital-emr-systems-market-115346)
- [G-Hosp / Inovadora Sistemas](https://www.inovadora.com.br/solucao/hospitais/)
- [Inovadora Sistemas - About](https://www.inovadora.com.br/sobre.html)
- [Brazil Healthcare Overview - Trade.gov](https://www.trade.gov/country-commercial-guides/brazil-healthcare)
- [Pediatric ICU Distribution in Brazil - PLOS One](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0339186)

### Pricing
- [AI Scribe Pricing Comparison 2026 - Freed](https://www.getfreed.ai/resources/cost-of-ai-scribes)
- [AI Medical Scribe Comparison - OrbDoc](https://orbdoc.com/compare/ai-medical-scribe-comparison-2025)
- [Top 7 AI Scribes 2026 - Health Orbit](https://healthorbit.ai/blog/top-7-ai-scribes-2026/)
- [Best AI Scribes 2026 - Skriber](https://skriber.com/blog/best-ai-scribes)

### Regulatory
- [CFM Resolution 2.454/2026 - Official Text (PDF)](https://sistemas.cfm.org.br/normas/arquivos/resolucoes/BR/2026/2454_2026.pdf)
- [CFM 2.454/2026 Compliance Guide - NDM Advogados](https://ndmadvogados.com.br/artigo/guia-resolucao-cfm-2-454-2026-ia-medica/)
- [CFM 2.454/2026 Analysis - Conjur](https://www.conjur.com.br/2026-mar-14/resolucao-do-cfm-trata-do-uso-de-inteligencia-artificial-na-medicina/)
- [CFM 2.454/2026 Practical Impact - Dias Teixeira](https://www.diasteixeira.com.br/post/intelig%C3%AAncia-artificial-na-medicina-o-que-muda-na-pr%C3%A1tica-com-a-resolu%C3%A7%C3%A3o-cfm-n%C2%BA-2-454-2026)
- [CFM 2.454/2026 - Mattos Filho](https://www.mattosfilho.com.br/unico/cfm-ia-medicina/)
- [ANVISA RDC 657/2022 - SaMD Classification](https://www.agilesuite.com.br/software-como-dispositivo-medico/)
- [ANVISA RDC 657/2022 - Official FAQ (PDF)](https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/2022/software-como-dispositivo-medico-perguntas-e-respostas/perguntas-respostas-rdc-657-de-2022-v1-01-09-2022.pdf)
- [LGPD in Healthcare - Portal Telemedicina](https://portaltelemedicina.com.br/lgpd-na-saude-como-garantir-a-seguranca-de-dados-dos-pacientes)
- [LGPD Consent in Healthcare - LEC](https://lec.com.br/lgpd-e-o-mito-do-consentimento-para-tratamento-dos-dados-de-saude/)
- [Medical Recording Legal Limits - Migalhas](https://www.migalhas.com.br/depeso/334139/limites-eticos-e-juridicos-das-gravacoes-em-atendimentos-medicos--uma-analise-conformada-a-lei-geral-de-protecao-de-dados)

### Trends
- [Voice Recognition in Healthcare Market - Data M Intelligence](https://www.datamintelligence.com/research-report/voice-recognition-technology-in-healthcare-documentation-market)
- [AI Voice Agents in Healthcare - Towards Healthcare](https://www.towardshealthcare.com/insights/ai-voice-agents-in-healthcare-market-sizing)
- [Clinical Documentation Improvement Market 2026 - TBRC](https://www.thebusinessresearchcompany.com/report/clinical-documentation-improvement-global-market-report)
- [Healthcare RPA - UiPath](https://www.uipath.com/solutions/industry/healthcare-automation)
- [SUS Smart Hospital Investment 2026 - CPG Click](https://en.clickpetroleoegas.com.br/sus-tera-rede-nacional-de-hospitais-e-servicos-inteligentes-com-ia-5g-cirurgias-roboticas-e-investimento-de-r-17-bilhao-a-partir-de-2026-diz-ministerio-da-saude-mhbb01/)
- [AI in Brazilian Healthcare 2025 - Intelligent CIO](https://www.intelligentcio.com/latam/2025/04/01/smart-hospitals-what-are-the-advances-of-ai-in-the-brazilian-health-system/)
- [AI Scribes Measurement - JMIR](https://medinform.jmir.org/2026/1/e89337)
