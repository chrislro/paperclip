---
phase: 001-security-review-remediation
plan: 04
subsystem: hud-concurrency
tags: [mutex, double-submit, listener-cleanup, storage-onChanged]
requirements-completed: [P1-5, P1-7]
affects: [future HUD changes in hud.js]
key-files:
  modified: [content/hud.js]
commit: 1d22cce
completed: 2026-04-22
---

# Plan 01-04 — HUD mutexes + storage-listener cleanup

**Finalizar Receita and template-prescription buttons are now double-click-safe; the `storage.onChanged` listener releases cleanly on HUD teardown.**

## Accomplishments

- `state.rxFinalizing` + `rxFinalizeBtn.disabled` mutex wraps Finalizar Receita handler in try/finally (lines 507-526).
- `state.rxRunning` + `btn.disabled` mutex wraps template-button handler in try/finally (lines 445-473) — distinct state key from Finalizar so both flows can be active concurrently (e.g. doctor opens a new template while the previous prescription is finalizing).
- Storage listener captured in module-scoped `storageListener` variable; removal wired into the **pre-existing** `cleanup()` function (lines 73, 494, 500, 1138-1141). `cleanup` was already attached to `beforeunload` at line 283 — no new infrastructure needed.
- `node --check content/hud.js` passes.

## Files

- `content/hud.js` — +70 / -29

## Commit

`1d22cce` — `fix: mutex Finalizar + template buttons and release storage listener on HUD teardown`

## Deviations

Minor:
- Combined the two state-object additions (`rxFinalizing`, `rxRunning`) into one block since they're related.
- One `Edit` tool call failed on a `✓` character (stored as `✓` in the file). Executor dropped to a byte-level Python replace for that edit — no behavioral change.
- Plan allowed "cleanup fn OR beforeunload" — chose cleanup fn because it already existed and was already wired to beforeunload. Less new surface.

## Follow-ups

- Pre-existing `cleanup()` + `beforeunload` wiring was discovered during this plan — worth noting for future contributors who might otherwise add duplicate teardown paths.
