// scripts/test-dom-engine-guards.js — CHRA-2423 Bugs 51–53
//
// Run with: node --test scripts/test-dom-engine-guards.js
//
// Three source-ordering + semantic guards on dom-engine.js fixes:
//
//  Bug 51 — _findSemEncaminhamentoOption used opt.value==='0' as a fallback,
//  which is the Rails include_blank placeholder, NOT "Sem encaminhamento".
//  Selecting it submits the discharge form with no referral option chosen.
//
//  Bug 52 — selectTemplate checked padroesDiv.style.display ('') instead of
//  window.getComputedStyle().display ('none') to decide whether to reveal the
//  template container. CSS-hidden elements have inline style.display === ''
//  so the reveal click was silently skipped for class-hidden containers.
//
//  Bug 53 — fillCid dispatched the 'input' event on the visible CID field
//  BEFORE writing emrId to the hidden field. Any synchronous G-Hosp handler
//  on 'input' that reads the hidden input would receive the stale prior value.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'content/dom-engine.js'), 'utf8');

// ---------------------------------------------------------------------------
// Bug 51 — discharge blank-option guard
// ---------------------------------------------------------------------------

test('_findSemEncaminhamentoOption does NOT fall back to opt.value === "0"', () => {
  // The blank placeholder in Rails has value '0'; selecting it is wrong.
  // Strip single-line comments before checking so the explanatory "Do NOT..."
  // comment that references the removed pattern doesn't trip the guard.
  const strippedSrc = SRC.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    strippedSrc,
    /opt\.value\s*===\s*['"]0['"]/,
    '_findSemEncaminhamentoOption must not match opt.value === "0" — ' +
    'that is the Rails include_blank placeholder, not "Sem encaminhamento"'
  );
});

test('_findSemEncaminhamentoOption source still delegates to _isSemEncaminhamentoOption', () => {
  // Confirm the primary predicate wasn't accidentally removed along with the fix.
  const fnBody = SRC.match(/function _findSemEncaminhamentoOption[\s\S]*?^\s{2}}/m);
  assert.ok(fnBody, '_findSemEncaminhamentoOption not found');
  assert.match(fnBody[0], /_isSemEncaminhamentoOption/, 'must still call _isSemEncaminhamentoOption');
});

// ---------------------------------------------------------------------------
// Bug 52 — selectTemplate computed-style guard
// ---------------------------------------------------------------------------

test('selectTemplate uses getComputedStyle to detect hidden template container', () => {
  // Extract the selectTemplate function body and confirm it uses
  // window.getComputedStyle, not padroesDiv.style.display directly.
  const fnMatch = SRC.match(/function selectTemplate[\s\S]*?(?=\n  \/\*\*|\n  \/\/\s*[-=]{3})/);
  assert.ok(fnMatch, 'selectTemplate function not found');
  const body = fnMatch[0];

  assert.doesNotMatch(
    body,
    /padroesDiv\.style\.display/,
    'selectTemplate must not use padroesDiv.style.display (inline style only, misses CSS-hidden elements)'
  );
  assert.match(
    body,
    /getComputedStyle\(/,
    'selectTemplate must use getComputedStyle to detect visibility'
  );
});

// ---------------------------------------------------------------------------
// Bug 53 — fillCid hidden-field-before-input-event ordering
// ---------------------------------------------------------------------------

test('fillCid sets hiddenInput.value before dispatching input event on visible field', () => {
  // Extract the fillCid function body and check that the assignment
  // hiddenInput.value = emrId appears before descInput.dispatchEvent(...'input').
  const fnMatch = SRC.match(/function fillCid[\s\S]*?(?=\n  \/\*\*|\n  \/\/\s*[-=]{3})/);
  assert.ok(fnMatch, 'fillCid function not found in dom-engine.js');
  const body = fnMatch[0];

  const assignIdx   = body.indexOf("hiddenInput.value = emrId");
  const dispatchIdx = body.indexOf("dispatchEvent(new Event('input'");

  assert.ok(assignIdx !== -1,   "hiddenInput.value = emrId assignment not found in fillCid");
  assert.ok(dispatchIdx !== -1, "dispatchEvent(input) not found in fillCid");
  assert.ok(
    assignIdx < dispatchIdx,
    `hiddenInput.value must be assigned BEFORE the 'input' event is dispatched. ` +
    `(assignIdx=${assignIdx}, dispatchIdx=${dispatchIdx})`
  );
});
