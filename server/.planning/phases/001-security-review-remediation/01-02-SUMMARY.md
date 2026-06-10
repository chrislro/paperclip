---
phase: 001-security-review-remediation
plan: 02
subsystem: correctness
tags: [dom-engine, waitFor, timeout-cleanup, error-log-hygiene]
requirements-completed: [P1-1]
affects: []
key-files:
  modified: [content/dom-engine.js]
commit: add93de
completed: 2026-04-22
---

# Plan 01-02 — waitFor / _waitForDialogContent clearTimeout

**Stops orphan `setTimeout` rejections from polluting `/api/error-log` after a wait resolves.**

## Accomplishments

- `waitFor` captures `const timeoutHandle = setTimeout(...)` and calls `clearTimeout(timeoutHandle)` inside the MutationObserver callback before `resolve(el)`.
- `_waitForDialogContent` gets the same treatment.
- Synchronous "element already present" branches in both functions run *before* the timer is armed, so they need no `clearTimeout`.

## Files

- `content/dom-engine.js` — +4 / -2 (two `clearTimeout` call sites at lines 145 and 532)

## Commit

`add93de` — `fix: clear waitFor timeouts on resolve to stop phantom error-log spam`

## Deviations

None material. The plan's hypothetical "clear timeout in the sync-check branch" didn't apply — that branch short-circuits before the timer is scheduled.

## Follow-ups

- Stylistic: `const timeoutHandle` is declared after the observer-constructor line that references it. Works because the observer callback is strictly async. A future reader might prefer the timeout declared first for locality. Not shipping a rename now — three similar lines beat a premature cleanup.
