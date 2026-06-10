---
phase: 006
name: code-quality-sweep-2026-05-17
status: in-progress
key_files:
  created: []
  modified:
    - .planning/config.json
    - auth-success.js
    - backend/data/selectors/ghosp.json
    - backend/emr_automation/dashboard/static/app.js
    - background/service-worker.src.js
    - content/api-client.js
    - content/audio-capture.js
    - content/bridge.js
    - content/cid.js
    - content/content.js
    - content/dom-engine.js
    - content/hud.js
    - content/selectors.json
    - content/vad-helpers.js
    - manifest.json
    - manifest.prod.json
    - offscreen/offscreen.js
    - package.json
    - popup/popup.bundle.js
    - popup/popup.src.js
    - scripts/cid_mapping_report.json
    - scripts/emr_cids_extracted_2026-05-10.json
    - scripts/emr_cids_mapped_2026-05-10.json
    - scripts/extract_emr_cids.js
    - scripts/extract_emr_cids_cdp.js
    - scripts/extract_emr_cids_cdp_v2.js
    - scripts/extract_emr_cids_jxa.js
    - scripts/extract_emr_cids_simple.js
    - scripts/test-atestado.js
    - scripts/test-config-gate.js
    - scripts/test-debug-log.js
    - scripts/test-prescription-simples.js
    - scripts/test-vad.js
    - scripts/verify-package.js
    - shared/clerk-tap.js
    - shared/console-shipper.js
    - shared/user-config-client.js
    - sidepanel/sidepanel-prontuario.js
    - vercel.json
---

# Phase 006: Code-quality sweep 2026-05-17

Retroactive review of entire codebase to establish a quality baseline.

## Scope

Full sweep of all tracked source files (`.ts`, `.tsx`, `.js`, `.json`, `manifest.json`),
excluding generated bundles, lockfiles, build artifacts, and packaging outputs.

## Skills applied

1. `/health` → `docs/reviews/2026-05-17/01-health.md`
2. `/gsd-code-review` (deep) → `006-REVIEW.md` (this phase directory)
3. `/security-review` → `docs/reviews/2026-05-17/04-security-review.md`
4. `/cso` (comprehensive) → `docs/reviews/2026-05-17/05-cso.json`
5. `/gsd-audit-fix` (dry-run) → `docs/reviews/2026-05-17/07-audit-fix-classification.md`

## Constraints

- Phase 005 (`005-production-clerk-migration`) is mid-migration — DO NOT TOUCH.
- All reviews scoped to `006-REVIEW.md`, never to phase 005 files.
- Branch: `chore/code-quality-sweep-2026-05-17`
