# Toca Ficha Dr. — Roadmap

> Last updated: 2026-03-23

---

## Phase 1 — Local (Complete the Personal Tool)

**Goal:** A rock-solid, fully working tool for your own daily use at UPA Bento Goncalves.
No cloud, no billing, no auth. Just you and your OpenAI key.

**Status:** ~80% done. Core recording/SOAP/clipboard pipeline works. Remaining work is DOM
validation and workflow polish.

---

### P1.1 — Validate DOM Selectors on Live G-Hosp

The selectors in `content/selectors.json` were extracted from the original `workflow.js` code
but have not been validated against the live G-Hosp page. This is the single most important
remaining task.

**What to test (open browser DevTools on G-Hosp):**

```
1. SOAP fields
   document.querySelector('#prconsulta_prananmeneses_attributes_0_descricao')
   -- must return the textarea for field 0 (Queixa/Historico)
   -- repeat for indices 1-5

2. CID input
   document.querySelector("input[type='text'][id*='cid']:not([hidden])")
   -- must return the visible CID text input

3. Prescription link
   document.querySelector('#link_new_receitaalta')
   -- must return the "Nova Receita" link

4. Template radio buttons
   document.querySelectorAll("input[type='radio'][name='padraorec']")
   -- must include values 1080, 1081, 1082, 1083

5. Discharge link
   document.querySelector("a[href*='/altas/'][href*='edit']")
   -- must return the Alta link when a patient is open

6. Dialog container
   document.querySelector('#dialog_formularios')
   -- must exist on pages with prescription/discharge dialogs
```

**If a selector is wrong:** Update `content/selectors.json` and
`Pediatrics/data/selectors/ghosp.json` (they must stay in sync).

---

### P1.2 — Validate CID Filling

`fillCid()` in `dom-engine.js` uses 7 strategies including jQuery UI `autocompleteselect`
event simulation. This is the most fragile part.

**How to test:**
1. Open a patient chart in G-Hosp
2. In browser console: `window.TOCAFICHADR_dom.fillCid('J06.9', 'Infeccao aguda das vias aereas superiores')`
3. The CID field should show `J06.9 - Infeccao...` and the hidden CID input should have `J06.9`
4. Saving the form should persist the CID

**If it fails:** Inspect the CID input element and check which jQuery widget is attached.
The fix is usually adjusting the `autocompleteselect` event payload or updating the hidden
field selector in `selectors.json`.

---

### P1.3 — Validate the Full Finalization Workflow

Test "Finalizar Paciente" end-to-end for the first time on a real patient.

**Steps:**
1. Open patient chart
2. Record a short consultation (30 sec)
3. Confirm SOAP was pasted correctly
4. Click CID suggestion to apply it
5. Select a prescription template (e.g., "Resfr. 1")
6. Click "Finalizar Paciente"
7. Watch the sequence: save → prescription dialog → template selected → Inserir clicked → print dialog → Alta → patient list

**Known friction point:** The print dialog appears (browser-native, cannot be bypassed).
Press Enter to confirm print. This is unavoidable in a browser extension.

---

### P1.4 — Fill All 6 SOAP Fields (Optional)

Currently only field 0 (Queixa/Historico) is filled. G-Hosp has 6 wysihtml5 fields
(indices 0-5). The SOAP note from GPT has 4 sections (S, O, A, P).

**Proposed mapping:**
- Field 0 (Queixa/Historico) → Full SOAP text (current behavior, simplest)
- OR: parse SOAP sections and distribute: field 0 → SUBJETIVO, field 1 → OBJETIVO, etc.

**Recommendation:** Keep filling only field 0 for now unless G-Hosp requires all 6 fields
to save correctly. Test saving with fields 1-5 empty.

---

### P1.5 — Add More Prescription Templates

Currently 4 templates are hardcoded (IDs 1080-1083). To add more:

1. In G-Hosp, open the prescription dialog
2. Inspect the template radio buttons: `input[type='radio'][name='padraorec']`
3. Note the `value` attribute of each template
4. Edit `content/hud.js` → `TEMPLATES` array:
   ```js
   const TEMPLATES = [
     { id: '1080', label: 'Gastro 1' },
     { id: '1081', label: 'Gastro 2' },
     { id: '1083', label: 'Resfr. 1' },
     { id: '1082', label: 'Resfr. 2' },
     { id: 'XXXX', label: 'Novo Template' },  // add here
   ];
   ```

---

### P1.6 — SOAP Canonical Blocks ✅ Reviewed

The physical exam block (`OBJECTIVE_CANONICAL_BLOCK`) and plan footer (`PLAN_FOOTER_TEXT`)
in `Pediatrics/emr_automation/extension_api.py` were reviewed on 2026-03-24 and approved
as-is. They represent the standard pediatric UPA defaults and will serve as the system-wide
baseline for all users.

**Current defaults (do not change without testing on live patients):**

OBJETIVO block:
- Cabeça/Pescoço, Neurológico, Cardíaco, Respiratório, Abdome, Membros, Orofaringe, Otoscopia, SpO2

PLANO footer:
- Forneco sintomaticos.
- Oriento sinais de alarme (febre persistente, dispneia, dor abdominal intensa).
- Encaminhamento para UBS em caso de piora.
- Acompanhamento de rotina na UBS mais próxima.
- Paciente/responsável compreendeu e concordou com as orientações.

**Future work:** make these blocks configurable per user — see P2.11 below.

---

### P1.7 — Tune Custom Instructions

In the popup, the "Instrucoes para o SOAP" field sends extra instructions to GPT.

Useful additions to try:
- `"Mencione nivel de hidratacao oral. Inclua escala de dor se dor relatada."`
- `"Consulta pediatrica em UPA. Paciente sempre menor de 18 anos."`
- `"Se febre, especifique dias de febre e temperatura maxima relatada."`

---

## Phase 2 — Cloud Service (Sell to Other Pediatricians)

**Goal:** Turn Toca Ficha Dr. into a SaaS product sold to Brazilian pediatricians who use G-Hosp.
Monthly subscription, billed via Stripe, hosted in the cloud.

**Status:** Infrastructure code is complete. Needs deployment, testing, and launch.

---

### Architecture Already Built

```
Chrome Extension (pedbot-extension/)
  |- Local mode  → Flask on localhost:5050  (your machine)
  |- Cloud mode  → https://api.tocafichadr.com.br (Railway/Fly.io)

Cloud Backend (Pediatrics/)
  |- Flask API (routes.py + routes_auth.py + routes_billing.py)
  |- PostgreSQL (users, subscriptions, usage_logs, audit_trail)
  |- JWT auth with refresh tokens
  |- Stripe billing (checkout + webhooks)
  |- Docker + docker-compose.cloud.yml
  |- 14-day free trial on registration
  |- Free tier: 5 SOAP notes/day
  |- Pro tier: unlimited (Stripe subscription)
```

---

### P2.1 — Set Up Production Secrets

Create a `.env` file for the cloud deployment (based on `.env.example.cloud`):

```bash
DATABASE_URL=postgresql://user:password@host:5432/tocafichadr
JWT_SECRET=<random 64-char string>
OPENAI_API_KEY=sk-...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...   # your monthly Pro plan price ID in Stripe
```

**Stripe setup:**
1. Create account at stripe.com
2. Create a Product: "Toca Ficha Dr. Pro" → Price: R$ XX/month (recurring)
3. Copy the Price ID to `STRIPE_PRICE_ID`
4. After deployment, register the webhook endpoint at:
   `https://api.tocafichadr.com.br/billing/webhook` → events: `checkout.session.completed`,
   `customer.subscription.deleted`
5. Copy the webhook signing secret to `STRIPE_WEBHOOK_SECRET`

---

### P2.2 — Deploy to Railway (Recommended)

Railway is the easiest option for a dockerized Python + Postgres stack.

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway init

# Add Postgres plugin in Railway dashboard (one click)

# Set environment variables (paste from your .env)
railway variables set OPENAI_API_KEY=sk-... JWT_SECRET=... STRIPE_SECRET_KEY=... ...

# Deploy
cd ~/Dev/Pediatrics
railway up
```

After deploy:
1. Get your deployment URL from Railway dashboard (e.g., `tocafichadr-api.up.railway.app`)
2. Add a custom domain: `api.tocafichadr.com.br` → point DNS CNAME to Railway URL
3. Railway handles HTTPS automatically

**Alternative: Fly.io**
```bash
fly launch
fly postgres create
fly secrets set OPENAI_API_KEY=... JWT_SECRET=... ...
fly deploy
```

---

### P2.3 — Point the Extension at the Cloud

In `popup/popup.js`, `CLOUD_URL` is already set to `https://api.tocafichadr.com.br`.
Once DNS is pointed and the server is up, Cloud mode works automatically.

Test:
1. Open extension popup → select "Cloud"
2. Click "Testar" → should show "Conectado"
3. Register an account → should receive a 14-day trial
4. Record a consultation → SOAP should appear (uses your OpenAI key server-side)

---

### P2.4 — Initialize the Database

The first time the app starts on Railway, run migrations:

```bash
# One-time: create all tables
railway run python -c "
from emr_automation.database import engine
from emr_automation.models import Base
Base.metadata.create_all(engine)
print('Tables created')
"
```

Or add this to the Docker entrypoint (already in `Dockerfile.cloud`'s CMD via gunicorn —
tables are created on first request via `Base.metadata.create_all` if you add the call
to `app.py`'s factory function).

---

### P2.5 — Set the G-Hosp Selector Config in the Database

In Phase 2, selectors are served from the `selector_configs` PostgreSQL table instead of
the bundled JSON. This lets you update selectors without republishing the extension.

```bash
# After the DB is live, seed the selector config
railway run python -c "
from emr_automation.database import SessionLocal
from emr_automation.models import SelectorConfig
import json, pathlib

db = SessionLocal()
data = json.loads(pathlib.Path('data/selectors/ghosp.json').read_text())
row = SelectorConfig(emr_name='ghosp', version='1.0', selectors=data, is_active=True)
db.add(row)
db.commit()
print('Selectors seeded')
"
```

---

### P2.6 — Publish Extension to Chrome Web Store

Required to distribute to other doctors without them loading unpacked.

**Steps:**
1. Pay the one-time $5 developer registration fee at:
   `chrome.google.com/webstore/devconsole`
2. Package the extension:
   ```bash
   cd ~/Dev/pedbot-extension
   zip -r tocafichadr-v2.0.0.zip . \
     --exclude "*.git*" --exclude "*.DS_Store" \
     --exclude "*.bak" --exclude "docs/*" \
     --exclude ".superpowers/*" --exclude "PROGRESS.md" \
     --exclude "ROADMAP.md"
   ```
3. Upload to Developer Console:
   - Category: Productivity
   - Language: Portuguese (Brazil)
   - Target: Healthcare professionals
   - Screenshots: record 1280x800 screenshots of the HUD in action
   - Privacy: link to `PRIVACY_POLICY.md` hosted on your domain
4. Submit for review (typically 1-3 business days)

**Note:** Chrome Web Store will ask about microphone access. Your justification:
"A extensao precisa de acesso ao microfone para gravar a consulta medica e transcrever
via Whisper API para gerar notas SOAP automaticamente."

---

### P2.7 — Pricing Strategy

Suggested pricing for Brazilian pediatricians:

| Plan | Price | Limit | Target |
|------|-------|-------|--------|
| Free | R$0 | 5 notas/dia | Trial / hobbyist |
| Pro | R$49/mes | Ilimitado | Pediatra em plantao (primary target) |
| Clinica | R$149/mes | Ilimitado, 5 usuarios | Clinicas / grupos medicos |

**Justification for R$49/mes:**
- Your OWN OpenAI cost per shift (20 patients, 3min audio each): ~R$2–4/plantao
- The doctor's time saved: ~40min/plantao × R$100/h = R$67 saved per shift
- ROI is positive from the very first shift
- Annual = R$588 — well within medical software budget

**What the "Clinica" plan requires (future work):**
- Multi-user accounts (one admin, multiple doctor logins)
- Shared selector config per clinic
- Per-doctor usage stats in dashboard

---

### P2.8 — Beta Launch

Before public launch, get 3-5 pediatrician colleagues to test it.

**Beta onboarding checklist:**
- [ ] Send them the extension ZIP (or Chrome Web Store link once published)
- [ ] They install and switch to Cloud mode
- [ ] They register at `app.tocafichadr.com.br` (create a simple landing page)
- [ ] Walk them through first use on a real patient
- [ ] Collect feedback: which selectors break, which CIDs are wrong, SOAP quality

**Most common issue for other clinics:** Their G-Hosp URL and DOM structure may differ
from `prbentogoncalves.g-hosp.com.br`. The selector config system is built precisely for
this: add a new row to `selector_configs` table per clinic, and the extension fetches
the right one based on the domain.

---

### P2.9 — Landing Page and Marketing

You need a minimal web presence to send people to.

**Minimum viable landing page (`tocafichadr.com.br`):**
- 30-second demo video (screen recording of HUD in action)
- "De 35 acoes para 4 por paciente"
- Pricing table (Free / Pro / Clinica)
- Register / Login button
- Link to Chrome Web Store

**Where to find early customers:**
- Grupos de WhatsApp de pediatras (UPA, pronto-socorro)
- Facebook: Grupos "Pediatria no Brasil", "Medicos do SUS"
- LinkedIn: pediatras + médicos de urgência
- SPRS (Sociedade de Pediatria do Rio Grande do Sul) events
- Direct approach: outros médicos do seu plantão

**Key message:** "Eu uso isso todo dia no G-Hosp. Me poupa 40 minutos por plantão."
Personal credibility as the first user is your biggest asset.

---

### P2.11 — Per-User Customizable SOAP Canonical Blocks

Each doctor has their own preferred physical exam phrasing and plan footer. Instead of a
single hardcoded default, allow users to define their own `OBJECTIVE_CANONICAL_BLOCK` and
`PLAN_FOOTER_TEXT` in their account settings.

**Design:**
- Store per-user `soap_objective_block` and `soap_plan_footer` in the `User` model (PostgreSQL).
- The `/api/transcribe` and `/api/format-soap` routes already accept `custom_instructions` —
  extend this to also accept `objective_block` and `plan_footer` overrides from the extension.
- The extension popup gets a new "Personalizar exame físico" section (textarea for each block).
- Fall back to the system default (`OBJECTIVE_CANONICAL_BLOCK` / `PLAN_FOOTER_TEXT`) if the
  user has not set a custom value.
- Local mode: store custom blocks in `chrome.storage.sync` so they work without a cloud account.

**Why keep the defaults:** The current blocks are clinically correct for a pediatric UPA.
Most users will not need to change them. Customization is a power-user feature.

---

### P2.10 — Support and Monitoring

Once you have paying users, you need basic monitoring:

**Logging:** The `AuditTrail` model already records every `finalize_patient` action.
Use it to debug when a user reports a broken workflow.

**Monitoring (minimal):**
- UptimeRobot (free) → ping `https://api.tocafichadr.com.br/api/health` every 5 min
- Set email alert if it goes down

**User support:**
- Create a WhatsApp group for beta users
- For bugs: ask the user to send a screenshot of the browser console (F12 → Console tab)

**Rate limiting (already built in billing.py):**
- Free: 5 SOAP/day per user
- Trial: unlimited for 14 days
- Pro: unlimited

---

## Timeline Suggestion

| Week | Task |
|------|------|
| Week 1 | P1.1–P1.3: Validate all selectors on live G-Hosp, test full finalization workflow |
| Week 2 | P1.4–P1.7: Polish SOAP template, add templates, tune custom instructions |
| Week 3 | P2.1–P2.4: Deploy to Railway, set up Stripe, initialize DB, test cloud auth |
| Week 4 | P2.5–P2.6: Publish to Chrome Web Store, create landing page |
| Week 5+ | P2.7–P2.10: Beta launch with colleagues, iterate on feedback |

---

## Technical Debt / Future Improvements

- **Automated selector validation**: A script that opens G-Hosp with Playwright and confirms
  every selector in `ghosp.json` resolves to exactly one visible element. Useful when G-Hosp
  updates its UI.

- **Multi-EMR support**: The selector config system already supports multiple `emr_name` values.
  Adding `tasy`, `mvpep`, or other Brazilian hospital systems only requires a new JSON file
  and a new `host_permissions` entry in the manifest.

- **Audio quality**: Recording with MediaRecorder (WebM/Opus) is sufficient but the audio
  sometimes has echo from clinic speakers. Consider adding a `prompt` parameter to Whisper
  with medical vocabulary to improve transcription accuracy.

- **SOAP field distribution**: Currently all text goes into field 0. Splitting the SOAP into
  the correct G-Hosp fields (if the EMR uses them for billing/coding) would make the notes
  more useful for audit purposes.

- **Offline mode**: Cache the last set of selectors so the extension works even if the Flask
  backend is unreachable. The bundled `selectors.json` already provides a fallback — this
  is already implemented.

- **Per-user SOAP canonical blocks**: `OBJECTIVE_CANONICAL_BLOCK` and `PLAN_FOOTER_TEXT` in
  `extension_api.py` are reviewed and approved as system defaults (2026-03-24). Future work
  (P2.11) is to let each user override them via account settings and `chrome.storage.sync`
  for local mode.

- **Tauri desktop app**: The `Whisper scripts` repo has a Tauri desktop app skeleton that
  could replace the Flask + extension setup entirely for users who are not on G-Hosp.
  Not needed for Toca Ficha Dr.'s core use case.
