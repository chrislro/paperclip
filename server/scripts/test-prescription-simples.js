// scripts/test-prescription-simples.js — static tripwires for the G-Hosp
// Receita Simples bridge path used by side-panel medication mixes.
//
// Run with: node --test scripts/test-prescription-simples.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOM_ENGINE_SRC = fs.readFileSync(path.join(ROOT, 'content/dom-engine.js'), 'utf8');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'content/bridge.js'), 'utf8');

test('dom-engine.js: Simples Inserir selector is semantic, not nth-child/type-submit only', () => {
  const match = DOM_ENGINE_SRC.match(/"prescription_inserir_to_editor":\s*"([^"]+)"/);
  assert.ok(match, 'prescription_inserir_to_editor selector not found');
  assert.match(match[1], /input\[name='commit'\]\[value='Inserir'\]/);
  assert.doesNotMatch(match[1], /nth-child|type=submit/);
});

test('dom-engine.js: _findSimplesInserir falls back to the robust shared insert finder', () => {
  const body = DOM_ENGINE_SRC.match(/function _findSimplesInserir\(\) \{[\s\S]*?\n  \}/);
  assert.ok(body, '_findSimplesInserir function not found');
  assert.match(body[0], /_findInsertButton\(dialog\)/);
});

test('dom-engine.js: Simples mode selection uses configured and semantic selectors', () => {
  const body = DOM_ENGINE_SRC.match(/async function _selectSimplesMode\(maxWaitMs\) \{[\s\S]*?\n  \}/);
  assert.ok(body, '_selectSimplesMode function not found');
  assert.match(body[0], /sel\('prescription_simples'\)/);
  assert.match(body[0], /_labelTextForRadio/);
  assert.match(body[0], /simples\|receita\\s\*simples/);
  assert.match(body[0], /await sleep\(step\)/);
});

test('bridge.js: side-panel Simples path returns the specific dom-engine error', () => {
  assert.match(DOM_ENGINE_SRC, /function getLastSimplesError\(\)/);
  assert.match(DOM_ENGINE_SRC, /getLastSimplesError,/);
  assert.match(BRIDGE_SRC, /SIDEPANEL_RUN_SIMPLES_WITH_BODY[\s\S]*getLastSimplesError/);
  assert.match(BRIDGE_SRC, /SIDEPANEL_RUN_TEMPLATE[\s\S]*getLastSimplesError/);
});

test('dom-engine.js: prescription link uses configured selector with multi-strategy fallback', () => {
  assert.match(DOM_ENGINE_SRC, /function _findPrescriptionLink\(\)/);
  assert.match(DOM_ENGINE_SRC, /function _waitForPrescriptionLink\(/);
  // Simples selector getter uses sel() instead of hardcoded string.
  assert.match(DOM_ENGINE_SRC, /case 'open_link':\s*return sel\('prescription_link'\)/);
  // runSimplesPrescription calls the robust finder
  const runBody = DOM_ENGINE_SRC.match(/async function runSimplesPrescription\(template\) \{[\s\S]*?openLink\.click/);
  assert.ok(runBody, 'runSimplesPrescription not found');
  assert.match(runBody[0], /_findPrescriptionLink\(\)/);
  assert.match(runBody[0], /_waitForPrescriptionLink\(/);
  // openPrescription also uses the robust finder
  const openBody = DOM_ENGINE_SRC.match(/async function openPrescription\(\) \{[\s\S]*?trigger\.click/);
  assert.ok(openBody, 'openPrescription not found');
  assert.match(openBody[0], /_findPrescriptionLink\(\)/);
  assert.match(openBody[0], /_waitForPrescriptionLink\(/);
  assert.doesNotMatch(DOM_ENGINE_SRC, /rxLinkSel/);
});
