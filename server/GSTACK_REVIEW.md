# GSTACK Review — Toca Ficha Dr Extension

Date: 2026-04-26 20:06 BRT
Repo: `/Users/admin/Dev/tocafichadr-extension`
Reviewer: OpenClaw subagent manual fallback

## GStack / Claude Code attempt

Requested command:

```bash
claude -p "Load gstack. Run /review"
```

Result:

```text
zsh:1: command not found: claude
```

Claude Code/gstack is not available in the SSH environment for `admin@100.88.191.63`, so this report is a manual fallback review.

## Verdict

**Changes should not be shipped as-is if billing/cloud mode matters.**

No critical remote-code-execution or obvious credential-exfiltration issue was found in the reviewed extension files. The code has several good safety improvements: sender allowlisting in the service worker, API proxy URL origin/path restriction, Authorization header stripping/replacement, and avoiding `innerHTML` for dynamic UI data.

However, there are **two high-impact product/security-reliability findings**:

1. cloud/auth flows are pinned to a hard-coded rotating Cloudflare URL and can overwrite the service-worker-discovered API URL;
2. the free usage limit is currently disabled client-side and explicitly not enforced server-side from this repo's perspective.

## Critical findings

None found in the inspected files.

## High findings

### HIGH-1 — Popup cloud/auth flows use a hard-coded rotating Cloudflare tunnel and can overwrite discovery

Files/lines:

- `popup/popup.js:4` defines `CLOUD_URL = "https://colours-detroit-mirror-consistency.trycloudflare.com"`
- `popup/popup.js:36` sets cloud mode UI to that constant
- `popup/popup.js:94` login posts to that constant
- `popup/popup.js:137` register posts to that constant
- `popup/popup.js:180` subscription fetch uses that constant
- `popup/popup.js:341` saving cloud settings writes `apiBaseUrl: CLOUD_URL`

Why this matters:

The service worker has an auto-discovery path for the current API URL (`background/service-worker.js` uses a public gist + allowlist + TTL). The popup ignores that and keeps using a specific trycloudflare hostname. Since trycloudflare URLs rotate, login/register/subscription can fail even when the service worker already discovered a healthy URL. Worse, clicking save in cloud mode can overwrite the discovered `apiBaseUrl` with the stale constant, breaking transcription/API calls.

Recommended fix:

- Replace popup `CLOUD_URL` usage with the same source of truth as the service worker: stored `apiBaseUrl`, after forcing/awaiting discovery when cloud mode is selected.
- Prefer the stable `https://api.tocafichadr.com.br` domain if production DNS exists.
- Do not hide the actual cloud API URL unless it is guaranteed stable.
- Add a small integration/selftest that asserts popup cloud save does not write a `*.trycloudflare.com` constant unless it was freshly discovered/validated.

### HIGH-2 — Free daily usage limit is effectively disabled

Files/lines:

- `content/hud.js:673-677` checks `isUsageLimitReached()` before recording
- `content/hud.js:1085-1091` increments only local usage after success
- `content/hud.js:1123-1125` returns `false` unconditionally with TODO: "enforce limits server-side once real backend is implemented"

Why this matters:

The UI advertises a 5-note/day free tier, and subscription state is read from `/billing/subscription`, but the guard never blocks. Any non-Pro user can continue generating Whisper/backend calls indefinitely. Because the counter is also stored in `chrome.storage.local`, it can be reset by the client even if the function were changed locally.

Recommended fix:

- Enforce usage limits on the backend for transcription/formatting endpoints, keyed by authenticated user/device as appropriate.
- Make the client consume backend usage/limit state and treat local counts as display-only.
- Return a typed error from `/api/transcribe` when quota is exhausted and map that to the upgrade CTA.

## Medium / lower-priority observations

### MEDIUM — `scripts/selftest.sh` depends on `node` being on PATH, but SSH non-login shell lacks `/usr/local/bin`

Evidence:

- Initial run from SSH: all JS syntax checks failed because `node` was not found.
- `PATH` from SSH included `/usr/bin:/bin:/usr/sbin:/sbin`, while `node` and `npm` are in `/usr/local/bin`.
- Re-running with `PATH=/usr/local/bin:$PATH` made syntax checks pass.

Recommended fix:

- In `scripts/selftest.sh`, resolve Node robustly (`NODE_BIN=${NODE_BIN:-$(command -v node || true)}`) and print a clear "node not found" error, or prepend `/usr/local/bin` on macOS.
- Do not report every JS file as syntactically invalid when the runtime binary is missing.

### MEDIUM — No real `npm test` target

Evidence:

```text
> pedbot-extension@1.0.0 test
> echo "Error: no test specified" && exit 1

Error: no test specified
```

Recommended fix:

- Point `npm test` to `bash scripts/selftest.sh` or a fuller test suite.

### LOW — Public gist discovery is reasonably constrained, but still operationally fragile

The service worker correctly restricts discovered hosts to `api.tocafichadr.com.br` or `*.trycloudflare.com`. That prevents arbitrary HTTPS pivoting, but production should still prefer a stable first-party domain to avoid tunnel churn and popup/service-worker drift.

## Positive notes

- `background/service-worker.js` validates sender origin before servicing privileged messages.
- Generic fetch proxy restricts requests to configured API origin and `/api/*` path.
- Caller-supplied Authorization is stripped and replaced from extension local storage.
- Dynamic HUD UI construction largely avoids unsafe `innerHTML` for user-controlled data.
- API discovery validates HTTPS and host allowlist before writing `apiBaseUrl`.

## Test / lint status

Commands run over SSH in `/Users/admin/Dev/tocafichadr-extension`:

```bash
# Claude/gstack attempt
zsh -lc "cd /Users/admin/Dev/tocafichadr-extension && command -v claude; claude --version"
# Result: zsh:1: command not found: claude

# npm test, after ensuring npm on PATH
PATH=/usr/local/bin:$PATH npm test
# Result: FAIL — package.json test script is placeholder and exits 1.

# selftest with fixed PATH
PATH=/usr/local/bin:$PATH bash scripts/selftest.sh
# Result: PASS — JS syntax, JSON validity, CID DB, selector parity, SW message parity, and console PII grep passed.

# build package
bash scripts/build-package.sh
# Result: PASS — built tocafichadr-v2.5.3.zip, 56K, 22 files.
```

## Repository state observed

```text
?? graphify-out/
```

No push performed.
