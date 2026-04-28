# Ultra Review Notes - 2026-04-27

Scope: Mac Mini clone `/Users/christianoliveira/Dev/paperclip`.

## Findings

- Medium: root `packageManager` is `pnpm`, but an untracked `package-lock.json` exists. That can confuse future installs and reviews.
- Medium: package exports were changed from `src/*.ts` to `dist/*.js` across packages. This is probably correct for runtime packaging, but must be validated with a clean build.
- Medium: the new Mac Mini health collector includes stale service inventory entries: Luxe API/frontend were unreachable in the live snapshot.

## Fix

- Remove accidental npm lockfile unless intentionally migrating package managers.
- Run `pnpm run build` and relevant smoke tests before committing export changes.
- Update `ops/mac-mini-health-collector/services.json` to distinguish inactive services from failed services.
