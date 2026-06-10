# Contributing

Toca Ficha Dr. is a clinical workflow tool. Small code changes can affect real
patient documentation, so every contribution must be scoped, tested, and easy to
roll back.

## Ground Rules

- Do not commit PHI, real patient logs, audio, screenshots with identifiers,
  live databases, `.env` files, secrets, tokens, or key material.
- Keep production package changes free of localhost, Tailscale, rotating
  Cloudflare tunnel, and gist URLs unless the change is explicitly dev-only.
- Treat G-Hosp DOM automation, auth, billing, database, and deployment changes
  as high-risk.
- Keep changes small enough to verify in one pass.
- Update docs when behavior, setup, deployment, safety, privacy, or release
  gates change.

## Branch And Commit Style

Use short topic branches:

```text
fix/backend-session-cleanup
docs/operations-runbooks
feat/atestado-flow
```

Commit messages should be conventional enough to scan:

```text
fix(backend): release db sessions after requests
docs(ops): add timeout runbook
test(extension): cover selector parity
```

## Required Checks

For extension or packaging changes:

```bash
npm test
./scripts/build-package.sh --prod
```

For backend changes:

```bash
cd backend
ALLOW_MISSING_OPENAI=1 \
SECRET_KEY=test-secret \
DATABASE_URL=sqlite:////tmp/tocafichadr-test.db \
python3 -m pytest -q
```

For production backend changes, also verify on the Mac Mini after deploy:

```bash
curl -sS -w '\nHTTP %{http_code} total=%{time_total}s\n' \
  https://api.tocafichadr.com.br/api/health
```

## Pull Request Or Commit Checklist

- [ ] Scope is clear and minimal.
- [ ] Relevant automated checks passed.
- [ ] Manual clinical tests are listed if needed.
- [ ] Rollback path is known for backend, auth, billing, DB, deployment, or
      clinical workflow changes.
- [ ] Docs were updated or the change does not require docs.
- [ ] No sensitive files or PHI are staged.
- [ ] GitHub Actions are green after push.

## Areas Requiring Extra Review

Ask for senior review before changing:

- Clerk auth, JWT verification, extension IDs, CORS, or `TOCAFICHADR_AUTH_REQUIRED`.
- Stripe billing, usage limits, or idempotency.
- Database models, migrations, or runtime DB handling.
- G-Hosp save, prescription, atestado, discharge, or print flows.
- Web Store production manifest permissions.
- Privacy, safety, or compliance claims.

## Documentation Ownership

Use `docs/DOCUMENTATION-MAP.md` to decide where a change belongs. Prefer updating
an existing document over creating a duplicate.
