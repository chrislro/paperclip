# Migration: PedBot → Toca Ficha Dr.

**Date:** 2026-04-21
**Commits:** `fe8d8ea`, `84aea99`, `849b13e`, `8ef6593`

This document records the full brand rename from **PedBot** to **Toca Ficha Dr.**, and the URL auto-discovery infrastructure that was added in the same session. Written for the next time someone (you, or Claude) opens this repo and wonders "wait, what used to be called PedBot?"

---

## Why the rename

The user decided the product needed a cleaner, more clinician-facing brand. "PedBot" reads as a developer/engineering name; "Toca Ficha Dr." ("press the chart, Doctor") matches the one-keystroke value prop and speaks Portuguese. The rename was also an opportunity to clean up `pedbot.com.br` references in the code — that domain is *not owned by the user*; it's held by a cybersquatter who redirects it to `pedbot.net`.

## Naming convention applied

| Context | Old | New |
|---------|-----|-----|
| Display name (UI, docs) | `PedBot` | `Toca Ficha Dr.` |
| Slug / URL segments / filenames | `pedbot` | `tocafichadr` |
| Domain (aspirational — unregistered) | `pedbot.com.br` | `tocafichadr.com.br` |
| Support email | `tocafichadr@pedbot.com.br` (garbled) | `contato@tocafichadr.com.br` |
| GitHub repo | `chrislro/pedbot-extension` | `chrislro/tocafichadr-extension` |
| Local folder | `~/Dev/pedbot-extension` | `~/Dev/tocafichadr-extension` |
| Internal message protocol | `PEDBOT_TRANSCRIBE`, `PEDBOT_HEALTH`, etc. | `TOCAFICHADR_TRANSCRIBE`, `TOCAFICHADR_HEALTH`, etc. |
| Global namespace on `window` | `window.PEDBOT_audio` | `window.TOCAFICHADR_audio` |
| DOM id for HUD root | `#pedbot-hud` | `#tocafichadr-hud` |
| chrome.storage keys | `pedbotWideMode` | `tocafichadrWideMode` |
| Gist filename | `pedbot-api-url.json` | `tocafichadr-api-url.json` |
| Mac Mini updater script | `~/bin/update-pedbot-url.sh` | `~/bin/update-tocafichadr-url.sh` |
| Mac Mini launchd label | `com.pedbot.url-publisher` | `com.tocafichadr.url-publisher` |
| Build artifact | `pedbot-v<ver>.zip` | `tocafichadr-v<ver>.zip` |

## What was NOT renamed, and why

### The `.pb-*` CSS class prefix (still lives in `styles/hud.css` + `content/hud.js`)

~200 occurrences across CSS selectors and `querySelector()` calls. The prefix is purely internal, never visible to the doctor. Renaming needs an atomic find/replace across multiple files in lock-step (one missed class → silent styling breakage). Deferred as a cosmetic cleanup; can be done in a focused commit any time.

### The `pedbot.com.br` domain (no references remain in this repo)

Fully purged from this repo. References in *other* repos (e.g. the Pediatrics repo's Caddyfile still has an `http://api.pedbot.com.br` block) were not touched because those live in a different repo and correspond to Caddy configs that will need their own migration when the backend rename happens.

### The Pediatrics repo and its backend services

`~/Dev/Pediatrics` hosts the Flask cloud API (port 5050), the cloudflared quick tunnel (`br.com.pedbot.tunnel`), and the primary launchd service (`com.pedbot.cloud-api`). Those are **live running services** with state in Postgres. Renaming them requires:

- Stopping/unloading launchd jobs
- Renaming script paths referenced inside each plist
- Possibly renaming the Postgres role `pedbot` (careful — owns tables)
- Coordinating with `Dockerfile`, `docker-compose.cloud.yml`, `start-cloud.sh`, etc.

Scope for a separate, deliberate session. Leave alone until then.

---

## What was built alongside the rename: Cloudflared URL auto-discovery

See `docs/URL_AUTO_DISCOVERY.md` for the detailed architecture. Short version:

**Problem:** The cloudflared *quick tunnel* running on the Mac Mini (manages the public URL from hospital Wi-Fi to the Mac Mini Flask backend) assigns a random `*.trycloudflare.com` hostname each time it restarts. Previously the extension had that URL hardcoded, so any restart broke transcription until the user manually updated the extension's `apiBaseUrl` in the popup.

**Fix:** Self-healing two-sided discovery.

- **Mac Mini side:** A launchd agent (`com.tocafichadr.url-publisher`) watches `~/Dev/Pediatrics/logs/tunnel-error.log` with `WatchPaths`. When cloudflared writes a new URL, the agent runs `~/bin/update-tocafichadr-url.sh`, which extracts the URL, verifies it responds with HTTP 200 on `/api/status`, and publishes it to a public GitHub gist via `gh gist edit`.
- **Extension side:** The service worker's `_maybeDiscoverApiUrl()` fetches the gist with a 10-min TTL. Called on `onInstalled`, `onStartup`, and before every `_handleTranscribe()`. If a transcribe's fetch throws `TypeError: Failed to fetch` (most common symptom of a URL rotation the extension hasn't caught up to), the catch block force-refreshes discovery and retries once, so the user sees at worst one slightly slower transcribe instead of an error.

Worst-case latency for the extension to pick up a rotated URL: up to 5 minutes (GitHub CDN's `max-age=300` on gist raw responses) — but the cache-busting query string on our fetch plus the retry-on-fail path usually bypasses that.

**Gist:** `https://gist.github.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6`
**Raw URL the extension hits:** `https://gist.githubusercontent.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6/raw/tocafichadr-api-url.json`

---

## How to retire this auto-discovery mechanism (future)

The whole gist/publisher/retry apparatus only exists because cloudflared quick tunnels have rotating URLs. Any of these would obsolete it:

1. **User registers `tocafichadr.com.br`** (currently available at registro.br for ~R$40/year) → named Cloudflare tunnel bound to `api.tocafichadr.com.br` → Mac Mini :5050. Stable URL forever, HTTPS included, no rotation. **Recommended path.**
2. Tailscale Funnel enabled in admin console for the Mac Mini → stable `mac-mini-de-christian.<tailnet>.ts.net` URL. Didn't work in this session because the CLI reports success but public DNS doesn't get published (admin-console toggle probably needed).
3. ISP unblocks inbound ports on the home network → direct Caddy + Let's Encrypt on the Mac Mini's public IP. Not realistic in Brazilian residential ISPs.

When any of those lands:

1. Delete the launchd agent: `launchctl bootout gui/$(id -u)/com.tocafichadr.url-publisher`
2. `rm ~/Library/LaunchAgents/com.tocafichadr.url-publisher.plist ~/bin/update-tocafichadr-url.sh`
3. Delete the gist: `gh gist delete 3abd7bec1b371681c4ab346bd642b8e6`
4. In `background/service-worker.js`: remove `API_DISCOVERY_URL`, `API_DISCOVERY_TTL_MS`, `_maybeDiscoverApiUrl()`, the `onStartup` listener, and the retry-on-fail block in `_handleTranscribe`. Hardcode the stable URL into the `apiBaseUrl` default.
5. In `manifest.json`: remove `https://gist.githubusercontent.com/chrislro/*` and `https://*.trycloudflare.com/*` from `host_permissions`.

---

## Does the extension use the cloud backend?

**Yes.** The request path from the doctor's work browser:

```
Chrome tab on G-HOSP (hospital Wi-Fi)
  → extension HUD "Gravar Consulta" button
  → content/hud.js → chrome.runtime.sendMessage({ type: 'TOCAFICHADR_TRANSCRIBE', ... })
  → background/service-worker.js → POST {apiBaseUrl}/api/transcribe
  → cloudflared quick tunnel (trycloudflare.com)
  → Mac Mini Flask on :5050  ← THIS is the Toca Ficha Dr. cloud backend
  → PostgreSQL `pedbot` DB (auth, billing, audit, usage limits)
  → emr_automation/extension_api.py (Whisper + GPT SOAP + CID pipeline)
  → JSON response back to the extension
```

The Mac Mini Flask app *is* the cloud backend. It's self-hosted (not AWS/GCP), but architecturally it's a multi-user cloud service: Stripe billing, PostgreSQL, JWT auth, LGPD audit log. The `audio-to-note-saas` project (the user's dev friend's separate product) is NOT in this path — it's a different product in `~/Dev/audio-to-note-saas/`.

If the Mac Mini is on the same LAN, you *could* set `apiBaseUrl` to `http://127.0.0.1:5050` for direct local mode (faster, no tunnel hop). The auto-discovery will overwrite that on the next transcribe though — a knob to add if you want "sticky local mode at home" behavior.

---

## Commits in this migration

| Commit | Scope |
|--------|-------|
| `fe8d8ea` | Add auto-discovery: gist polling, TTL, retry-on-fail |
| `84aea99` | Rename `PedBot` → `Toca Ficha Dr.` across 38 files (manifest, popup, HUD, docs, landing, scripts) |
| `849b13e` | Rename `pedbot.com.br` → `tocafichadr.com.br`, normalize support email |
| `8ef6593` | Rename leftover filename: `pedbot-automation-platform-design.md` → `tocafichadr-automation-platform-design.md` |
