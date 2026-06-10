---
phase: 005-production-clerk-migration
status: complete
opened: 2026-05-11
closed: 2026-05-11
elapsed: ~6 hours single-day session
manifest_version_at_open: 3.6.0
manifest_version_at_close: 3.7.0
---

# Phase 005 — Production Clerk Migration

## Goal

Unblock doctor sign-in by promoting Clerk from dev tier
(`working-chow-0.accounts.dev` instance) to production tier on a custom
domain (`clerk.tocafichadr.com.br`). Dev tier was rejecting sign-in
flows from chrome-extension origins with
`{"errors":[{"code":"invalid_url_scheme","message":"Invalid URL scheme"}]}`
because Clerk's shared OAuth callback infrastructure at
`clerk.shared.lcl.dev` hardcodes `http`/`https` scheme validation and
the @clerk/chrome-extension SDK inserts `chrome-extension://EXTENSION_ID/...`
into the OAuth `state` parameter. No client-side SDK option can
override that validator — only a different (production-tier) Clerk
instance with its own configurable OAuth callback at
`clerk.tocafichadr.com.br/v1/oauth_callback` resolves it.

## What shipped

### Infrastructure (one-time, no code)
- **Cloudflare DNS** — Five DNS-only CNAMEs added to
  `tocafichadr.com.br` zone (`7078e1d65b9d72541dd1b5bff2c8705d`) via
  direct Cloudflare REST API (`64e64d8238b6…` token):
  - `accounts → accounts.clerk.services`
  - `clerk → frontend-api.clerk.services`
  - `clk._domainkey → dkim1.k46pqd306nmc.clerk.services`
  - `clk2._domainkey → dkim2.k46pqd306nmc.clerk.services`
  - `clkmail → mail.k46pqd306nmc.clerk.services`
  All five proxied=false (gray cloud) — Clerk requires direct TLS
  handshake to its edge. Verified end-to-end via Clerk's dashboard
  "Verify" wizard within ~30 sec.
- **Clerk dashboard** — Production instance created on
  `tocafichadr.com.br` (root). Native API toggle enabled (REQUIRED
  for `@clerk/chrome-extension/background` SDK). SSL certs issued by
  Clerk for both Frontend API (`clerk.tocafichadr.com.br`) and
  Account Portal (`accounts.tocafichadr.com.br`). Apple/Google OAuth
  setup deferred (D11 — email/magic-link suffices for this user base).
- **Mac Mini `com.tocafichadr.cloud-api.plist`** — `CLERK_SECRET_KEY`
  swapped `sk_test_oJF3yBWz6LOzFAm…` → `sk_live_r0AKky4hubfIC8m8…`.
  `CLERK_AUTHORIZED_PARTIES` set to empty string (REQUIRED per D10).
  Flask reloaded via `launchctl bootout` + `bootstrap` (kickstart -k
  alone does NOT reload `EnvironmentVariables` from disk).
- **Production Postgres** — Backfilled `users.id=2` with
  `clerk_user_id='user_3DaHlIqMQJfuDcDrTqDZx1Cz29b'`,
  `email='christianlro@me.com'` + default `user_configs` row.

### Code (committed to main)

| Commit | What |
|---|---|
| `adf047a` | atestado: ship DOM snapshot on print_not_found + loosen text match (separate bug, same session) |
| `4f747cf` | diag(auth): clerk-tap.js content script on Clerk hosted UI tab |
| `1839aa2` | diag(auth): widen `host_permissions` to `*.accounts.dev/*` so clerk-tap can attach |
| `82cc1e4` | feat(auth): migrate to production Clerk — popup pk_live + manifest CSP/host_perms + plist sk_live + DNS verified |
| `9b9a353` | fix(auth): make `CLERK_AUTHORIZED_PARTIES` opt-in (empty → skip azp check) |
| `1a07985` | fix(auth): SW publishable key also needs `pk_live_` (missed in 82cc1e4) |
| `baccc04` | fix(auth): SW Clerk client needs `syncHost` too, matching popup setup |
| `9d7c1f7` | fix(auth): SW `createClerkClient` needs `background: true` (Clerk docs) |
| `6c33002` | diag(auth): SW telemetry tap (`_swDebugLog`) for `clerk.session` state on `getToken` |
| `0bc4c4b` | diag(auth): fix SW DIAG payload shape (top-level fields, not nested under `payload`) |
| `6c32944` | fix(auth): SW reads `chrome.storage.local.authToken` as fallback for JWT (workaround for SDK cross-context session-sharing limitation) |
| `a551ea9` | fix(auth): document azp behavior + log azp/iss/sub on rejection for future diagnosis |

### Atestado fix
Separate G-Hosp DOM drift — `_findPrintSemCidLink()` text regex relaxed
from `/imprimir\s+sem\s+cid/i` to two-stage: loose `/imprim/i` inside
`#show_atestado_alta`, falling through to href-pattern matching when
the container is missing. Worked on first retry (`adf047a`). Also
added `console.warn` DOM snapshot before `_err()` so future
occurrences ship diagnostic context to Mac Mini.

## Lessons baked

1. **`@clerk/chrome-extension/background` mints tokens with NO `azp`
   claim.** Therefore `CLERK_AUTHORIZED_PARTIES` MUST be empty in the
   Flask environment. Setting it (with any non-empty list) makes the
   Clerk Python SDK reject every token with
   `TOKEN_INVALID_AUTHORIZED_PARTIES`. Verified empirically by minting
   JWTs via Clerk admin API + curling backend with allowlist empty vs
   full. Captured in auth.py docstring + permanent diagnostic.
2. **SDK cross-context session-sharing is unreliable on prod tier.**
   `clerk.session` stays null in the SW even after Native API enabled
   + `background: true` + `syncHost` set + same `pk_live_` as popup.
   Workaround: popup writes `chrome.storage.local.authToken` on each
   `_renderAuthState` (already did this) + periodic
   `setInterval(_refreshStoredAuthToken, 30000)` to mirror fresh
   tokens. SW reads from storage as fallback when its own SDK call
   returns null. Same pattern v2.6.10 used pre-phase-002.
3. **Telemetry beats patches when chains compound.** Five "obvious"
   fixes (with-evidence per layer) shipped before the storage-fallback
   workaround landed. The single highest-leverage commit was
   `6c33002` (SW DIAG) + `a551ea9` (auth.py azp log). After those,
   every subsequent rejection named its claim mismatch by row.
4. **`launchctl kickstart -k` does NOT reload `EnvironmentVariables`
   from the plist on disk.** Only `launchctl bootout` +
   `launchctl bootstrap` re-reads the env block. Same lesson as
   2026-04-28 Paperclip/Caddy.
5. **Chrome MV3 SWs don't restart on `chrome://extensions` "Reload"
   when there's an active side-panel/popup/content-script connection
   keeping the runtime alive.** Toggle the extension OFF then ON for
   guaranteed SW kill.
6. **Dev-tier OAuth + chrome-extension scheme = fundamental
   incompatibility.** Clerk dev tier routes ALL OAuth callbacks through
   shared `clerk.shared.lcl.dev/v1/oauth_callback` which hardcodes
   http/https validation. No SDK config can override. Production
   tier (custom domain) is the only path. Saved in memory file
   `project_clerk_dev_tier_oauth_chrome_extension_incompatibility.md`.

## Verification
- Mint JWT via Clerk admin API → curl `https://api.tocafichadr.com.br/api/me/config`
  with `Authorization: Bearer <jwt>` → HTTP 200.
- SW DIAG log shows `getToken: ok via storage fallback {tokenLen:748}`
  consistently after popup-side _refreshStoredAuthToken interval is
  running.
- 17/17 backend `test_auth.py` cases pass (Mini venv).
- `scripts/selftest.sh` remained 10/10 green throughout.
- All commits on `origin/main`. Atomic, each individually verifiable.

## Open follow-ups (non-blocking)

- **Webhook** (D12) — currently new doctors require manual SQL insert.
  Either configure prod Clerk webhook or implement JIT user
  provisioning in Flask auth middleware.
- **Cleanup pass** — Commits `7870053`, `4f747cf`, `1839aa2`,
  `6c33002`, `0bc4c4b`, `6c32944` added diagnostic infrastructure
  that's no longer essential. Removing it shrinks bundle ~5% and
  cleans cloud-api log noise. The `a551ea9` auth.py azp diagnostic
  is permanent — keeps the lowest-overhead Clerk-debug tool.
- **Friendly auth-success page** — `_CLERK_FALLBACK` in
  `popup.src.js` still routes to `/api/health` (raw JSON). Now that
  production tier accepts chrome-extension scheme, swap to
  `chrome.runtime.getURL("auth-success.html")` (already in
  `web_accessible_resources`).
