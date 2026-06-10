# Plan 02-02 — Popup migration to Clerk SignIn

> **Repo**: `tocafichadr-extension/` (this repo)
> **Effort**: 2-3 h
> **Blocks**: 02-03, 02-05, 02-06
> **Blocked by**: 02-00 (needs `CLERK_PUBLISHABLE_KEY`, `EXTENSION_ID_DEV`)

## Goal

Replace the popup's custom email/password form (lines ~80-200 of `popup/popup.js`, plus the `#authPanel` markup in `popup.html`) with Clerk's hosted SignIn UI from `@clerk/chrome-extension/client`. Introduce **esbuild** as a single-line bundler for the popup, since `@clerk/chrome-extension/client` ships only as ESM.

## Files changed

| File | Change | LOC delta |
|------|--------|-----------|
| `package.json` | Add `esbuild` + `@clerk/chrome-extension` to devDeps + `build:popup` script | +5 |
| `popup/popup.src.js` | Renamed from `popup/popup.js`. Replace auth section with `createClerkClient` + `clerk.openSignIn()` | -100 / +50 |
| `popup/popup.html` | Drop custom `#authPanel` form. Add `<div id="clerk-mount">`. Script tag points to `popup.bundle.js` | -50 / +5 |
| `popup/popup.bundle.js` | NEW (build artifact, gitignored) — esbuild output | +0 (gitignored) |
| `manifest.json` | CSP: add `'wasm-unsafe-eval'` and `connect-src https://*.clerk.accounts.dev` | +1 line modified |
| `.gitignore` | Add `popup/popup.bundle.js`, `node_modules/`, `*.bundle.map` | +3 |
| `scripts/build-package.sh` | Run `npm run build:popup` before `zip` | +1 |
| `tests/popup-clerk.test.js` | New — smoke test for createClerkClient init | +30 |

Net: **~150 LOC removed, ~90 LOC added** + 1 build artifact.

## Bundler integration (decision D1)

```json
// package.json — minimal additions
{
  "scripts": {
    "build:popup": "esbuild popup/popup.src.js --bundle --outfile=popup/popup.bundle.js --format=iife --target=chrome120 --sourcemap",
    "watch:popup": "esbuild popup/popup.src.js --bundle --outfile=popup/popup.bundle.js --format=iife --target=chrome120 --sourcemap --watch"
  },
  "devDependencies": {
    "esbuild": "^0.20.0",
    "@clerk/chrome-extension": "^2.0.0"
  }
}
```

Rationale (recap from PLAN D1):
- `--format=iife` produces a single self-executing function — no module loading needed in the popup HTML.
- `--target=chrome120` matches MV3 minimum (Chrome 88+ for service workers; we target Chrome 120+ which is ~12 months old, covers all current users).
- `--sourcemap` aids debugging from Chrome DevTools without exposing src in production zip (sourcemap file excluded from build-package.sh).

## New `popup.src.js` auth section (skeleton)

```javascript
// popup/popup.src.js (new file — replaces old popup.js auth block)
import { createClerkClient } from '@clerk/chrome-extension/client';

// CLERK_PUBLISHABLE_KEY is baked at build time via define plugin OR read from chrome.storage.
// For v3.0 we ship it inline since it's a publishable (not secret) key.
const CLERK_PUBLISHABLE_KEY = '__CLERK_PK_PLACEHOLDER__'; // replaced by build script

const EXTENSION_URL = chrome.runtime.getURL('.');
const POPUP_URL = `${EXTENSION_URL}popup.html`;

const clerk = createClerkClient({ publishableKey: CLERK_PUBLISHABLE_KEY });

let _clerkLoaded = false;

async function ensureClerk() {
  if (_clerkLoaded) return;
  await clerk.load({
    afterSignOutUrl: POPUP_URL,
    signInForceRedirectUrl: POPUP_URL,
    signUpForceRedirectUrl: POPUP_URL,
    allowedRedirectProtocols: ['chrome-extension:'],
  });
  _clerkLoaded = true;
}

async function renderAuthState() {
  await ensureClerk();
  const authPanel = document.getElementById('authPanel');
  const userPanel = document.getElementById('userPanel');
  const emailEl = document.getElementById('userEmail');
  const signInBtn = document.getElementById('signInBtn');
  const signOutBtn = document.getElementById('signOutBtn');

  if (clerk.user) {
    authPanel.style.display = 'none';
    userPanel.style.display = 'block';
    emailEl.textContent = clerk.user.primaryEmailAddress?.emailAddress ?? '(no email)';
  } else {
    authPanel.style.display = 'block';
    userPanel.style.display = 'none';
  }

  // Wire up buttons (idempotent — safe to call on re-render)
  signInBtn.onclick = () => clerk.openSignIn({});
  signOutBtn.onclick = () => clerk.signOut();
}

// Re-render whenever Clerk's auth state changes (sign-in completes, user signs out, etc.)
clerk.addListener(renderAuthState);
renderAuthState();

// Existing popup logic (settings tab, scribe tab, etc.) is preserved verbatim below this block.
```

## `popup.html` changes

Replace the custom email/password form (~50 lines) with:

```html
<div id="authPanel" class="auth-panel">
  <h3>Toca Ficha Dr.</h3>
  <p class="auth-blurb">Faça login para sincronizar consultas e faturamento.</p>
  <button id="signInBtn" class="btn-primary">Entrar / Cadastrar</button>
</div>

<div id="userPanel" class="auth-panel" style="display:none;">
  <p class="auth-email">👤 <span id="userEmail"></span></p>
  <button id="signOutBtn" class="btn-secondary">Sair</button>
</div>
```

`clerk.openSignIn()` opens Clerk's hosted modal — no inline form maintenance. The modal handles email verification, password reset, MFA prompts, etc.

Script tag at the bottom of `popup.html`:

```html
<!-- Was: <script src="popup.js"></script> -->
<script src="popup.bundle.js"></script>
```

## CSP relaxation (decision D6)

`manifest.json`:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'none'; connect-src 'self' https://*.clerk.accounts.dev https://api.tocafichadr.com.br https://*.trycloudflare.com"
}
```

Changes:
- `+ 'wasm-unsafe-eval'` — Clerk crypto operations require WASM compilation
- `+ connect-src` directives for Clerk Frontend API, our Flask backend, and dev tunnel URLs

What stays tight: `script-src` is still `'self'` (no inline JS, no remote scripts); `object-src 'self'`; `base-uri 'none'`. The relaxation is targeted to what Clerk requires, not a blanket loosening.

## Build pipeline change

`scripts/build-package.sh`:

```bash
#!/bin/bash
set -e
# ... existing version check ...

# NEW: build the popup bundle
npm run build:popup

# ... existing zip logic, now includes popup.bundle.js + popup.html (without popup.src.js) ...
```

`.gitignore`:

```
node_modules/
popup/popup.bundle.js
popup/popup.bundle.js.map
```

## Verification

1. `npm run build:popup` produces `popup/popup.bundle.js` (~250 KB minified expected; Clerk SDK is heavy).
2. Load unpacked → click extension icon → popup opens → "Entrar / Cadastrar" button.
3. Click button → Clerk modal opens (chrome-extension://`<id>`/popup.html#/sign-in).
4. Sign up with a fresh email → email verification arrives → click link → returns to popup → `userPanel` visible with email.
5. `chrome.storage.local` should now have a `clerk_*` session key (Clerk SDK manages this).
6. From DevTools popup console: `await clerk.session.getToken()` returns a JWT.
7. Decode the JWT at jwt.io — confirm `iss=https://...clerk.accounts.dev`, `sub=user_...`, `email=<my email>` (custom claim from dashboard step 2).

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Build artifact size — Clerk SDK is ~250 KB | Acceptable; popups don't have a hard size cap. Sub-300 KB is fine for Web Store. |
| `popup.src.js` and `popup.bundle.js` drift if dev forgets to rebuild | `npm run watch:popup` during dev; `build-package.sh` runs build for releases |
| CSP regression breaks something else | Test full popup flow + scribe tab + settings tab after CSP change |
| `clerk.openSignIn()` doesn't render in the popup's 340px width | Clerk modal is responsive; falls back to redirect if popup constrained. Verify during smoke. |
| Bundler introduces source map paths exposing local filesystem | `build-package.sh` excludes `*.map` from zip |

## Out of scope

- Service worker integration (02-03).
- Stripe linkage (02-04).
- Settings tab UX changes (preserved verbatim — only auth panel changes).

## Commit message template

```
feat(popup): Clerk hosted SignIn (v3.0.2)

Replace custom email/password form with Clerk's hosted SignIn modal.
Introduce esbuild as a build step for the popup bundle (bundling
@clerk/chrome-extension/client ESM into a self-contained IIFE).

- popup.src.js (new) wraps createClerkClient + openSignIn
- popup.html drops custom form; gains #signInBtn / #userPanel
- manifest.json CSP relaxed to allow wasm-unsafe-eval and Clerk origin
- build-package.sh runs npm run build:popup before zip
- .gitignore adds node_modules + popup.bundle.js

Refs: phase 002 plan 02-02.
```
