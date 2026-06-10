# CWS Submission Status — Toca Ficha Dr

> Updated: 2026-06-08

## Submission history

| Version | Submitted | Outcome | Root cause |
|---|---|---|---|
| v3.7.0 | 2026-05-18 | Rejected 2026-05-22 | Incomplete privacy policy |
| v3.8.0 | 2026-05-29 | Rejected 2026-05-31 | Privacy practices form failing (Purple Nickel / FZSL validator couldn't fetch policy page) |
| v3.8.1 | Never submitted | Skipped | Superseded by v3.9.0 |
| **v3.9.0** | **Ready** | — | Overnight QA passed (15/15); CHRA-2133 + CHRA-2166 + 14 bug fixes |

## Root cause of both rejections

The Google reviewer bot (Purple Nickel / FZSL) could not reach `tocafichadr.com.br/privacidade` —
Cloudflare was blocking the bot UA. The policy page content was fine; the form submission was failing.

**Fix shipped 2026-06-01 (CHRA-2303, PR #93):** Cloudflare rule now allows Google crawlers.
Verified: policy URL is publicly accessible to external fetchers.

**Critical:** you must re-fill the Privacy practices form in the developer dashboard on every
resubmission — even when the policy URL has not changed. The rejection flag is tied to the form
state, not the URL.

## Next steps for v3.9.0 submission (owner only — agents cannot log into CWS)

### 1. Build the package (MacBook)

```bash
cd "/Users/admin/Dev/tocafichadr-extension"
git pull origin main
npm run build
node scripts/verify-package.js --root .
# Artefact: look for tocafichadr-v3.9.0.zip in dist/ or root
```

### 2. Log into Chrome Web Store developer console

https://chrome.google.com/webstore/devconsole

### 3. Re-fill Privacy practices tab (mandatory — clears rejection flag)

Open the Toca Ficha Dr listing → **Edit** → **Privacy practices** tab.
- Privacy policy URL: `https://tocafichadr.com.br/privacidade`
- Save the tab before moving on.

### 4. Upload new package

Package tab → **Upload new package** → select `tocafichadr-v3.9.0.zip`.

### 5. Submit for review

No new screenshots required unless Google flags them. Expected review: 1–3 business days.

### 6. After Google decision

**Approved:**
- Close CHRA-1259
- Announce in Discord/Telegram
- Tag `v3.9.0` in git: `git tag v3.9.0 && git push origin v3.9.0`

**Rejected:**
- Capture the full Google rejection reason
- Open a child issue in Paperclip with the exact text
- Do NOT resubmit without addressing the flagged item

## What's in v3.9.0

Already merged to `main` via overnight QA loop (2026-06-08):

| Issue | Change |
|---|---|
| CHRA-2133 | Clerk JWT moved to `chrome.storage.session` (session-scoped, invisible to content scripts) |
| CHRA-2166 | Graceful offline handling — connectivity tracker, `Backend indisponível` banner, IndexedDB write queue with PHI allowlist |
| overnight | `datetime.utcnow()` → timezone-aware; dev port 5050→5051; duplicate `loadVoices` listener removed; unhandled `.catch()` on `sendMessage`; production Clerk domains in `web_accessible_resources`; dev domain removed from sign-in fallback; `_scrubPii` dead code removed; `_syncGhospTemplates` storage write awaited; SOAP paste guarded against patient switch; blank template grid fix; port.postMessage guarded; `getUserMedia` failure guard; 15/15 selftest checks pass |
