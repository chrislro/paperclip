---
phase: 001-security-review-remediation
plan: 05
subsystem: popup
tags: [chrome-storage-sync, quota-exceeded, id-keyed-handlers, template-editing]
requirements-completed: [P1-11, P1-12]
affects: []
key-files:
  modified: [popup/popup.js, popup/popup.html]
commit: fe17eee
completed: 2026-04-22
---

# Plan 01-05 — popup storage errors + id-keyed template handlers

**Template saves that hit the storage.sync quota now surface a visible error; editing one row while another is deleted no longer drops input or writes to a stale index.**

## Accomplishments

- **P1-11** — `saveRxTemplatesDebounced` passes a completion callback to `chrome.storage.sync.set`. On `chrome.runtime.lastError`, `_showTemplateSaveError(msg)` writes to a new `<div id="rx-save-error" aria-live="polite">` in `popup.html`. On success, `_clearTemplateSaveError()` wipes it. New CSS rule added to the existing inline `<style>` block.
- **P1-12** — Name/body input handlers and the remove-button handler resolve the live template via `rxTemplates.find(t => t.id === tpl.id)` / `findIndex`. Templates loaded without an id get one synthesized via `_genId()` in `loadRxTemplates` and persisted back.
- `node --check popup/popup.js` passes. All four grep gates pass.

## Files

- `popup/popup.js` — +47 / -9
- `popup/popup.html` — +2 +1 CSS rule / +1 error div

## Commit

`fe17eee` — `fix: surface storage.sync quota errors + id-key template handlers`

## Deviations

None. Executed as planned.

## Follow-ups

- `popup.html` has inline `<style>` — no separate `popup.css` exists. Future CSS-heavy work may want to split this out, but not required now.
