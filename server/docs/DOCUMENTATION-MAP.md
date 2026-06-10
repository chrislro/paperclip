# Project Documentation Map

Updated: 2026-05-15

This file defines the documentation set for Toca Ficha Dr. It translates the
generic "essential project files" checklist into the docs this repo actually
needs as a clinical Chrome extension plus Flask backend.

## Source Of Truth

| Area | File | Status |
|---|---|---|
| Product requirement document | `PRD.md` | Exists |
| Technical architecture | `docs/ARCHITECTURE.md` | Exists |
| ASR, SOAP/CID providers, audio capture, and observability | `docs/ASR-SOAP-OBSERVABILITY.md` | Exists |
| UX/UI design and manual workflow validation | `docs/MANUAL-TESTS.md`, `docs/ui-ideas-v3.2.0.html`, `docs/atestado-options.html`, `docs/smart-templates.html`, `docs/dose-calc-options.html` | Exists |
| Go-to-market and launch | `docs/STRATEGY-saas.md`, `docs/MARKET-RESEARCH-2026.md`, `docs/WEB-STORE-PREP.md`, `docs/v3.0-WEB-STORE-SUBMIT.md`, `docs/LAUNCH.md` | Exists |
| Setup and quickstart | `README.md`, `backend/README.md` | Exists |
| Testing and release gates | `docs/TESTING.md` | Exists |
| Operations and runbooks | `docs/OPERATIONS.md` | Exists |
| Security disclosure | `SECURITY.md` | Exists |
| Clinical safety and intended use | `SAFETY.md` | Exists |
| Privacy and data processing | `PRIVACY_POLICY.md`, `landing/privacidade.html` | Exists |
| Roadmap and next work | `ROADMAP.md`, `docs/NEXT-STEPS.md`, `docs/AUDIT-IMPLEMENTATION-PLAN.md` | Exists |
| Change history | `CHANGELOG.md` | Exists |
| Contribution workflow | `CONTRIBUTING.md` | Exists |
| Architecture decisions | `docs/adr/` | Exists |

## Essential Docs Not Yet Final

These should not be invented by an agent without owner/legal review.

| File | Why It Matters | Current Action |
|---|---|---|
| `LICENSE` | Defines whether this is proprietary, ISC, or open source. `package.json` currently says `ISC`, but the product is a commercial clinical tool. | Owner must decide before public distribution of source. |
| `SBOM.md` or generated SBOM artifact | Enterprise and healthcare buyers may request a software bill of materials. | Generate from `package-lock.json` and `backend/requirements.txt` before enterprise pilots. |
| `COMPLIANCE.md` | Maps LGPD, CFM 2.454/2026, Web Store policy, and future security controls into explicit obligations. | `SAFETY.md`, `SECURITY.md`, and `PRIVACY_POLICY.md` cover most content. Consolidate before paid launch. |
| `BACKUP_RECOVERY.md` | Needed once billing/auth data is business-critical. | Operational backup notes live in `docs/OPERATIONS.md`; split out when production DB is no longer local SQLite. |

## Minimum Viable Docs For This Project

For any production-affecting change, these documents must be enough for another
engineer to understand, run, verify, deploy, and recover the system:

1. `README.md` for setup and orientation.
2. `docs/ARCHITECTURE.md` for system shape and data flow.
3. `docs/TESTING.md` for automated and manual gates.
4. `docs/OPERATIONS.md` for production health, logs, deploy, rollback, and incidents.
5. `SAFETY.md`, `SECURITY.md`, and `PRIVACY_POLICY.md` for clinical, security, and privacy boundaries.
6. `docs/adr/` for important decisions that should not be rediscovered later.

## Documentation Rules

- Keep clinical safety claims aligned across `SAFETY.md`, `PRIVACY_POLICY.md`,
  `landing/privacidade.html`, and Chrome Web Store copy.
- Do not document a production behavior as "done" until it has been verified on
  the Mac Mini or public endpoint.
- Every backend, auth, billing, database, deployment, or clinical workflow change
  must include rollback notes in the PR or commit summary.
- Do not commit PHI, real patient logs, live databases, tokens, `.env` files, or
  screenshots containing patient identifiers.
- Prefer updating existing docs over adding duplicates. Add a new doc only when
  it creates a stable owner for a distinct topic.
