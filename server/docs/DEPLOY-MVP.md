# Toca Ficha Dr. — MVP Deployment & Test Checklist

> Last updated: 2026-05-08
> Backend: `backend/` in this repo
> Extension: this repo root
> Extension version: 3.4.0

## Current State (2026-04-16)

**Cloudflare quick-tunnel is LIVE.** Flask + cloudflared both managed by launchd on Mac Mini. Extension points to HTTPS tunnel URL. Full record→discharge→redirect flow validated on real patients.

| Service | launchd label | Status |
|---------|---------------|--------|
| Flask API (port 5050) | `com.tocafichadr.cloud-api` | ✅ Running, survives reboot |
| Cloudflare Tunnel | `br.com.tocafichadr.tunnel` | ✅ Running, survives reboot |

**⚠️ Known limitation:** quick-tunnel URL (`*.trycloudflare.com`) changes on cloudflared restart. After Mac Mini reboot: check `backend/logs/tunnel-error.log` for new URL → update extension API base URL → reload extension.

**Fix:** buy a domain → set up named Cloudflare tunnel (permanent URL). See "Part 1A — Named Tunnel Upgrade" below.

---

Path of least resistance to ship MVP: **Cloudflare Tunnel → Mac Mini** (Flask already runs there; adds HTTPS + public hostname without new infra). Migrate to Fly.io GRU region once >50 concurrent doctors.

Alternative hosting paths (for reference, not used in MVP):

| Option | Pros | Cons |
|--------|------|------|
| Cloudflare Tunnel → Mac Mini | Zero cost, Postgres on-prem, lowest LATAM latency from home | Mac Mini is SPOF |
| Railway ($5–20/mo) | One-command deploy, managed Postgres, free TLS | US-East egress ~180ms to Brazil |
| Fly.io GRU region | São Paulo → <30ms to Bento Gonçalves | More ops (volumes, secrets) |

---

## Part 1 — Cloudflare Tunnel Deployment (Mac Mini)

### Prerequisites

- [ ] Domain `tocafichadr.com.br` with Cloudflare as DNS provider
- [ ] Mac Mini reachable via Tailscale at `100.97.14.32` (already live)
- [ ] Flask backend runs locally at `http://127.0.0.1:5050` (already live)
- [ ] `.env.production` file prepared with `OPENAI_API_KEY`, `JWT_SECRET`, `DATABASE_URL`, Stripe keys

### Step 1 — Install cloudflared on Mac Mini

```bash
ssh christianoliveira@100.97.14.32
brew install cloudflared
cloudflared --version
```

### Step 2 — Authenticate and create tunnel

```bash
cloudflared tunnel login               # opens browser, pick tocafichadr.com.br zone
cloudflared tunnel create tocafichadr-api   # prints a UUID — save it
```

Credentials file lands at `~/.cloudflared/<UUID>.json`.

### Step 3 — Configure routing

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID-from-step-2>
credentials-file: /Users/christianoliveira/.cloudflared/<UUID>.json

ingress:
  - hostname: api.tocafichadr.com.br
    service: http://localhost:5050
    originRequest:
      connectTimeout: 30s
      noTLSVerify: false
  - service: http_status:404
```

### Step 4 — Create DNS record

```bash
cloudflared tunnel route dns tocafichadr-api api.tocafichadr.com.br
```

Verify in Cloudflare dashboard: `api.tocafichadr.com.br` → CNAME → `<UUID>.cfargotunnel.com` (proxied).

### Step 5 — Register as launchd service

Create `~/Library/LaunchAgents/com.tocafichadr.cloudflared.plist` (follow the pattern used by `ai.paperclip` and Parser services). Key options:

```xml
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>/Users/christianoliveira/.cloudflared/config.yml</string>
    <string>run</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/Users/christianoliveira/.cloudflared/tunnel.log</string>
<key>StandardErrorPath</key><string>/Users/christianoliveira/.cloudflared/tunnel.err</string>
```

Load:
```bash
launchctl load ~/Library/LaunchAgents/com.tocafichadr.cloudflared.plist
launchctl list | grep cloudflared
```

### Step 6 — Smoke test

From any laptop (off-Tailscale):
```bash
curl -v https://api.tocafichadr.com.br/api/health
# expect: 200 OK, JSON body with {"status": "ok"}
```

### Step 7 — Flip extension to production URL

Edit `popup/popup.js:4`:
```js
// BEFORE
const CLOUD_URL = "http://100.97.14.32:5050";  // Mac Mini via Tailscale
// AFTER
const CLOUD_URL = "https://api.tocafichadr.com.br";
```

Also verify `manifest.json` `host_permissions` contains `https://api.tocafichadr.com.br/*` (already present).

### Step 8 — Tighten CORS

On Mac Mini, edit `.env.production`:
```
CORS_ORIGINS=chrome-extension://<EXTENSION-ID-FROM-WEB-STORE>
```

Restart Flask. Verify browser DevTools shows no CORS errors when using the extension.

### Step 9 — Uptime monitoring

- UptimeRobot free tier: ping `https://api.tocafichadr.com.br/api/health` every 5 min, alert to email + WhatsApp
- Set a Cloudflare Worker alert for 5xx spikes

### Rollback

If the tunnel misbehaves, flip extension `CLOUD_URL` back to Tailscale IP. The Tailscale route stays live as a fallback.

---

## Part 2 — MVP Test Checklist

Run through end-to-end before Chrome Web Store submission. Each item is PASS/FAIL.

### A. Backend reachability

- [ ] 1. `curl https://api.tocafichadr.com.br/api/health` → 200 OK
- [ ] 2. `curl https://api.tocafichadr.com.br/api/selectors` → JSON with `emr: ghosp`
- [ ] 3. Browser DevTools Network tab shows HTTPS calls, no mixed-content warnings
- [ ] 4. CORS header `Access-Control-Allow-Origin` matches extension ID (not `*`)

### B. Extension load + HUD

- [ ] 5. Load unpacked extension — no errors at `chrome://extensions/?errors=<id>`
- [ ] 6. HUD appears on `prbentogoncalves.g-hosp.com.br` patient page
- [ ] 7. HUD does NOT appear on non-G-Hosp pages
- [ ] 8. Connection indicator in HUD shows green (backend reachable)

### C. Audio → SOAP pipeline

- [ ] 9. Record 10s clip with clear Portuguese speech → SOAP fields populated within 30s
- [ ] 10. Check Flask log for `transcribe_audio: audio size X.X KB` — should be < 500 KB for 10s
- [ ] 11. Whisper latency `transcribe_audio: whisper took X.XXs` < 8s — if >15s, investigate
- [ ] 12. SOAP+CID parallel step < 5s
- [ ] 13. No "Failed to fetch" errors in DevTools console

### D. CID autofill

- [ ] 14. AI-suggested CID → click → `#intcid_cid_id` filled with code, `#cid_descricao` with name
- [ ] 15. Save consultation → reopen → CID persists (proves hidden field got the correct ID)
- [ ] 16. Manual CID search (type code) also works

### E. Prescription — legacy template flow (Utilizar Padrões)

- [ ] 17. Pick Gastro 1 → dialog opens → `#padroes` list appears → radio selected → Inserir fires
- [ ] 18. Prescription editor shows template content correctly
- [ ] 19. Print button fires G-Hosp print dialog

### F. Prescription — Simples modifiable flow

- [ ] 20. Edit a template in popup (e.g. "Amoxicilina") → save
- [ ] 21. HUD button reflects new template name instantly (chrome.storage.onChanged)
- [ ] 22. Click HUD button → editor opens with title="Receita" + body=template text
- [ ] 23. Doctor edits body in G-Hosp editor → "Finalizar Receita" → saves + prints
- [ ] 24. DevTools console shows `[Toca Ficha Dr.] simples prescription ready for review: <name>`

### G. Discharge ("Alta do Paciente")

- [ ] 25. "Alta do Paciente" button → Adicionar link clicked → form opens
- [ ] 26. Referral select set to "Sem encaminhamento" (value 100)
- [ ] 27. Gravar fires → `#botao_gravar_alta` disappears within 4s
- [ ] 28. If G-Hosp renders a validation error → HUD shows red status and suggests manual fix (no 4s hang)

### H. Alta e voltar (discharge + return only)

- [ ] 29. Click **Alta e voltar** only after SOAP/prescription work is complete
- [ ] 30. Confirm prompt appears before discharge submit
- [ ] 31. Confirm → discharge submits and page returns to the patient list in < 30s
- [ ] 32. Cancel confirmation → no discharge submit occurs
- [ ] 33. Force a discharge validation failure → UI shows a red actionable error and does not report success
- [ ] 34. `finalize_patient` audit log entry appears in Flask `/api/audit`

### I. Baú Médico

- [ ] 35. Click Baú Médico → opens `/ver_fichas?intern_id=<id>&id=5` in new tab

### J. State hygiene / multi-patient

- [ ] 36. Process 3 patients in sequence without refresh → no stale `state.selectedTemplate` between patients
- [ ] 37. Active template button indicator resets after successful finalize
- [ ] 38. Switching patients auto-clears SOAP fields (if `autoClearSoap` enabled)

### K. Session & recovery

- [ ] 39. Idle >4h → G-Hosp session expires → next action triggers redirect to login → after re-auth extension still works
- [ ] 40. Backend restart mid-session → extension reconnects automatically on next call (no reload needed)

### L. Static / security review

- [ ] 41. CSP — no inline script violations (check `chrome://extensions/?errors=<id>`)
- [ ] 42. Permissions minimal: activeTab, storage, scripting, clipboardWrite (already verified ✅)
- [ ] 43. `manifest.json` no longer contains Tailscale IP (already removed ✅)
- [ ] 44. `popup.js` CLOUD_URL points to `https://api.tocafichadr.com.br` (Step 7 above)
- [ ] 45. No `console.log` with PII (patient names, CPF) in production build

### M. Performance / ergonomics

- [ ] 46. HUD keyboard-accessible (tab order sane)
- [ ] 47. HUD render <50ms on patient-switch (no visible flash)
- [ ] 48. Extension memory footprint < 50MB after 1h session (check Task Manager)

### N. Real-world smoke test

- [ ] 49. Process one full live patient at UPA Bento Gonçalves end-to-end with stopwatch — target: < 60s from audio start to patient list
- [ ] 50. Error rate < 5% across first 10 real patients (manual fallback if any step fails)

---

## What Claude can verify autonomously (no live session needed)

| Item | Method |
|------|--------|
| #1, #2, #4 | `curl` from Claude's shell once tunnel is live |
| #41, #42, #43, #44 | Static file inspection |
| #45 | grep for `console.log.*(patient_name|cpf|nome)` |
| JS syntax sanity | `node --check` on all content scripts |
| JSON sanity | `python3 -m json.tool manifest.json` |

Everything else (#3, #5–40, #46–50) requires **live Chrome + logged-in G-Hosp session + microphone** — you must run those manually.

---

## Part 1A — Named Tunnel Upgrade (when domain is purchased)

The quick-tunnel (`*.trycloudflare.com`) URL changes on every cloudflared restart. Once you've chosen a product name and bought a domain, upgrade to a named tunnel for a permanent URL.

### Prerequisites

- [ ] Domain purchased (e.g. `tocafichadr.com.br` or whatever name you choose)
- [ ] Domain added to Cloudflare as DNS zone (change nameservers at registrar → Cloudflare)

### Steps

```bash
ssh christianoliveira@100.97.14.32

# 1. Authenticate cloudflared with your Cloudflare account
cloudflared tunnel login  # opens browser — pick your domain's zone

# 2. Create a named tunnel
cloudflared tunnel create tocafichadr-api
# Prints a UUID. Credentials saved at ~/.cloudflared/<UUID>.json

# 3. Configure routing
cat > ~/.cloudflared/config.yml << EOF
tunnel: <UUID-from-step-2>
credentials-file: /Users/christianoliveira/.cloudflared/<UUID>.json

ingress:
  - hostname: api.tocafichadr.com.br
    service: http://localhost:5050
  - service: http_status:404
EOF

# 4. Create DNS record
cloudflared tunnel route dns tocafichadr-api api.tocafichadr.com.br
# Verify in Cloudflare dashboard: CNAME → <UUID>.cfargotunnel.com (proxied)

# 5. Update launchd plist to use named tunnel
cat > ~/bin/start-tocafichadr-tunnel.sh << 'SCRIPT'
#!/bin/bash
exec /usr/local/bin/cloudflared tunnel --config /Users/christianoliveira/.cloudflared/config.yml run
SCRIPT

# 6. Restart tunnel service
launchctl unload ~/Library/LaunchAgents/br.com.tocafichadr.tunnel.plist
launchctl load ~/Library/LaunchAgents/br.com.tocafichadr.tunnel.plist

# 7. Verify
curl https://api.tocafichadr.com.br/api/health
```

### Then update the extension

1. `popup/popup.js:4` — `CLOUD_URL = "https://api.tocafichadr.com.br"`
2. `manifest.json` — replace `https://*.trycloudflare.com/*` with `https://api.tocafichadr.com.br/*` in `host_permissions`
3. Bump version, commit, push
4. Reload extension

### Then tighten security

- Set `CORS_ORIGINS=chrome-extension://<your-extension-id>` in Mac Mini `.env` (get the ID from Chrome Web Store after publishing)
- Restart Flask: `launchctl bootout gui/$(id -u)/com.pedbot.cloud-api && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pedbot.cloud-api.plist`

---

## Post-MVP hardening (not blocking)

- Bypass jQuery UI autocomplete for `matmed_nome` and CID — direct XHR to `/receitas/autocomplete_matmed_nome?term=X` with CSRF. Invest only if >5% of `finalize_patient` audits are followed by retry within 60s.
- Sentry integration for content-script errors
- Chrome Web Store listing copy + screenshots
- LGPD compliance review (patient data never leaves Flask backend — confirm no third-party telemetry)
