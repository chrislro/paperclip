// scripts/test-med-catalog.js — Catalog integrity tests for the Toca Ficha Dr.
// medication fallback (CHRA-2044 / parent CHRA-1492).
//
// Run with: node --test scripts/test-med-catalog.js
// No deps — uses Node's built-in test runner.
//
// Strategy (mirrors the CID-database check in selftest.sh): parse the real
// `_MED_CATALOG_FALLBACK` object out of popup/popup.src.js and assert the
// catalog is large enough (>=100 meds, the CHRA-1492 gate), well-formed, free
// of duplicate ids, covers both adults and children, keeps pediatric entries
// dose-calc-safe (a concentration in `presentation`), and stays in sync with
// the category sort/label maps. The popup source is ESM (imports Clerk), so we
// extract the object literal as text and evaluate just that literal — exactly
// the data, no module side effects.

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');
const POPUP_SRC = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');

// --- helpers --------------------------------------------------------------

// Return the balanced { ... } object literal that starts at `marker`.
function extractObjectLiteral(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at !== -1, `marker not found: ${marker}`);
  const open = src.indexOf('{', at);
  assert.ok(open !== -1, `object start not found for: ${marker}`);
  let depth = 0, quote = null, escape = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`unbalanced object literal for: ${marker}`);
}

// Evaluate a pure object/array literal of strings/booleans/numbers only.
function evalLiteral(literal) {
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + literal + ');')();
}

const CATALOG = evalLiteral(extractObjectLiteral(POPUP_SRC, 'const _MED_CATALOG_FALLBACK ='));
const CATEGORY_ORDER = evalLiteral(extractObjectLiteral(POPUP_SRC, 'const _CATEGORY_ORDER ='));
const CATEGORY_LABEL = evalLiteral(extractObjectLiteral(POPUP_SRC, 'const _CATEGORY_LABEL ='));

const PEDS   = Array.isArray(CATALOG.pediatric) ? CATALOG.pediatric : [];
const ADULTS = Array.isArray(CATALOG.adult) ? CATALOG.adult : [];
const ALL    = [...PEDS, ...ADULTS];

const REQUIRED_FIELDS = ['id', 'name', 'category', 'frequency', 'duration', 'presentation', 'practical', 'is_adult', 'notes'];

// --- tests ----------------------------------------------------------------

test('catalog has >=100 medications (CHRA-1492 gate)', () => {
  assert.ok(ALL.length >= 100, `expected >=100 meds, got ${ALL.length} (peds=${PEDS.length}, adults=${ADULTS.length})`);
});

test('covers both adults and children', () => {
  assert.ok(PEDS.length >= 20, `too few pediatric entries: ${PEDS.length}`);
  assert.ok(ADULTS.length >= 20, `too few adult entries: ${ADULTS.length}`);
});

test('no duplicate ids', () => {
  const ids = ALL.map((m) => m.id);
  const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dups)], [], `duplicate ids: ${[...new Set(dups)].join(', ')}`);
});

test('every entry has all required fields', () => {
  for (const m of ALL) {
    for (const f of REQUIRED_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(m, f), `${m.id || '?'} missing field "${f}"`);
    }
    assert.ok(typeof m.id === 'string' && m.id.length > 0, `bad id: ${JSON.stringify(m.id)}`);
    assert.ok(typeof m.name === 'string' && m.name.length > 0, `${m.id} bad name`);
  }
});

test('is_adult flag matches the array a med lives in', () => {
  for (const m of PEDS)   assert.equal(m.is_adult, false, `${m.id} in pediatric[] but is_adult!==false`);
  for (const m of ADULTS) assert.equal(m.is_adult, true,  `${m.id} in adult[] but is_adult!==true`);
});

test('pediatric entries stay dose-calc-safe (presentation carries a concentration/form)', () => {
  // Real pediatric doses are weight-bound and computed server-side at apply
  // time; the fallback keeps `practical` as a placeholder but MUST keep a
  // usable concentration/form in `presentation` so the calculator + receita
  // stay accurate. Accept mg, mL, %, UI, "gotas"/"gts", or "supositório".
  const CONC = /\d|%|UI|gota|supos|sol\.|susp|xarope|elixir/i;
  for (const m of PEDS) {
    assert.ok(typeof m.presentation === 'string' && m.presentation.trim().length > 0, `${m.id} empty presentation`);
    assert.ok(CONC.test(m.presentation), `${m.id} presentation lacks a concentration/form: "${m.presentation}"`);
  }
});

test('all categories are known and present in the sort + label maps', () => {
  const used = new Set(ALL.map((m) => m.category));
  for (const c of used) {
    assert.ok(Object.prototype.hasOwnProperty.call(CATEGORY_ORDER, c), `category "${c}" missing from _CATEGORY_ORDER`);
    assert.ok(Object.prototype.hasOwnProperty.call(CATEGORY_LABEL, c), `category "${c}" missing from _CATEGORY_LABEL`);
  }
});

test('essential SUS/RENAME medications are present', () => {
  const ids = new Set(ALL.map((m) => m.id));
  const essentials = [
    'amox_pneum', 'amox_adult',           // amoxicilina
    'amoxclav_adult',                      // amoxicilina + clavulanato
    'azithromycin', 'azitro_adult',        // azitromicina
    'cephalexin', 'cefalex_adult',         // cefalexina
    'metronidazol_ped', 'metronidazol_adult',
    'dipyrone', 'dipyrone_adult',          // dipirona
    'paracetamol', 'paracetamol_adult',
    'ibuprofen', 'ibu_adult',              // ibuprofeno
    'prednisolone', 'predniso_adult',      // corticoides
    'salbutamol_neb',                      // broncodilatador
    'omeprazol_adult',                     // IBP
    'losartana', 'enalapril_adult',        // anti-hipertensivos
    'metformina_adult',                    // antidiabético
    'albendazol_adult', 'mebendazol_adult',// antiparasitários
    'sulfato_ferroso_ped',                 // suplemento pediátrico
  ];
  const missing = essentials.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `missing essential meds: ${missing.join(', ')}`);
});

test('template med refs resolve (default templates point at real catalog ids OR backend ids)', () => {
  // The default templates reference med ids that must exist either in this
  // fallback or in the backend catalog. We only guard the ones the fallback
  // owns so a rename here doesn't silently break the shipped templates.
  const ids = new Set(ALL.map((m) => m.id));
  for (const id of ['paracetamol', 'paracetamol_adult', 'amox_pneum', 'ibuprofen']) {
    assert.ok(ids.has(id), `default template references "${id}" but it is no longer in the catalog`);
  }
});
