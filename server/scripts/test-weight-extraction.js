// scripts/test-weight-extraction.js — CHRA-2423 Bug 79
//
// Run with: node --test scripts/test-weight-extraction.js
//
// Guards content/dom-engine.js `_getPatientWeight()` weight extraction against
// the real-world G-Hosp display formats it MUST parse for a *pediatric* EMR.
//
// The bug: every "Peso" pattern in weight_patterns required EITHER a decimal
// separator (`\d+[.,]\d*`) OR a trailing `kg`/`Kg` unit, and the only
// integer-tolerant pattern (`peso\s+(\d+)`) required whitespace — not a colon —
// right after "peso". So a colon-prefixed bare integer could not be matched:
//
//   "Peso: 3960"  (neonatal weight in grams — the exact form dom-engine.js's
//                  own comment + `_normalizeWeight` grams→kg branch were built
//                  for) → NO MATCH → weight null → HUD shows "— kg" and the
//                  grams→kg conversion is dead code.
//   "Peso: 15"    (a 15 kg toddler, integer kg, no unit) → NO MATCH.
//
// Weight feeds the per-kg dosage calculator (getDosages(weight) →
// /api/dosages/full?weight=). Failing to extract a neonate's weight is exactly
// the population where weight-based dosing matters most. The failure is
// fail-SAFE (null weight → no auto-dose, doctor types it), but a documented
// feature silently not working for neonates is a real defect.
//
// This test loads the SHIPPED weight_patterns from content/selectors.json and
// runs the SAME match+normalize algorithm dom-engine.js uses, so it exercises
// the actual regex data, not a copy. (test-selector-config-parity.js already
// guarantees the 3 selector copies — content/selectors.json, the dom-engine.js
// BUNDLED_SELECTORS literal, and backend/data/selectors/ghosp.json — are
// value-identical, so asserting against one covers all three.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadWeightPatterns() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'content/selectors.json'), 'utf8'));
  const patterns = raw && raw.selectors && raw.selectors.weight_patterns;
  assert.ok(Array.isArray(patterns) && patterns.length > 0,
    'content/selectors.json must define a non-empty weight_patterns array');
  return patterns;
}

// Faithful port of dom-engine.js `_normalizeWeight` (kg bounds + grams→kg).
const WEIGHT_KG_MAX = 250;
const WEIGHT_KG_MIN = 0.4;
function normalizeWeight(rawValue) {
  if (rawValue === null || rawValue === undefined || Number.isNaN(rawValue)) return null;
  let kg = rawValue;
  if (kg > WEIGHT_KG_MAX) kg = kg / 1000; // grams → kg (e.g. neonatal "3960")
  if (kg < WEIGHT_KG_MIN) return null;
  return kg;
}

// Faithful port of dom-engine.js `_getPatientWeight` matching loop: first
// pattern that yields a normalizable kg wins. `replace(',', '.')` mirrors the
// source (only the first comma — fine for decimal-comma weights like "12,5").
function extractWeight(text, patterns) {
  for (let i = 0; i < patterns.length; i++) {
    let pattern;
    try {
      pattern = new RegExp(patterns[i], 'i');
    } catch (_) {
      continue; // a malformed pattern must not crash extraction
    }
    const match = text.match(pattern);
    if (match && match[1]) {
      const raw = parseFloat(match[1].replace(',', '.'));
      const kg = normalizeWeight(raw);
      if (kg !== null) return kg;
    }
  }
  return null;
}

const PATTERNS = loadWeightPatterns();
const approx = (a, b) => Math.abs(a - b) < 1e-9;

test('Bug 79 — neonatal weight shown in grams as "Peso: 3960" extracts as 3.96 kg', () => {
  const kg = extractWeight('Triagem Peso: 3960 Idade: 12d', PATTERNS);
  assert.ok(kg !== null, '"Peso: 3960" must extract a weight (neonatal grams form)');
  assert.ok(approx(kg, 3.96), `expected 3.96 kg, got ${kg}`);
});

test('Bug 79 — integer kg weight "Peso: 15" (no decimal, no unit) extracts as 15 kg', () => {
  const kg = extractWeight('Paciente Peso: 15 Sexo: M', PATTERNS);
  assert.ok(kg !== null, '"Peso: 15" must extract a weight (integer kg form)');
  assert.ok(approx(kg, 15), `expected 15 kg, got ${kg}`);
});

// --- Regression guards: the fix must not break the formats that already work,
//     and must not let an integer pattern shadow a decimal one. ---

test('decimal-comma weight "Peso: 12,5 kg" stays 12.5 (NOT truncated to 12)', () => {
  const kg = extractWeight('Peso: 12,5 kg', PATTERNS);
  assert.ok(approx(kg, 12.5),
    `expected 12.5 kg — a regression to 12 means an integer pattern shadowed the `
    + `decimal one; got ${kg}`);
});

test('decimal-dot weight "Peso: 3.960" (grams w/ separator) stays 3.96', () => {
  assert.ok(approx(extractWeight('Peso: 3.960', PATTERNS), 3.96));
});

test('unit-suffixed integer "Peso: 15 kg" stays 15', () => {
  assert.ok(approx(extractWeight('Peso: 15 kg', PATTERNS), 15));
});

test('no-colon integer "Peso 8500" → grams→kg = 8.5', () => {
  assert.ok(approx(extractWeight('Peso 8500 gramas', PATTERNS), 8.5));
});

test('implausible/garbage weight "Peso: 0" is rejected (null)', () => {
  assert.equal(extractWeight('Peso: 0', PATTERNS), null);
});

test('text with no weight at all → null', () => {
  assert.equal(extractWeight('Nenhum dado de peso aqui', PATTERNS), null);
});
