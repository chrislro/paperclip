# Phase 004 — Internal rebrand `pedbot` → `tocafichadr`

> **Status**: queued (not yet executed)
> **Triggered by**: 2026-05-10 phase 003 verification surfaced the half-finished rename. Production DB + role were renamed `pedbot` → `tocafichadr` in the same window (one-time ops fix on Mac Mini Postgres); this phase finishes the rename by catching up the **codebase** so internal identifiers match the product brand.

## Status as of 2026-05-10

Where the rename is already done:

- ✅ **GitHub repo**: `https://github.com/chrislro/tocafichadr-extension.git` (origin remote).
- ✅ **launchd plist**: `com.tocafichadr.cloud-api.plist` (Mac Mini).
- ✅ **Production Postgres DB + role**: renamed to `tocafichadr` (May 10, 2026). pg_dump backup at `~/backups/pedbot-pre-rename-20260510-1556.dump` on the Mini.
- ✅ **Keychain URL value**: now points at `postgresql://tocafichadr:****@localhost:5432/tocafichadr`.
- ✅ **Chrome extension display name + manifest description**: already "Toca Ficha Dr." in user-facing surfaces.

Where it lags (24 in-repo references, not counting `package-lock.json`):

- ❌ **Keychain entry NAMES** still prefixed `pedbot-` (`pedbot-database-url`, `pedbot-secret-key`, `pedbot-stripe-*`, `pedbot-clerk-*`). Values are correct; only the lookup keys are stale.
- ❌ **`backend/emr_automation/`**: 8 call sites of `keychain_secret("pedbot-…")` across `database.py`, `auth.py`, `billing.py`, `dashboard/app.py`, `dashboard/routes_clerk.py`, `dashboard/routes.py`.
- ❌ **`backend/keychain_helper.py`**: the `KEYCHAIN_SECRETS` map declares 7 `pedbot-*` keys.
- ❌ **Logger names**: `getLogger("pedbot.extension_error")` and `getLogger("pedbot.extension_debug")` in `routes.py`. Affects log filter rules; renaming changes the namespace seen in Console.app / log files.
- ❌ **`package.json`**: `"name": "pedbot-extension"` + GitHub URLs all still say `pedbot-extension`.
- ❌ **Error-message strings**: at least one in `auth.py:52` instructs `security add-generic-password … -s pedbot-clerk-secret-key …` — would mislead a fresh setup.

Effective state today:
- Production runs fine: code calls `keychain_secret("pedbot-database-url")`, finds an entry by that name, reads the value (which now correctly says `…/tocafichadr`). No runtime regression.
- But: anyone reading the code or fresh-installing on a new Mac would hit a brand-mismatch surface — keychain entries to create, doc snippets to copy, etc.

## Goal

Bring every internal identifier into line with the `tocafichadr` brand so that:

1. A fresh setup on a new Mac creates `tocafichadr-*` keychain entries, not `pedbot-*`.
2. Code reads from the new entries via `keychain_secret("tocafichadr-…")`.
3. Logger namespaces, `package.json` name, and any help text match the brand.
4. The transition is **operationally safe** — the running Mini does not lose access to its secrets mid-flight.

## Success criteria (what must be TRUE)

1. **All `pedbot-*` keychain references in the codebase are renamed** to `tocafichadr-*`. Verified by `grep -rIn "pedbot-" backend/` returning zero hits inside source files.
2. **Mac Mini keychain has `tocafichadr-*` entries** populated with the same values as the existing `pedbot-*` entries. The old `pedbot-*` entries are deleted only AFTER the new entries are confirmed working.
3. **Flask reboots cleanly** with the renamed keys and serves `/api/health` 200.
4. **`package.json`**: `"name": "tocafichadr-extension"`. GitHub URLs use `tocafichadr-extension`.
5. **Logger names** end with `tocafichadr.*`, not `pedbot.*`.
6. **Selftest 10/10 still green** and a new `[11/11]` tripwire fails if `pedbot-` reappears in `backend/**/*.py`.

## Plans

| # | Plan | Type | Files | Status |
|---|---|---|---|---|
| 04-01 | Mac Mini keychain rekeying — copy `pedbot-*` entries to `tocafichadr-*` names without changing values. Verify both names resolve to the same value before touching code. | ops | (Mac Mini `automation.keychain-db` only) | pending |
| 04-02 | Codebase rename of `keychain_secret()` argument strings + the `KEYCHAIN_SECRETS` map in `keychain_helper.py`. Single search-and-replace pass across `backend/emr_automation/`. | execute | `backend/keychain_helper.py`, `backend/emr_automation/{database,auth,billing}.py`, `backend/emr_automation/dashboard/{app,routes,routes_clerk}.py` | pending |
| 04-03 | Logger namespace rename + `package.json` rename. Includes any setup-instruction strings in error messages. | execute | `backend/emr_automation/dashboard/routes.py`, `package.json` | pending |
| 04-04 | Tripwire: new step `[11/11]` in `scripts/selftest.sh` that greps for `pedbot-` in `backend/**/*.py` and fails the build if found. Plus delete old `pedbot-*` keychain entries on the Mini (after a successful Flask restart against the renamed keychain). | execute | `scripts/test-rebrand.js`, `scripts/selftest.sh`, (Mini keychain ops) | pending |

## Out of scope (this phase)

- **Migrate Postgres again** — done in the May 10 operational window. No further DB ops needed.
- **Rename the Mac Mini's macOS user `christianoliveira`** — out of scope; that's an OS-level identity unrelated to product branding.
- **Rename the launchd label `com.tocafichadr.cloud-api`** — already at the new name.
- **`package-lock.json` regeneration** — running `npm install` regenerates it; leave for the same commit that updates `package.json` to avoid drift.
- **CHANGELOG.md retro-edit** — phase 003's CHANGELOG entry already references the new DB name implicitly via paths.

## Operational notes

- **04-01 (keychain rekey) is operationally critical and must come first.** If 04-02 lands before the new keychain entries exist, every Flask boot will fail at `keychain_secret("tocafichadr-database-url")` → `SystemExit`. Sequence: 04-01 (add new entries) → 04-02 (code change) → restart Flask → verify → 04-04 (delete old entries).
- **Test reload between 04-02 and 04-03** to catch any missed call site before the logger rename adds noise to the diff.
- **04-04 trip-wire MUST run as part of selftest** so a future commit that adds a new `keychain_secret("pedbot-…")` blocks the merge.
