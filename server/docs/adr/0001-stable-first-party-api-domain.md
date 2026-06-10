# ADR 0001: Stable First-Party API Domain

Status: Accepted

Date: 2026-05-08

## Context

Older builds supported rotating Cloudflare quick-tunnel URLs and gist-based
discovery. That was useful before `api.tocafichadr.com.br` was live, but it is
not acceptable for Chrome Web Store production packaging because:

- quick-tunnel URLs rotate and can break live shifts;
- production packages should not include gist or tunnel permissions;
- users should not keep stale tunnel URLs in `chrome.storage.sync`;
- Web Store review is simpler with a stable first-party API origin.

## Decision

Production cloud mode uses:

```text
https://api.tocafichadr.com.br
```

The production package must not contain:

- `localhost:5050`
- `127.0.0.1:5050`
- Tailscale IPs
- `trycloudflare.com`
- gist discovery URLs

The popup migration overwrites old stored cloud/dev URLs with the stable
first-party domain.

## Consequences

- Web Store package permissions are narrower.
- Existing user storage is migrated to the stable API path.
- Dev builds can still use local mode, but production builds should not preserve
  old tunnel URLs.

## Verification

```bash
npm test
./scripts/build-package.sh --prod
node scripts/verify-package.js --dist dist
```

Additional string check:

```bash
node -e "for (const f of ['dist/background/service-worker.bundle.js','dist/sidepanel/sidepanel-prontuario.js','dist/popup/popup.bundle.js']) { const s=require('fs').readFileSync(f,'utf8'); console.log(f, s.includes('trycloudflare'), s.includes('gist.githubusercontent'), s.includes('127.0.0.1:5050')); }"
```

Expected: all dev-origin checks are false.
