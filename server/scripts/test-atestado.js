// scripts/test-atestado.js — Tests for the v3.5 Atestado drawer changes:
// chip order/labels (Mãe, Pai, Outro), no-default-pick semantics,
// companion-mode validation in three files, the structural Gravar selector,
// the _composeCompanionObs branches, and the _parseCompanionText extraction.
//
// Run with: node --test scripts/test-atestado.js
// No deps — uses Node's built-in test runner.
//
// Strategy: behavior is verified against hand-mirrored copies of the pure
// functions (kept identical line-for-line to dom-engine.js), and source-
// parity guards catch drift between the shadows and production. Both halves
// must hold: shadows test behavior, source asserts confirm the production
// code still has the expected branch shape.

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOM_ENGINE_SRC      = fs.readFileSync(path.join(ROOT, 'content/dom-engine.js'), 'utf8');
const BRIDGE_SRC          = fs.readFileSync(path.join(ROOT, 'content/bridge.js'),     'utf8');
const SIDEPANEL_HTML      = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
const SIDEPANEL_PRONT_SRC = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel-prontuario.js'), 'utf8');

// =====================================================================
// Shadows of dom-engine.js pure helpers — kept identical so unit tests
// exercise the actual logic. Source-parity guards below catch drift.
// =====================================================================

function _composeCompanionObs(companions, mode) {
  if (mode !== 'mae' && mode !== 'pai' && mode !== 'outro') return '';
  const c = companions || { mother: '', father: '' };
  if (mode === 'mae') {
    return c.mother ? ('Acompanhante Mãe: ' + c.mother) : '';
  }
  if (mode === 'pai') {
    return c.father ? ('Acompanhante Pai: ' + c.father) : '';
  }
  const lines = [];
  if (c.mother) lines.push('Mãe: ' + c.mother);
  if (c.father) lines.push('Pai: ' + c.father);
  if (!lines.length) return '';
  return 'Acompanhante:\n' + lines.join('\n');
}

function _parseCompanionText(text) {
  if (!text || typeof text !== 'string') return { mother: '', father: '' };
  const NEXT_LABEL = '(?=\\s*(?:Pai|M[ãa]e|Nasc(?:imento)?|Idade|Resp(?:ons[áa]vel)?|Sexo|CPF|RG|Endereço)\\s*:|$)';
  const motherMatch = text.match(new RegExp('M[ãa]e\\s*:\\s*([\\s\\S]+?)' + NEXT_LABEL, 'i'));
  const fatherMatch = text.match(new RegExp('Pai\\s*:\\s*([\\s\\S]+?)'    + NEXT_LABEL, 'i'));
  const motherRaw = motherMatch ? motherMatch[1].trim() : '';
  const fatherRaw = fatherMatch ? fatherMatch[1].trim() : '';
  return {
    mother: _looksLikeRealName(motherRaw) ? motherRaw : '',
    father: _looksLikeRealName(fatherRaw) ? fatherRaw : '',
  };
}

function _looksLikeRealName(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (/[<>\\]/.test(t)) return false;
  if (/[\n\r]/.test(t)) return false;
  if (!/[A-Za-zÀ-ÿ]/.test(t)) return false;
  return true;
}

// =====================================================================
// Source-shadow parity guards
// =====================================================================

function extractFunctionFromSource(source, name) {
  const startToken = `function ${name}(`;
  const start = source.indexOf(startToken);
  if (start === -1) throw new Error(`function ${name} not found in source`);
  // Function close brace at indentation 2 (the IIFE-internal scope).
  const end = source.indexOf('\n  }', start);
  if (end === -1) throw new Error(`function ${name} close brace not found`);
  return source.slice(start, end + 4);
}

// Canonical form for parity comparisons: strip block + line comments and
// collapse whitespace. Production source carries explanatory comments that
// the shadow doesn't need; this normalization keeps the parity guard about
// logic, not documentation. (Safe for our specific functions — no `//` or
// `/* */` patterns appear inside string or regex literals here.)
const canonical = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

test('source parity: shadow _composeCompanionObs matches production source', () => {
  const productionSrc = extractFunctionFromSource(DOM_ENGINE_SRC, '_composeCompanionObs');
  assert.equal(canonical(_composeCompanionObs.toString()), canonical(productionSrc),
    'shadow _composeCompanionObs in test-atestado.js has drifted from dom-engine.js — update both together');
});

test('source parity: shadow _parseCompanionText matches production source', () => {
  const productionSrc = extractFunctionFromSource(DOM_ENGINE_SRC, '_parseCompanionText');
  assert.equal(canonical(_parseCompanionText.toString()), canonical(productionSrc),
    'shadow _parseCompanionText in test-atestado.js has drifted from dom-engine.js — update both together');
});

test('source parity: shadow _looksLikeRealName matches production source', () => {
  const productionSrc = extractFunctionFromSource(DOM_ENGINE_SRC, '_looksLikeRealName');
  assert.equal(canonical(_looksLikeRealName.toString()), canonical(productionSrc),
    'shadow _looksLikeRealName in test-atestado.js has drifted from dom-engine.js — update both together');
});

// =====================================================================
// _composeCompanionObs — pure-function unit tests
// =====================================================================

test('_composeCompanionObs: null mode → empty (patient-only, no obs written)', () => {
  assert.equal(_composeCompanionObs({ mother: 'Joana', father: 'Carlos' }, null), '');
});

test('_composeCompanionObs: undefined mode → empty', () => {
  assert.equal(_composeCompanionObs({ mother: 'Joana', father: 'Carlos' }, undefined), '');
});

test('_composeCompanionObs: legacy general mode → empty (no longer migrated)', () => {
  // Pre-v3.5 callers may still send 'general'; v3.5+ rejects it as unknown
  // so the obs is left untouched (caller skips the obs-write step).
  assert.equal(_composeCompanionObs({ mother: 'Joana', father: 'Carlos' }, 'general'), '');
});

test('_composeCompanionObs: mae mode + mother present → single-line obs', () => {
  const out = _composeCompanionObs({ mother: 'Joana Silva', father: 'Carlos Silva' }, 'mae');
  assert.equal(out, 'Acompanhante Mãe: Joana Silva');
});

test('_composeCompanionObs: mae mode + mother missing → empty (caller leaves obs untouched)', () => {
  assert.equal(_composeCompanionObs({ mother: '', father: 'Carlos' }, 'mae'), '');
});

test('_composeCompanionObs: pai mode + father present → single-line obs', () => {
  const out = _composeCompanionObs({ mother: 'Joana', father: 'Carlos Silva' }, 'pai');
  assert.equal(out, 'Acompanhante Pai: Carlos Silva');
});

test('_composeCompanionObs: pai mode + father missing → empty', () => {
  assert.equal(_composeCompanionObs({ mother: 'Joana', father: '' }, 'pai'), '');
});

test('_composeCompanionObs: outro mode + both parents → stacked obs', () => {
  const out = _composeCompanionObs({ mother: 'Joana', father: 'Carlos' }, 'outro');
  assert.equal(out, 'Acompanhante:\nMãe: Joana\nPai: Carlos');
});

test('_composeCompanionObs: outro mode + only mother → mother-only stacked obs', () => {
  const out = _composeCompanionObs({ mother: 'Joana', father: '' }, 'outro');
  assert.equal(out, 'Acompanhante:\nMãe: Joana');
});

test('_composeCompanionObs: outro mode + only father → father-only stacked obs', () => {
  const out = _composeCompanionObs({ mother: '', father: 'Carlos' }, 'outro');
  assert.equal(out, 'Acompanhante:\nPai: Carlos');
});

test('_composeCompanionObs: outro mode + neither parent → empty', () => {
  assert.equal(_composeCompanionObs({ mother: '', father: '' }, 'outro'), '');
});

test('_composeCompanionObs: null companions argument is safe', () => {
  // The IIFE caller passes the result of extractCompanionInfo() which can
  // return an empty object when the patient header parse fails.
  assert.equal(_composeCompanionObs(null, 'mae'),    '');
  assert.equal(_composeCompanionObs(undefined, 'outro'), '');
});

// =====================================================================
// _parseCompanionText — pure-function unit tests
// =====================================================================

test('_parseCompanionText: well-formed multi-line → both names extracted', () => {
  const text = 'Mãe: JESSICA DORNELES DE VARGAS\nPai: JEVERTON LIMA DE VARGAS';
  assert.deepEqual(_parseCompanionText(text), {
    mother: 'JESSICA DORNELES DE VARGAS',
    father: 'JEVERTON LIMA DE VARGAS',
  });
});

test('_parseCompanionText: single-line text (no newlines, just spaces) → both names extracted', () => {
  // The bug-driving case: textContent of <small>Mãe:JESSICA<br>Pai:JEVERTON</small>
  // collapses to "Mãe: JESSICA Pai: JEVERTON" with no newline. Pass 1 fails;
  // Pass 2 (anchorless lookahead) catches both.
  const text = 'Mãe: JESSICA DORNELES Pai: JEVERTON LIMA';
  assert.deepEqual(_parseCompanionText(text), {
    mother: 'JESSICA DORNELES',
    father: 'JEVERTON LIMA',
  });
});

test('_parseCompanionText: single-line with NO whitespace between fields → both names extracted', () => {
  // Even tighter — innerText fallback to textContent on a stripped DOM:
  // "Mãe: JESSICAPai: JEVERTON". The lookahead boundary still matches.
  const text = 'Mãe: JESSICAPai: JEVERTON';
  // Without a separator, the lookahead matches at "Pai:" so mother captures
  // "JESSICA"; father then captures "JEVERTON" up to end-of-string.
  const result = _parseCompanionText(text);
  assert.equal(result.mother, 'JESSICA');
  assert.equal(result.father, 'JEVERTON');
});

test('_parseCompanionText: extra G-Hosp labels around the names → captures stop at boundaries', () => {
  // The patient header often includes Nasc / Idade / Resp / Sexo siblings.
  // The Pass-2 lookahead boundary list must keep mother/father from slurping
  // them.
  const text = [
    'Paciente: JOÃOZINHO',
    'Mãe: JESSICA DORNELES',
    'Nasc: 2020-01-01',
    'Pai: JEVERTON LIMA',
    'Idade: 6 anos',
  ].join('\n');
  const r = _parseCompanionText(text);
  assert.equal(r.mother, 'JESSICA DORNELES');
  assert.equal(r.father, 'JEVERTON LIMA');
});

test('_parseCompanionText: accent-tolerant — "Mae:" without tilde still works', () => {
  const text = 'Mae: JESSICA\nPai: JEVERTON';
  assert.deepEqual(_parseCompanionText(text), { mother: 'JESSICA', father: 'JEVERTON' });
});

test('_parseCompanionText: only mother present → father empty', () => {
  assert.deepEqual(_parseCompanionText('Mãe: JESSICA\nNasc: 2020'),
    { mother: 'JESSICA', father: '' });
});

test('_parseCompanionText: only father present → mother empty', () => {
  assert.deepEqual(_parseCompanionText('Pai: JEVERTON\nNasc: 2020'),
    { mother: '', father: 'JEVERTON' });
});

test('_parseCompanionText: text without parent labels → both empty', () => {
  assert.deepEqual(_parseCompanionText('Paciente: JOÃOZINHO\nNasc: 2020'),
    { mother: '', father: '' });
});

test('_parseCompanionText: empty / null / non-string input → empty result, no throw', () => {
  assert.deepEqual(_parseCompanionText(''),        { mother: '', father: '' });
  assert.deepEqual(_parseCompanionText(null),      { mother: '', father: '' });
  assert.deepEqual(_parseCompanionText(undefined), { mother: '', father: '' });
  assert.deepEqual(_parseCompanionText(42),        { mother: '', father: '' });
});

test('_parseCompanionText: trailing whitespace and CRLF line endings are handled', () => {
  const text = 'Mãe: JESSICA   \r\nPai:   JEVERTON\r\n';
  assert.deepEqual(_parseCompanionText(text),
    { mother: 'JESSICA', father: 'JEVERTON' });
});

// =====================================================================
// _looksLikeRealName + post-validation in _parseCompanionText
// =====================================================================

test('_looksLikeRealName: real Portuguese names pass', () => {
  assert.equal(_looksLikeRealName('JESSICA DORNELES DE VARGAS'), true);
  assert.equal(_looksLikeRealName('Joana'),                       true);
  assert.equal(_looksLikeRealName("Maria-João da Silva"),         true);
  assert.equal(_looksLikeRealName('Ângela Müller'),               true);
});

test('_looksLikeRealName: HTML tag chars (<, >, \\) are rejected', () => {
  assert.equal(_looksLikeRealName('</div> LARISSA'),                       false);
  assert.equal(_looksLikeRealName('<\\/div>\\n LARISSA'),                  false);
  assert.equal(_looksLikeRealName('<span>JESSICA</span>'),                 false);
});

test('_looksLikeRealName: multi-line capture is rejected', () => {
  // If a name capture contains a newline after trim, the regex slurped
  // past the actual name into the next field. Reject.
  assert.equal(_looksLikeRealName('JESSICA\nMORE TEXT'),       false);
  assert.equal(_looksLikeRealName('JESSICA\r\nMORE TEXT'),     false);
});

test('_looksLikeRealName: too long (>80 chars) is rejected', () => {
  assert.equal(_looksLikeRealName('A'.repeat(81)), false);
  assert.equal(_looksLikeRealName('A'.repeat(80)), true);
});

test('_looksLikeRealName: empty / non-letter / null inputs are rejected', () => {
  assert.equal(_looksLikeRealName(''),         false);
  assert.equal(_looksLikeRealName('   '),      false);
  assert.equal(_looksLikeRealName('123456'),   false);  // no letters
  assert.equal(_looksLikeRealName(null),       false);
  assert.equal(_looksLikeRealName(undefined),  false);
  assert.equal(_looksLikeRealName(42),         false);
});

test('_parseCompanionText: garbage capture (HTML/escapes after Mãe:) → returns empty mother', () => {
  // Live-bug repro: Strategy 4 walked a <script> with JS-template source.
  // _parseCompanionText would naively capture the JS escape sequences as
  // a "name." Post-validation now rejects it.
  const text = 'Mãe: <\\/div>\\n LARISSA <\\/div>\\n CHRISTIAN LUIS RODRIGUES';
  assert.deepEqual(_parseCompanionText(text), { mother: '', father: '' });
});

test('_parseCompanionText: capture-runs-to-end (no Pai: boundary) → returns empty if too long', () => {
  // Without a Pai: anchor, the regex captures all the way to end of text.
  // For a real label "Mãe: JESSICA" with no Pai after, the capture is short
  // and valid. For a label followed by hundreds of UI chars, validation
  // rejects it.
  const text = 'Mãe: JESSICA';
  assert.deepEqual(_parseCompanionText(text), { mother: 'JESSICA', father: '' });
  const longGarbage = 'Mãe: ' + 'X'.repeat(200);
  assert.deepEqual(_parseCompanionText(longGarbage), { mother: '', father: '' });
});

// =====================================================================
// Strategy 4 — code-bearing tag skip
// =====================================================================

test('dom-engine.js: Strategy 4 skips SCRIPT / STYLE / TEMPLATE / NOSCRIPT tags', () => {
  // Tripwire — the live bug came from Strategy 4 walking a <script> tag
  // with JS-template source. These tags must be skipped.
  const fnSrc = extractFunctionFromSource(DOM_ENGINE_SRC, 'extractCompanionInfo');
  for (const tag of ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']) {
    assert.ok(new RegExp("'" + tag + "'").test(fnSrc),
      `Strategy 4 must explicitly skip <${tag}> elements`);
  }
});

// =====================================================================
// HTML chip integrity — order, labels, default-selected (NONE)
// =====================================================================

test('sidepanel.html: companion chips appear in order Mãe → Pai', () => {
  // v3.5 (post-removal): only Mãe and Pai chips remain. Outro was removed
  // per UX feedback — atestados are typically for one parent, not stacked.
  const block = SIDEPANEL_HTML.match(/id="sp-atestado-companion-chips"[\s\S]*?<\/div>/);
  assert.ok(block, 'companion-chips container not found');
  const html = block[0];
  const idxMae = html.indexOf('data-companion="mae"');
  const idxPai = html.indexOf('data-companion="pai"');
  assert.ok(idxMae > -1, 'data-companion="mae" missing');
  assert.ok(idxPai > -1, 'data-companion="pai" missing');
  assert.ok(idxMae < idxPai, 'chip order must be mae → pai');
});

test('sidepanel.html: legacy data-companion="general" chip is removed', () => {
  const block = SIDEPANEL_HTML.match(/id="sp-atestado-companion-chips"[\s\S]*?<\/div>/);
  assert.ok(block);
  assert.equal(block[0].includes('data-companion="general"'), false,
    'the legacy "Acompanhante" chip with data-companion="general" must not remain');
});

test('sidepanel.html: data-companion="outro" chip is removed (v3.5 cleanup)', () => {
  const block = SIDEPANEL_HTML.match(/id="sp-atestado-companion-chips"[\s\S]*?<\/div>/);
  assert.ok(block);
  assert.equal(block[0].includes('data-companion="outro"'), false,
    'the Outro chip must not remain in the drawer (per UX feedback)');
});

test('sidepanel.html: chip labels are "Mãe", "Pai" in order', () => {
  const block = SIDEPANEL_HTML.match(/id="sp-atestado-companion-chips"[\s\S]*?<\/div>/)[0];
  const labels = [...block.matchAll(/data-companion="(mae|pai)"[^>]*>([^<]+)</g)]
    .map(m => [m[1], m[2].trim()]);
  assert.deepEqual(labels, [['mae', 'Mãe'], ['pai', 'Pai']]);
});

test('sidepanel.html: no chip carries the default "selected" class (no auto-pick)', () => {
  // v3.5: drawer opens with no chip selected — atestado defaults to
  // patient-only. The doctor opts into a companion mode by clicking.
  const block = SIDEPANEL_HTML.match(/id="sp-atestado-companion-chips"[\s\S]*?<\/div>/)[0];
  const buttons = block.match(/<button[^>]*data-companion="(?:mae|pai)"[^>]*>/g) || [];
  assert.equal(buttons.length, 2, 'expected exactly 2 companion chips (Mãe + Pai)');
  for (const b of buttons) {
    assert.equal(/\bclass="[^"]*\bselected\b[^"]*"/.test(b), false,
      `chip must not be default-selected: ${b}`);
  }
});

// =====================================================================
// Validation invariants — accepted modes, no auto-pick, no legacy migration
// =====================================================================

const VALIDATION_TARGETS = [
  ['content/bridge.js',                      BRIDGE_SRC],
  ['content/dom-engine.js',                  DOM_ENGINE_SRC],
  ['sidepanel/sidepanel-prontuario.js',      SIDEPANEL_PRONT_SRC],
];

for (const [label, src] of VALIDATION_TARGETS) {
  test(`${label}: validates against 'mae', 'pai', and 'outro'`, () => {
    assert.ok(/=== ?'mae'/.test(src),   `'mae' comparison missing from ${label}`);
    assert.ok(/=== ?'pai'/.test(src),   `'pai' comparison missing from ${label}`);
    assert.ok(/=== ?'outro'/.test(src), `'outro' comparison missing from ${label}`);
  });

  test(`${label}: legacy 'general' migration is removed (no longer auto-picks)`, () => {
    // The pre-v3.5-rev2 migration was `mode === 'general' ? 'outro' : mode`.
    // v3.5+ resets legacy 'general' to null (no chip picked), so this exact
    // pattern must not appear anywhere in the validation files.
    assert.equal(/=== ?'general' ?\? ?'outro'/.test(src), false,
      `legacy "=== 'general' ? 'outro'" migration must be removed from ${label}`);
  });
}

test("sidepanel-prontuario.js: state default is atestadoCompanionMode: null", () => {
  // The state-block initializer must set the default to null so the drawer
  // opens with no chip selected.
  assert.ok(
    /atestadoCompanionMode:\s*null/.test(SIDEPANEL_PRONT_SRC),
    "expected `atestadoCompanionMode: null` in the state block (no auto-pick)"
  );
  // No stray non-null defaults from previous revisions.
  assert.equal(/atestadoCompanionMode:\s*'(general|mae|pai|outro)'/.test(SIDEPANEL_PRONT_SRC), false,
    "non-null `atestadoCompanionMode: '<mode>'` default must not remain"
  );
});

test('sidepanel-prontuario.js: click handler supports toggle-off (click selected chip → null)', () => {
  // The click handler must check whether the clicked chip is already the
  // active mode and, if so, call _setCompanionMode(null) instead of
  // re-setting the same mode.
  assert.ok(
    /=== state\.atestadoCompanionMode\s*\?\s*null\s*:/.test(SIDEPANEL_PRONT_SRC),
    "expected `m === state.atestadoCompanionMode ? null : m` toggle-off branch"
  );
});

test('sidepanel-prontuario.js: atestadoCompanionMode is NOT persisted to chrome.storage.sync', () => {
  // Tripwire — guards against re-introducing the auto-pick bug. Persisting
  // the companion mode caused the previous regression: pre-v3.5 storage
  // contained 'mae' (auto-saved on every drawer open), and reading it back
  // resurrected the auto-pick on every side-panel reload, defeating the
  // "no auto-pick" rule. Companion mode must remain session-only.
  assert.equal(
    /storage\.sync\.set\([^)]*atestadoCompanionMode/.test(SIDEPANEL_PRONT_SRC), false,
    'atestadoCompanionMode must not be written to chrome.storage.sync'
  );
  assert.equal(
    /storage\.sync\.get\([^)]*atestadoCompanionMode/.test(SIDEPANEL_PRONT_SRC), false,
    'atestadoCompanionMode must not be read from chrome.storage.sync'
  );
});

// =====================================================================
// dom-engine.js — runAtestadoFull short-circuits on null mode
// =====================================================================

test('dom-engine.js: runAtestadoFull guards Step 5 with `mode !== null`', () => {
  // null mode must skip the obs-write block entirely so atestado is
  // patient-only.
  assert.ok(/if\s*\(\s*mode\s*!==\s*null\s*\)\s*\{[\s\S]*extractCompanionInfo\(\)/.test(DOM_ENGINE_SRC),
    'expected `if (mode !== null) { … extractCompanionInfo() … }` guard around Step 5');
});

// =====================================================================
// extractCompanionInfo — uses innerText with textContent fallback
// =====================================================================

test('dom-engine.js: extractCompanionInfo prefers innerText over textContent', () => {
  // innerText respects <br> as visual newlines; textContent does not. Without
  // this swap, single-line patient headers collapse and the line-anchored
  // regex misses both names.
  const fnSrc = extractFunctionFromSource(DOM_ENGINE_SRC, 'extractCompanionInfo');
  assert.ok(/innerText/.test(fnSrc),
    'extractCompanionInfo must reference node.innerText to handle <br>-separated patient headers');
  assert.ok(/textContent/.test(fnSrc),
    'extractCompanionInfo must keep textContent as a fallback');
});

test('dom-engine.js: extractCompanionInfo includes the full-element-walk fallback', () => {
  // Strategy 4 — when CSS / XPath / <small>-walk all miss, walk every
  // element on the page and parse-test each. Required because G-Hosp
  // can render parent info inside elements other than <small>.
  const fnSrc = extractFunctionFromSource(DOM_ENGINE_SRC, 'extractCompanionInfo');
  assert.ok(/getElementsByTagName/.test(fnSrc),
    'expected getElementsByTagName-based full-element-walk fallback');
  assert.ok(/full-element-walk/.test(fnSrc),
    'expected the full-element-walk strategy to be listed in strategiesTried');
});

test('dom-engine.js: extractCompanionInfo is async (uses await)', () => {
  // Strategy 5 (demographics fetch) is async, so the wrapper must be too.
  // Both bridge.js and runAtestadoFull rely on awaiting the result.
  assert.ok(/async function extractCompanionInfo\(/.test(DOM_ENGINE_SRC),
    'extractCompanionInfo must be declared async');
  assert.ok(/await\s+extractCompanionInfo\(\)/.test(DOM_ENGINE_SRC),
    'runAtestadoFull must await extractCompanionInfo()');
});

test('dom-engine.js: demographics fetch uses structural fieldset>small>div label-match', () => {
  // The user-confirmed live DOM has parent names at
  //   #ui-id-3 > fieldset > small > div:nth-child(8/10)
  // We translate the fragile :nth-child positions into a label-match scan
  // over fieldset > small > direct-child divs. Tripwires the selector
  // shape so a refactor doesn't quietly drop the structural narrowness.
  assert.ok(/querySelectorAll\(['"]fieldset small.*small['"]\)/.test(DOM_ENGINE_SRC) ||
            /querySelectorAll\(['"]fieldset small[^'"]*['"]\)/.test(DOM_ENGINE_SRC),
    'expected querySelectorAll over `fieldset small` containers in demographics fetch');
  assert.ok(/:scope\s*>\s*div/.test(DOM_ENGINE_SRC),
    'expected `:scope > div` to constrain to direct children of <small>');
  assert.ok(/\^M\[ãa\]e\\s\*:\\s\*\(\.\+\)\$/.test(DOM_ENGINE_SRC),
    'expected an anchored ^Mãe:value$ regex for div-by-div label match');
  assert.ok(/\^Pai\\s\*:\\s\*\(\.\+\)\$/.test(DOM_ENGINE_SRC),
    'expected an anchored ^Pai:value$ regex for div-by-div label match');
});

test('dom-engine.js: _fetchCompanionInfoFromDemographics hits /pr/shared/{id}/get_dados_paciente', () => {
  // Strategy 5 — same-origin fetch to G-Hosp's demographics partial. The
  // consultation screen lacks Mãe:/Pai: but this endpoint has it.
  assert.ok(/async function _fetchCompanionInfoFromDemographics\(/.test(DOM_ENGINE_SRC),
    'expected an async _fetchCompanionInfoFromDemographics helper');
  assert.ok(/\/pr\/shared\//.test(DOM_ENGINE_SRC) && /get_dados_paciente/.test(DOM_ENGINE_SRC),
    'expected the demographics URL pattern /pr/shared/{intern_id}/get_dados_paciente');
  assert.ok(/credentials:\s*['"]same-origin['"]/.test(DOM_ENGINE_SRC),
    "fetch must use { credentials: 'same-origin' } so the doctor's session cookie is sent");
});

test('dom-engine.js: demographics-fetch result is cached by intern_id', () => {
  // Cache prevents re-fetching when the doctor toggles chips on the same
  // patient. Plain Map is fine because content scripts reload on every
  // patient change anyway.
  assert.ok(/_companionInfoCache\s*=\s*new Map\(\)/.test(DOM_ENGINE_SRC),
    'expected a module-level _companionInfoCache Map');
  assert.ok(/_companionInfoCache\.set\(/.test(DOM_ENGINE_SRC),
    'fetch helper must populate the cache');
  assert.ok(/_companionInfoCache\.get\(|_companionInfoCache\.has\(/.test(DOM_ENGINE_SRC),
    'fetch helper must consult the cache before fetching');
});

test('content/bridge.js: SIDEPANEL_GET_COMPANION_INFO is async and awaits extractCompanionInfo', () => {
  assert.ok(/'SIDEPANEL_GET_COMPANION_INFO':\s*async\s*\(\)/.test(BRIDGE_SRC),
    "SIDEPANEL_GET_COMPANION_INFO handler must be declared async");
  assert.ok(/await window\.TOCAFICHADR_dom\.extractCompanionInfo\(\)/.test(BRIDGE_SRC),
    'bridge handler must await extractCompanionInfo');
});

// =====================================================================
// BUNDLED_SELECTORS.presatestado_save — structural Gravar selector
// =====================================================================

test('dom-engine.js: BUNDLED_SELECTORS.presatestado_save includes the structural Gravar path', () => {
  const STRUCTURAL = '#new_presatestado > div.clear.row.mt15 > div > input[type=submit]';
  const block = DOM_ENGINE_SRC.match(/"presatestado_save":\s*"([^"]+)"/);
  assert.ok(block, 'presatestado_save entry not found in BUNDLED_SELECTORS');
  const value = block[1];
  assert.ok(value.includes(STRUCTURAL),
    `presatestado_save must include the structural path; got: ${value}`);
});

test('dom-engine.js: presatestado_save retains value=Gravar fallback for resilience', () => {
  const block = DOM_ENGINE_SRC.match(/"presatestado_save":\s*"([^"]+)"/)[1];
  assert.ok(block.includes("value='Gravar'") || block.includes('value="Gravar"'),
    'expected value=Gravar fallback to remain in the comma-chained selector');
});
