# Architecture

Updated: 2026-05-08

Toca Ficha Dr. is a Chrome Manifest V3 extension for G-Hosp plus a Flask backend
running on a Mac Mini behind `https://api.tocafichadr.com.br`.

## Goals

- Reduce repeated G-Hosp actions during pediatric urgent-care shifts.
- Keep the physician as the author of every clinical record.
- Avoid storing patient audio, transcripts, SOAP notes, or per-patient CID data
  on Toca Ficha Dr. infrastructure.
- Keep selector-driven DOM automation isolated to the approved G-Hosp origin.
- Make backend health, auth, billing, and release gates visible before Web Store
  submission.

## Runtime Components

| Component | Path | Responsibility |
|---|---|---|
| Manifest | `manifest.json`, `manifest.prod.json` | Permissions, CSP, content scripts, Web Store runtime surface. |
| Content scripts | `content/` | Inject HUD, capture audio, manipulate G-Hosp DOM, call service worker API proxy. |
| Side panel | `sidepanel/` | Main physician workflow UI for recording, SOAP, CID, prescriptions, atestado, and discharge. |
| Popup | `popup/` | Auth state, settings, templates, billing status, and fallback scribe UI. |
| Background service worker | `background/service-worker.src.js` | Clerk token handling, API proxy, timeout control, offscreen/realtime routing. |
| Offscreen document | `offscreen/` | Chrome offscreen audio/realtime support when popup lifecycle is too short. |
| Flask backend | `backend/emr_automation/` | Transcription, SOAP/CID formatting, selector API, auth, billing, usage limits, idempotency. |
| Landing site | `landing/` | Public marketing, privacy page, SEO, and Web Store support pages. |
| Deployment scripts | `backend/scripts/` | Mac Mini launchd service and backend startup. |

## Production Topology

```text
Chrome extension
  -> https://api.tocafichadr.com.br
  -> Cloudflare Tunnel / DNS route
  -> Mac Mini launchd service: com.tocafichadr.cloud-api
  -> Flask app on 127.0.0.1:5050
  -> SQLite runtime DB under backend/data/ locally
  -> OpenAI API for transcription and SOAP/CID generation
  -> Clerk for user auth
  -> Stripe for billing
```

The repo is the source of truth for both extension and backend. The Mac Mini
checkout is expected at:

```text
/Users/christianoliveira/Dev/tocafichadr-extension
```

## Primary Request Flows

### Health And Selector Load

1. Extension reads `apiBaseUrl`, defaulting to `https://api.tocafichadr.com.br`.
2. `GET /api/health` confirms backend reachability.
3. `GET /api/selectors?emr=ghosp` returns G-Hosp selectors.
4. Content scripts use selector config plus bundled fallbacks to operate on the
   active patient page.

### Voice To SOAP

1. Physician starts recording in side panel or HUD.
2. Browser captures audio via MediaRecorder.
3. Service worker sends `POST /api/transcribe?skip_soap=1` or full transcribe
   request with a timeout.
4. Backend transcribes audio and optionally generates SOAP/CID.
5. Extension writes draft SOAP into G-Hosp fields.
6. Physician reviews before saving in G-Hosp.

### Auth And Billing

1. Popup loads Clerk and stores a session token through the extension context.
2. Service worker attaches `Authorization: Bearer <token>` for authenticated API
   calls.
3. Backend verifies Clerk JWTs and lazy-provisions a local `User` row.
4. `/billing/subscription` returns plan and usage metadata.
5. Request-scoped SQLAlchemy sessions are removed during Flask app teardown so
   connections return to the pool after every request.

## Data Boundaries

| Data | Stored By Toca Ficha Dr.? | Notes |
|---|---:|---|
| Patient audio | No | Processed in memory for transcription. |
| Transcript / SOAP | No | Returned to extension, reviewed by physician, saved only in G-Hosp if the physician chooses. |
| CID suggestion | No per-patient storage | Suggested in UI; physician decides. |
| User email / auth ID | Yes | Used for Clerk billing/auth mapping. |
| Usage metadata | Yes | Action type, timing, and user ID, without clinical content. |
| Runtime logs | Yes | Must not include PHI. Logs are used for operational debugging. |

## Security Boundaries

- Production package must not contain localhost, Tailscale, rotating
  `trycloudflare.com`, or gist endpoints.
- `manifest.prod.json` limits host permissions to G-Hosp, the first-party API,
  and Clerk.
- The service worker is the API proxy boundary for extension calls.
- Auth is Clerk-first. Shared extension API key support is kept only as a
  single-tenant/self-hosting escape hatch.
- Clinical automation is scoped to `https://prbentogoncalves.g-hosp.com.br/*`.

## Known Architectural Risks

- G-Hosp DOM selectors can change without notice. Manual shift tests remain
  mandatory before Web Store submission.
- The current backend runs on Flask's development server under launchd. That is
  acceptable for private beta but should move to gunicorn or another production
  WSGI server before broader paid usage.
- SQLite is operationally simple but can become a bottleneck for multi-user
  billing/auth usage. Move to Postgres before enterprise or multi-clinic rollout.
- Clerk publishable keys and extension IDs must be updated when the Web Store
  production listing is live.

## Related Docs

- `docs/TESTING.md`
- `docs/OPERATIONS.md`
- `SAFETY.md`
- `SECURITY.md`
- `PRIVACY_POLICY.md`
- `docs/AUDIT-IMPLEMENTATION-PLAN.md`
- `docs/adr/`
