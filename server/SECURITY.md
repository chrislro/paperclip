# Security Policy

Toca Ficha Dr. is a clinical automation extension used by physicians on real patient records. We take security seriously and value coordinated disclosure.

## Reporting a vulnerability

**Please email:** contato@tocafichadr.com.br
**Subject:** `Security — <short summary>`

Please **do NOT** open a public GitHub issue for security reports. Public reports give attackers a head start before a fix is ready.

Include in your report:
- Affected component (extension popup / service worker / content script / Flask backend / landing site / Clerk auth flow)
- Affected version (extension `manifest.json` `version`, or commit SHA on `backend/` if backend)
- Steps to reproduce, ideally with a minimal test case
- What you can do with it (impact)
- Whether you've already disclosed it elsewhere

We will:
- Acknowledge receipt **within 72 hours**
- Provide a triage assessment (severity + remediation plan) **within 7 days**
- Aim to ship a fix **within 30 days** for high/critical, **90 days** for lower severity
- Credit you in the changelog or a `SECURITY-ACKNOWLEDGMENTS.md` file once shipped (unless you ask us not to)

## Scope

### In scope (please report)

- The Chrome extension code in this repository (popup, service worker, content scripts, manifest, build pipeline)
- The companion Flask backend in `backend/` (this repo)
- The landing page + privacy policy at `https://tocafichadr.com.br/`
- Authentication flow (Clerk JWKS verification, session token handling, lazy provisioning)
- Webhook endpoint (`/clerk/webhook`) and Svix signature verification
- DNS / TLS / hosting configuration on Vercel + HostGator (DNS) + Mac Mini (Flask)
- Cloudflare Tunnel configuration

### Out of scope (don't report to us — report to the upstream)

- Vulnerabilities in **G-Hosp** / G-UPA itself — report to UPA Bento Gonçalves IT
- **OpenAI** API or model behavior — report at https://openai.com/security/disclosure/
- **Clerk** authentication infrastructure — report at https://clerk.com/security
- **Vercel** platform issues — report at https://vercel.com/security
- **Chrome / Chromium** vulnerabilities — report to Google
- Vulnerabilities requiring physical access to an unlocked, logged-in clinical workstation (this is a doctor-trust model, not a hostile-multi-tenant model)
- Self-XSS / clickjacking that requires the user to actively bypass browser warnings

## Safe harbor

If you act in good faith, follow this policy, and avoid privacy/safety harm during testing, we will not pursue legal action. Specifically:

- Do **not** access patient data on the live G-Hosp instance — use a staging account or local Flask if you need to test against the EMR layer
- Do **not** retain, modify, exfiltrate, or destroy data
- Make a good-faith effort to avoid privacy violations, service disruption, and degradation of the user experience for clinical users on shift

## Severity guide

| Severity | Examples | Response time target |
|----------|----------|----------------------|
| **Critical** | Patient data exfiltration, RCE on the Flask backend, auth bypass that exposes other physicians' data | Same-day acknowledgment, fix within 7 days |
| **High** | XSS in clinical-data-bearing surfaces, auth bypass affecting only the reporter, JWKS-bypass that lets unsigned tokens authenticate | 72h acknowledgment, fix within 30 days |
| **Medium** | CSRF on non-clinical endpoints, info disclosure that doesn't expose clinical data, session fixation | 7-day triage, fix within 90 days |
| **Low** | Defensive-depth gaps (missing HSTS, weaker-than-ideal CSP, etc.) | Triaged but may be batched into the next release |

## Out-of-scope clarifications

- The extension is **MV3** and binds to **a single hospital domain** (`prbentogoncalves.g-hosp.com.br`). Reports about extension behavior on other origins are out of scope.
- The Flask backend's `TOCAFICHADR_AUTH_REQUIRED` gate is intentionally **off** (`false`) during the v3.0+ cutover window so old extension installs keep working. Clerk auth is fully configured and the gate will flip once Web Store-distributed v3.x clients dominate traffic. This is documented behavior, not a vulnerability.
- The shared `EXTENSION_API_KEY` path in `require_extension_or_user` is preserved as an escape hatch for self-hosting. Single-tenant deployments may use it; the multi-tenant cloud uses Clerk JWTs.

## What's NOT a vulnerability

- The 2.5 MB popup + service-worker bundles include the Clerk SDK with React dependencies. Bundle size, build artifacts, and minification preserving readable strings are not security issues.
- Reading `chrome.storage.local` requires either being inside the extension or having control over a logged-in physician's browser profile. The threat model assumes the physician's browser is trusted.
- The extension bundles ~165 hardcoded CID-10 codes. Lookups use substring matching and don't query a backend. This is not a privacy concern.

## PGP

If you'd like to encrypt your report, request a PGP key in your initial email and we'll provide one.

## Coordinated disclosure

We support coordinated disclosure timelines. We will not publish details of the vulnerability before a fix has shipped to all affected users (the auto-update channel for the Web Store handles ~99% of users within 24 hours of publish). For critical issues we may delay public disclosure beyond the standard 90 days if deploying the fix requires Mac Mini server-side coordination — we will communicate timeline reasons clearly.

## Hall of fame

Researchers who have reported responsibly will be acknowledged here once we have any.
