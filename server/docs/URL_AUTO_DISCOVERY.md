# API URL Auto-Discovery

The extension needs to reach the Mac Mini Flask backend (port 5050) from the doctor's work browser. The current public URL path goes through a **Cloudflare quick tunnel** (`*.trycloudflare.com`), which regenerates its hostname every time `cloudflared` restarts — Mac Mini reboot, network blip, launchd kickstart, etc.

This document describes how the extension stays pointed at the current URL without the user editing anything.

## Architecture

```
┌────────────────┐       POST /api/transcribe        ┌─────────────────────┐
│  G-HOSP page   │ ─────────────────────────────────▶│  cloudflared        │
│  (Chrome tab   │        ↑                          │  quick tunnel       │
│   at work)     │        │ apiBaseUrl read from     │  (URL rotates)      │
│                │        │ chrome.storage.sync      │                     │
└──────┬─────────┘                                   └──────────┬──────────┘
       │ chrome.runtime.sendMessage                              │
       ▼                                                         ▼
┌─────────────────────────────────────┐                  ┌──────────────┐
│  Extension service worker            │                  │  Mac Mini    │
│  - _maybeDiscoverApiUrl() on TTL     │                  │  Flask :5050 │
│  - retry on fetch TypeError          │                  │  (Toca Ficha Dr.     │
│  - reads apiBaseUrl from storage     │                  │   cloud API) │
└──────────────┬───────────────────────┘                  └──────┬───────┘
               │                                                 │
               │ GET /config/api-url.json (first-party)          │
               │ fallback: GET gist raw (public)                 │ tail -f
               ▼                                                 ▼
         ┌─────────────────────────────────────────────────────────────┐
         │  api.tocafichadr.com.br/config/api-url.json  (primary)      │
         │    { apiBaseUrl, updatedAt, schemaVersion }                 │
         └─────────────────────────────────────────────────────────────┘
               │                                                 │
               │ fallback                                        │
               ▼                                                 ▼
         ┌─────────────────────────────────────────────────────────────┐
         │  Public GitHub Gist  (chrislro/3abd7bec…b8e6)  (fallback)   │
         │    { apiBaseUrl, updatedAt, schemaVersion }                 │
         └──────────────────────────▲──────────────────────────────────┘
                                    │ gh gist edit
                    ┌───────────────┴────────────────────┐
                    │  Mac Mini launchd agent             │
                    │  com.tocafichadr.url-publisher           │
                    │  - WatchPaths on tunnel-error.log   │
                    │  - StartInterval 600s (safety net)  │
                    │  - ThrottleInterval 30s             │
                    └─────────────────────────────────────┘
```
┌────────────────┐       POST /api/transcribe        ┌─────────────────────┐
│  G-HOSP page   │ ─────────────────────────────────▶│  cloudflared        │
│  (Chrome tab   │        ↑                          │  quick tunnel       │
│   at work)     │        │ apiBaseUrl read from     │  (URL rotates)      │
│                │        │ chrome.storage.sync      │                     │
└──────┬─────────┘                                   └──────────┬──────────┘
       │ chrome.runtime.sendMessage                              │
       ▼                                                         ▼
┌─────────────────────────────────────┐                  ┌──────────────┐
│  Extension service worker            │                  │  Mac Mini    │
│  - _maybeDiscoverApiUrl() on TTL     │                  │  Flask :5050 │
│  - retry on fetch TypeError          │                  │  (Toca Ficha Dr.     │
│  - reads apiBaseUrl from storage     │                  │   cloud API) │
└──────────────┬───────────────────────┘                  └──────┬───────┘
               │                                                 │
               │ GET gist raw (public)                           │ tail -f
               ▼                                                 ▼
         ┌─────────────────────────────────────────────────────────────┐
         │  Public GitHub Gist  (chrislro/3abd7bec…b8e6)               │
         │    { apiBaseUrl, updatedAt, schemaVersion }                 │
         └──────────────────────────▲──────────────────────────────────┘
                                    │ gh gist edit
                    ┌───────────────┴────────────────────┐
                    │  Mac Mini launchd agent             │
                    │  com.tocafichadr.url-publisher           │
                    │  - WatchPaths on tunnel-error.log   │
                    │  - StartInterval 600s (safety net)  │
                    │  - ThrottleInterval 30s             │
                    └────────────────────────────────────┘
```

## Components

### Mac Mini — URL publisher

- **Script:** `~/bin/update-tocafichadr-url.sh`
  - Extracts the latest `https://*.trycloudflare.com` URL from `~/Dev/Pediatrics/logs/tunnel-error.log`
  - Verifies the URL is live (`/api/status` → 200) before publishing
  - Writes to state file `~/Library/Application Support/tocafichadr-url-publisher/last-url` for idempotency
  - Publishes via `gh gist edit <GIST_ID> -f tocafichadr-api-url.json <tempfile>`

- **Launchd agent:** `~/Library/LaunchAgents/com.tocafichadr.url-publisher.plist`
  - `WatchPaths`: `~/Dev/Pediatrics/logs/tunnel-error.log` — reacts within ~1s of a URL rotation
  - `StartInterval`: 600s — safety-net poll every 10 min
  - `ThrottleInterval`: 30s — minimum gap between runs
  - Logs to `~/Library/Logs/tocafichadr-url-publisher.log`

### First-party discovery endpoint (primary)

- **URL:** `https://api.tocafichadr.com.br/config/api-url.json`
- **Schema:**
  ```json
  {
    "apiBaseUrl": "https://<random>.trycloudflare.com",
    "updatedAt": "2026-04-21T00:29:48Z",
    "schemaVersion": 1
  }
  ```
- **Authentication:** None required — this is a public config endpoint.

### Public gist (fallback)

- **URL:** `https://gist.githubusercontent.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6/raw/tocafichadr-api-url.json`
- **Schema:** Same as first-party endpoint.
- **Caching:** GitHub's CDN holds the response for `max-age=300` (5 min). The extension busts this with a `?cb=<timestamp>` query string on each fetch.

### Extension service worker

- **Constants** (`background/service-worker.src.js`):
  - `API_DISCOVERY_PRIMARY_URL` — first-party config URL
  - `API_DISCOVERY_FALLBACK_URL` — gist raw URL
  - `API_DISCOVERY_TTL_MS` — 10 min

- **`_maybeDiscoverApiUrl(force)`** — TTL-gated fetch. Tries the first-party endpoint first, then falls back to the gist. When `force=false`, skips if last successful fetch was within TTL. When `force=true`, fetches unconditionally. On success, writes `apiBaseUrl` to `chrome.storage.sync` and `_apiDiscoveryAt` to `chrome.storage.local`.

- **Call sites:**
  - `chrome.runtime.onInstalled` — force=true
  - `chrome.runtime.onStartup` — force=true
  - `_handleTranscribe()` — soft TTL check before every transcribe, and force=true on network-level fetch failure with retry-once

## Recovery behavior on URL rotation

Timeline when `cloudflared` rotates URLs while the extension is idle:

1. `cloudflared` writes the new URL to `tunnel-error.log`.
2. Within ~1s, `launchd` WatchPaths fires → `update-tocafichadr-url.sh` runs.
3. Script verifies the new URL responds, then pushes to both the first-party endpoint and the gist.
4. Next transcribe attempt in the extension:
   - Soft TTL check may trigger a fetch (10-min TTL gate)
   - The primary first-party endpoint is checked first; if it fails, the gist is used as fallback
   - If not, the POST to the stale URL throws `TypeError: Failed to fetch`
   - Catch handler calls `_maybeDiscoverApiUrl(true)` — bypasses TTL and CDN
   - Single retry with the new URL → succeeds

Worst-case user experience on rotation: one slightly slower transcribe (extra network round-trip to first-party/gist + retry). No user intervention required.

## Failure modes and guardrails

| Failure | Handled by |
|---------|-----------|
| First-party endpoint temporarily unreachable | Falls back to gist; if both fail, last known URL stays in `chrome.storage.sync` |
| Gist temporarily unreachable | Primary first-party endpoint is still tried first; if both fail, last known URL stays in `chrome.storage.sync` |
| New URL published but tunnel not yet accepting traffic | Publisher verifies `/api/status` = 200 before publishing |
| Launchd fires too often when log is written in bursts | `ThrottleInterval: 30s` minimum gap between runs |
| `gh` CLI token missing / revoked on Mac Mini | Publisher exits non-zero, launchd logs the error; URL in gist goes stale; extension still tries first-party endpoint, then falls back to retry-on-failure path |
| Extension stuck on old URL in `chrome.storage.sync` | Fetch TypeError triggers force-refresh on next transcribe |
| Stale value in `chrome.storage.sync` across devices (Chrome sync propagation delay) | Each device independently runs discovery on install/startup |

## Diagnostics

Check publisher state on Mac Mini:

```bash
launchctl print gui/$(id -u)/com.tocafichadr.url-publisher | grep -E 'state|last exit|runs'
tail ~/Library/Logs/tocafichadr-url-publisher.log
cat "$HOME/Library/Application Support/tocafichadr-url-publisher/last-url"
```

Check current published URL (first-party):

```bash
curl -sL 'https://api.tocafichadr.com.br/config/api-url.json'
```

Check current published URL (gist fallback):

```bash
curl -sL 'https://gist.githubusercontent.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6/raw/tocafichadr-api-url.json'
```

Force a publisher run manually:

```bash
~/bin/update-tocafichadr-url.sh
```

Check extension's current discovered URL (in DevTools console on the G-HOSP page, with the extension loaded):

```js
chrome.storage.sync.get(['apiBaseUrl']).then(r => console.log(r.apiBaseUrl))
chrome.storage.local.get(['_apiDiscoveryAt']).then(r => console.log(new Date(r._apiDiscoveryAt)))
```

## Known limitations

- **Public gist exposes the tunnel URL to the internet.** This is acceptable because the Flask backend requires authentication for all `/api/*` endpoints; the URL itself is not a secret. Anyone probing `trycloudflare.com` subdomains could find it anyway.
- **5-min CDN cache floor** — absolute worst case for an idle extension to discover a rotated URL is 5 min (GitHub CDN) + next transcribe attempt. The retry-on-failure path usually bypasses this.
- **No authentication on the gist.** Anyone who knows the gist ID can read it. If the URL leaks publicly that's fine (see above), but if the threat model changes, move to a private channel (e.g. an authenticated Vercel Edge function).

## Future: retiring this mechanism

This whole system exists to paper over the instability of `cloudflared` quick tunnels. It becomes unnecessary when any of the following land:

- A **named Cloudflare tunnel** on a domain the user controls (`api.<domain>`) — stable URL forever, no discovery needed.
- **Tailscale Funnel** enabled on the Mac Mini with the admin-console toggle — stable `<host>.<tailnet>.ts.net` URL.
- **ISP unblocks inbound ports** so a direct Caddy + Let's Encrypt setup works.

When any of those ship, delete the launchd agent, the publisher script, the gist, and the `_maybeDiscoverApiUrl()` function. Replace `apiBaseUrl` default with the new stable URL.
