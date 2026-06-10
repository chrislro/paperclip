# Autonomous diagnostic rig

Two scripts let Claude (or any operator) inspect and probe the running
extension without asking the doctor to paste console output.

Both connect over **Chrome DevTools Protocol** to the developer Chrome
already running on `localhost:9222`. That Chrome is launched by the existing
logger-profile shortcut (the running command line is documented at the top
of `diagnose.mjs`).

## `diagnose.mjs` — one-shot snapshot

```bash
node scripts/diagnose.mjs              # full report (JSON)
node scripts/diagnose.mjs --raw        # also dump raw CDP target list
node scripts/diagnose.mjs --rx         # exercise prescription flow (probe)
node scripts/diagnose.mjs --weight     # extra weight-extraction probe
```

Captures, in a single JSON object:

- **sidepanel**: extension version, ext ID, configured `apiBaseUrl`, list of
  open G-Hosp tabs (with `active` flag), Clerk auth token shape
  (`iss`/`sub`/`azp`/`exp`/expired/seconds_until_exp), signed-in email
- **bridge**: response from `SIDEPANEL_GET_PATIENT` — proves whether the
  content-script bridge is loaded on the active G-Hosp tab and what
  `extractPatientInfo()` returns from the isolated world
- **api_ping**: live `GET /api/me/config` with the cached token — proves
  whether the backend currently accepts the user
- **sw**: confirms the service worker is reachable

Content-script globals (`window.TOCAFICHADR_dom`, etc.) live in an
**isolated world** that CDP's page-level `Runtime.evaluate` cannot see.
This script works around that by evaluating in the side-panel context
(an extension page, full visibility) and using `chrome.tabs.sendMessage`
to ping the bridge.

## `tail-console.mjs` — live stream

```bash
node scripts/tail-console.mjs                  # all relevant targets
node scripts/tail-console.mjs ghosp            # only G-Hosp tab
node scripts/tail-console.mjs sidepanel sw     # combined
node scripts/tail-console.mjs --grep simples   # filter on a pattern
```

Subscribes to `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` on each
target. Coloured per-level output with HH:MM:SS.mmm timestamps. Catches
uncaught exceptions too.

Useful workflow: run `tail-console.mjs sidepanel ghosp` in one terminal,
exercise the UI in Chrome, watch live logs without context-switching to
DevTools.

## Prerequisite

Chrome must be running with `--remote-debugging-port=9222`. The existing
developer launch already does this — verified via `lsof -nP -iTCP:9222`.

The CDP port is bound to `127.0.0.1` only. If you ever need to drive Chrome
from the Mac Mini, use SSH port forwarding (`ssh -L 9222:localhost:9222
admin@macbook-de-chris.tail606c16.ts.net`) — never expose 9222 on Tailscale
directly, since CDP grants full code-execution rights inside Chrome.
