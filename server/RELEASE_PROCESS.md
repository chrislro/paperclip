# Release Process — Toca Ficha Dr. Chrome Extension

> **Guardrail**: Chrome Web Store (CWS) submission is a **manual, CEO/CTO-approved step**.
> This pipeline automates everything up to the CWS upload boundary.
> See [CHRA-1921](/CHRA/issues/CHRA-1921) for the hardening audit.

## Overview

```
Developer triggers release → CI validates → CI tests → CI builds → CI bumps version + tags
                                                                    ↓
                                                          Manual: CEO/CTO reviews
                                                                    ↓
                                                          Manual: Upload to CWS
                                                                    ↓
                                                          Manual: Publish release
```

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | **Authoritative version** — runtime manifest (dev + prod hosts) |
| `manifest.prod.json` | Production manifest — must match `manifest.json` version at release time |
| `package.json` | Node tooling version — kept in sync for consistency |
| `CHANGELOG.md` | Human-readable release notes |
| `scripts/bump-version.sh` | Atomic version bump across all files |
| `scripts/build-package.sh` | Build clean ZIP for CWS |
| `scripts/verify-package.js` | Verify manifest references + no dev origins |
| `.github/workflows/release.yml` | Hardened release pipeline |

## Triggering a Release

### Option A: GitHub Actions UI (Recommended)

1. Go to **Actions → Release → Run workflow**
2. Enter the version: `3.9.0`
3. Click **Run workflow**
4. CI will:
   - Validate semver format
   - Verify `manifest.json == manifest.prod.json`
   - Block if uncommitted changes exist
   - Run `npm test`
   - Build production ZIP (`--prod`)
   - Verify no dev origins in package
   - Bump version in all files
   - Create git tag `v3.9.0`
   - Create **draft** GitHub release with ZIP attached

### Option B: Local (for debugging)

```bash
# 1. Verify everything is clean
./scripts/bump-version.sh --verify

# 2. Dry-run the bump
./scripts/bump-version.sh --dry-run 3.9.0

# 3. Apply the bump
./scripts/bump-version.sh 3.9.0

# 4. Build package
./scripts/build-package.sh --prod

# 5. Verify
node scripts/verify-package.js --dist dist

# 6. Push tag (manual — requires approval)
git push origin HEAD
git push origin v3.9.0
```

## CWS Submission Checklist

After CI completes and the draft release is created:

- [ ] **CEO/CTO approval** obtained (comment on release issue)
- [ ] Download `tocafichadr-vX.Y.Z.zip` from the draft release
- [ ] Verify locally: `node scripts/verify-package.js --dist dist/`
- [ ] Log in to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
- [ ] Upload ZIP → select **"Unlisted"**
- [ ] Verify store assets (screenshots, description, privacy policy)
- [ ] Submit for review (1–3 business days)
- [ ] After CWS approval: publish the GitHub release (remove draft status)
- [ ] Notify team in Discord #releases

## Rollback Plan

If a release is broken after CWS approval:

1. **Immediate**: Do not publish the GitHub release (keep as draft)
2. **CWS**: Revert to previous version in Developer Dashboard
3. **Code**: Create hotfix branch from previous tag:
   ```bash
   git checkout -b hotfix/v3.8.1 v3.8.0
   # Fix issue
   git commit -am "hotfix: ..."
   git tag -a v3.8.1 -m "Hotfix v3.8.1"
   git push origin v3.8.1
   ```
4. **Re-release**: Trigger Release workflow for `3.8.1`

## Guardrails

These checks are **hard-coded** in CI and cannot be bypassed:

| Guard | Location | Behavior |
|-------|----------|----------|
| Semver validation | `release.yml` validate job | Blocks non-semver versions |
| Manifest sync check | `bump-version.sh --verify` | Blocks if manifest.json ≠ manifest.prod.json |
| Uncommitted changes | `bump-version.sh` | Blocks if git tree is dirty |
| Dev origin audit | `release.yml` build job | Fails if localhost/127.0.0.1/trycloudflare found in built package |
| CWS submission block | `release.yml` release job | Release is always **draft**; CWS upload is manual |
| Secret scan | `release.yml` validate job | Fails if dev origins in manifest host_permissions |

## Emergency Bypass

In a true emergency (e.g., critical security fix), a maintainer with `admin`
access can:

1. Skip tests: re-run workflow with **"Skip tests"** checked
2. Manual bump: run `bump-version.sh` locally and push directly
3. Direct CWS upload: bypass GitHub release entirely

**All bypasses must be documented in the release issue with CEO/CTO approval.**

## Troubleshooting

### "manifest.json != manifest.prod.json"

Run:
```bash
./scripts/bump-version.sh --verify
# Fix the mismatch, then retry
```

### "Dev origins found in built package"

The `verify-package.js` sanitizer missed something. Check:
```bash
grep -r "localhost\|trycloudflare" dist/ --include="*.js" --include="*.html"
```
Add the pattern to `scripts/verify-package.js` `DEV_ORIGIN_PATTERNS` and
`exactReplacements`, then rebuild.

### "Version already exists"

The tag `vX.Y.Z` already exists. Choose a different version or delete the tag
(if it was a failed attempt):
```bash
git tag -d vX.Y.Z
git push origin --delete vX.Y.Z
```

## Changelog Format

When `bump-version.sh` runs, it prepends a template entry. Edit the
`CHANGELOG.md` before or after the release to fill in real content:

```markdown
## v3.9.0 — 2026-05-28 — Feature Title

### Added
- New feature description

### Changed
- Behavior change

### Fixed
- Bug fix

### Security
- Security improvement

### Verified
- `npm run build` passed.
- `node scripts/verify-package.js --root .` passed.
- Production ZIP built: `tocafichadr-v3.9.0.zip`.
```

## References

- Issue: [CHRA-1921](/CHRA/issues/CHRA-1921)
- CWS Developer Dashboard: https://chrome.google.com/webstore/devconsole
- Current version: `manifest.json` → `"version"`
