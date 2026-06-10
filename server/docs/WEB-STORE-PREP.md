# Chrome Web Store Submission Prep

> Updated: 2026-05-08
> Package: `tocafichadr-v3.4.0.zip` (production build via `scripts/build-package.sh`)
> **⚠️ Named tunnel strongly recommended before submission** — current `*.trycloudflare.com` URL is live but rotates on cloudflared restart. `api.tocafichadr.com.br` is the intended stable endpoint.

---

## Submission checklist

### Before clicking submit

- [x] **Permanent backend URL** (named Cloudflare tunnel with `api.tocafichadr.com.br`)
  - ✅ Named tunnel `tocafichadr-api` running on Mac Mini
  - ✅ DNS: `api.tocafichadr.com.br` → Cloudflare edge → tunnel → localhost:5050
  - ✅ `curl https://api.tocafichadr.com.br/api/health` returns `{"status":"ok"}`
- [ ] Chrome Web Store Developer account ($5 one-time fee at https://chrome.google.com/webstore/devconsole)
- [ ] Screenshots — 5 required (see plan below)
- [x] Listing copy — `store/description.txt` updated and reconciled
- [ ] Privacy policy URL live at a public URL (see reconciliation below)
- [ ] Icons ready — `icons/icon128.png` (required), `icons/icon48.png`, `icons/icon16.png` ✅ all present

### Product listing fields

| Field | Source | Status |
|-------|--------|--------|
| Name | `manifest.json:name` | `Toca Ficha Dr. — EMR Automation` ✅ current product name |
| Short description (132 char) | `store/description.txt` line 2 | ✅ ready |
| Detailed description | `store/description.txt` lines 6-49 | ⚠️ reconcile with final name + pricing |
| Category | Manual selection | Productivity (recommended) |
| Language | Primary: pt-BR | ✅ ready |
| Privacy policy URL | `https://tocafichadr.com.br/privacidade` | ✅ live |
| Production manifest | `manifest.prod.json` | ✅ created, strips all dev hosts |
| Production package | `tocafichadr-v3.4.0.zip --prod` | ✅ 1.8MB, 34 files |
| Support email | `store/description.txt` | `contato@tocafichadr.com.br` ✅ live domain |

---

## Screenshot plan (5 required, 1280x800 or 640x400)

**Rule for each:** show real value in 3 seconds, pt-BR text only, no real patient data (use demo/dummy).

1. **Side panel open on G-Hosp patient page** — shows the extension is live, clean UI, green connection indicator, "Gravar" button visible. Hero shot.
2. **Voice recording in progress** — red mic icon + timer running. Shows the core feature.
3. **SOAP note generated and ready to insert** — side panel showing the formatted SOAP with CID suggestion. Shows the output.
4. **Prescription template buttons** — shows the prescription template grid (Alergia, Bronquite, etc.). Shows workflow depth.
5. **"Alta e voltar" confirmation** — shows the discharge confirmation step. Shows safety UX.

**Tool:** Chrome DevTools → Responsive Mode → 1280x800, or macOS screenshot (Cmd+Shift+4 → Space) at actual size. Crop tightly, no desktop chrome.

**How to take them:**
1. Open G-Hosp in Chrome at `https://prbentogoncalves.g-hosp.com.br`
2. Open the Toca Ficha Dr. side panel (click the extension icon)
3. For each scene above, press Cmd+Shift+4 then Space, click the Chrome window
4. Open Preview, crop to 1280×800 if needed
5. Blur any real patient names/CPF with a solid rectangle

**Demo patient:** use a fake intern_id in G-Hosp's test mode, or blur real data with solid rectangles. Never submit screenshots with real CPF, names, or medical info.

---

## Listing copy — reconciliation tasks (after product rename)

`store/description.txt` was reconciled on 2026-05-08:
- ✅ "Toca Ficha Dr." kept as product name
- ✅ `tocafichadr.com.br` as domain
- ✅ `contato@tocafichadr.com.br` as support email
- ✅ "OpenAI Whisper" kept
- ✅ "G-Hosp / G-UPA" kept
- ✅ Pricing: R$49/mo Pro — current plan
- ✅ "painel flutuante" → "painel lateral" (reflects v3.4 side panel)
- ✅ "Finalizar Paciente" → "Alta e voltar"

---

## Privacy policy reconciliation

Current `PRIVACY_POLICY.md` claims vs reality (as of 2026-04-16):

| Claim | Reality | Action |
|-------|---------|--------|
| "servidores seguros no Brasil" | Mac Mini in Bento Gonçalves RS | ✅ Accurate |
| "trilha de auditoria... tipo de ação" logged | SQLite audit.db on Mac Mini | ✅ Accurate |
| "O áudio... descartado imediatamente após transcrição" | Flask receives → BytesIO → forwards to OpenAI → never touches disk | ✅ Verified — no `open(...,'wb')` for audio in backend code |
| "criptografia em trânsito" | TLS via Cloudflare + Tailscale | ✅ Accurate |
| "em repouso" | FileVault not confirmed on Mac Mini | ⚠️ Removed from `store/description.txt` |
| Support email `contato@tocafichadr.com.br` | Domain owned and live | ✅ HostGator MX in place |

### Verify audio never touches disk

```bash
ssh christianoliveira@100.97.14.32 'grep -rn "open.*wb\|write.*audio\|save_audio" ~/Dev/tocafichadr-extension/backend/emr_automation/ | grep -v test'
```

Expected result: no matches (audio stays in BytesIO in memory).

---

## Policy compliance — Chrome Web Store program policies

Extension must comply with these to avoid rejection:

- ✅ **Single purpose** — EMR automation in G-Hosp. Clear + narrow.
- ✅ **Minimal permissions** — `activeTab`, `storage`, `cookies`, `scripting`, `clipboardWrite`, `sidePanel`, `offscreen`. All justified.
- ✅ **Host permissions narrow** — `*.g-hosp.com.br` + backend URLs. Not `<all_urls>`.
- ⚠️ **Remote code** — we don't ship/eval remote JS (good). But the extension fetches config from Flask (`/api/selectors`). Document this as "config data, not executable code" in Web Store review notes.
- ✅ **Data use disclosures** — ready for Web Store "Privacy practices" form:
  - Authentication info: **YES** (Clerk OAuth + JWT session)
  - Personal communications: **NO**
  - Financial info: **NO** (Stripe handles payment, extension never sees card data)
  - Health info: **NO** — extension does not store PHI. Audio is forwarded to OpenAI for transcription and discarded immediately. SOAP/CID content is injected into the EMR by the doctor manually.
  - User activity: **Minimal** (audit log = action type + duration, no clinical content)
  - **Free-text explanation:** "Esta extensão não armazena dados de saúde nem áudio. O áudio é processado em memória e imediatamente descartado. As notas SOAP são inseridas manualmente pelo médico no prontuário eletrônico. Ver política completa em https://tocafichadr.com.br/privacidade"

### Red flags for reviewers

- **Medical context + audio recording** — reviewers are cautious. ✅ Preempted in description: "O áudio é processado em memória e descartado imediatamente após a transcrição."
- **CORS and Private Network Access** — ✅ fixed via service-worker proxy. No private network access needed.
- **Hardcoded backend URL** — ✅ `https://api.tocafichadr.com.br` is a first-party stable domain, not a rotating tunnel.

---

## Timeline — Current Status (2026-05-08)

| Step | Status | Owner |
|------|--------|-------|
| Domain + Cloudflare zone | ✅ Done | User |
| Named tunnel setup | ✅ Done | Claude |
| Extension rebuild with prod manifest | ✅ Done | Claude |
| Listing copy reconciliation | ✅ Done | Claude |
| Privacy policy reconciliation | ✅ Done | Claude |
| **Screenshots** | ⏳ Pending | User |
| **Web Store Dev Console account** | ⏳ Pending | User ($5 fee) |
| **Fill form + submit** | ⏳ Pending | User |
| **Google review** | ⏳ Pending | Google (1-3 business days) |

**What's left for you:**
1. Pay the $5 Chrome Web Store developer fee at https://chrome.google.com/webstore/devconsole
2. Take 5 screenshots (1280×800) following the plan above
3. Upload `tocafichadr-v3.4.0.zip` and fill the form
4. Submit and wait
