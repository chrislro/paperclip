// scripts/test-soap-fence-stripping.js — Tripwires for _stripJsonFences in
// sidepanel/sidepanel-prontuario.js.
//
// The bug this prevents (noted 2026-04-15):
//   The OpenAI format-soap path occasionally returns the SOAP wrapped in a
//   markdown code fence:
//
//     ```json
//     {"subjetivo": "...", "objetivo": "...", ...}
//     ```
//
//   That string lands in state.soapText and gets pasted into G-Hosp +
//   written to the clipboard verbatim. The fences show up inside the
//   wysihtml5 editor and on Cmd+V into other charts — embarrassing in front
//   of a patient. _stripJsonFences trims the outermost fence pair before
//   the SOAP touches G-Hosp or the clipboard.
//
// Run: node --test scripts/test-soap-fence-stripping.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const vm       = require('node:vm');

const SP_SRC = path.join(__dirname, '..', 'sidepanel', 'sidepanel-prontuario.js');

// =====================================================================
// Static-source tripwires
// =====================================================================

test('_stripJsonFences exists in sidepanel-prontuario.js', () => {
  const src = fs.readFileSync(SP_SRC, 'utf8');
  assert.ok(
    /function _stripJsonFences\s*\(/.test(src),
    '_stripJsonFences function must be defined in sidepanel-prontuario.js'
  );
});

test('_stripJsonFences is applied before state.soapText assignment', () => {
  const src = fs.readFileSync(SP_SRC, 'utf8');
  // The fence-strip must run on `soap` (the local) BEFORE it lands in
  // state.soapText. Look for the pattern:
  //   soap = _stripJsonFences(soap);
  //   state.soapText = soap;
  // (or equivalent — the order is the invariant.)
  const stripIdx = src.search(/_stripJsonFences\s*\(\s*soap\s*\)/);
  const assignIdx = src.search(/state\.soapText\s*=\s*soap;/);
  assert.ok(stripIdx !== -1, 'must invoke _stripJsonFences(soap) in the SOAP flow');
  assert.ok(assignIdx !== -1, 'must assign state.soapText = soap somewhere');
  assert.ok(
    stripIdx < assignIdx,
    '_stripJsonFences(soap) MUST run before state.soapText = soap (so G-Hosp + clipboard see clean text)'
  );
});

// =====================================================================
// Behavioral tests — extract the helper and run it in a vm sandbox
// =====================================================================

function _loadStripJsonFences() {
  const src = fs.readFileSync(SP_SRC, 'utf8');
  const fnStart = src.indexOf('function _stripJsonFences(text)');
  assert.ok(fnStart !== -1, '_stripJsonFences must exist');
  // First `\n  }\n` after the start — the function's closing brace at the
  // IIFE-member indent (2 spaces).
  const fnEnd = src.indexOf('\n  }\n', fnStart);
  assert.ok(fnEnd !== -1, 'expected closing brace for _stripJsonFences');
  const fnSrc = src.slice(fnStart, fnEnd + 4);  // include closing brace
  // Wrap so the sandbox exposes the function via the context.
  const wrapped = fnSrc + '\nglobalThis._stripJsonFences = _stripJsonFences;';
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(wrapped, ctx);
  return ctx._stripJsonFences;
}

const _strip = _loadStripJsonFences();

test('returns input unchanged when no fences', () => {
  const txt = 'Subjetivo: queixa de febre. Objetivo: T 38.5C.';
  assert.equal(_strip(txt), txt);
});

test('strips ```json … ``` wrapping', () => {
  const input = '```json\n{"subjetivo": "queixa de febre"}\n```';
  const out = _strip(input);
  assert.equal(out, '{"subjetivo": "queixa de febre"}');
});

test('strips ``` … ``` wrapping (no language tag)', () => {
  const input = '```\nSOAP body here\n```';
  assert.equal(_strip(input), 'SOAP body here');
});

test('strips trailing fence even when leading fence omitted', () => {
  const input = 'SOAP body that the model decided to close anyway\n```';
  assert.equal(_strip(input), 'SOAP body that the model decided to close anyway');
});

test('strips leading fence even when trailing fence omitted', () => {
  const input = '```json\nSOAP body never closed';
  assert.equal(_strip(input), 'SOAP body never closed');
});

test('uppercase ```JSON tag is also stripped', () => {
  // GPT-5.1 has been seen emitting both lowercase and uppercase tags.
  const input = '```JSON\n{"x":1}\n```';
  assert.equal(_strip(input), '{"x":1}');
});

test('inline backticks inside the SOAP body are preserved', () => {
  // No fence — just stray backticks. The trim should leave them alone.
  const input = 'CID `J00` selecionado pelo médico';
  assert.equal(_strip(input), input);
});

test('preserves whitespace inside body, trims only outer wrapping', () => {
  const input = '```json\n  {\n    "x": 1\n  }\n```';
  const out = _strip(input);
  assert.equal(out, '  {\n    "x": 1\n  }');
});

test('null / non-string input returns unchanged', () => {
  assert.equal(_strip(null), null);
  assert.equal(_strip(undefined), undefined);
  assert.deepEqual(_strip([]), []);
});

test('empty string returns empty string', () => {
  assert.equal(_strip(''), '');
});

test('only a fence pair with no body returns empty', () => {
  // Edge case: model emits fences but nothing inside. Output should be
  // empty so downstream "SOAP vazio" status fires correctly.
  assert.equal(_strip('```json\n\n```'), '');
});

test('whitespace before/after the fence is trimmed', () => {
  const input = '  \n```json\n{"x":1}\n```\n  ';
  assert.equal(_strip(input), '{"x":1}');
});

test('does NOT recurse — nested fences are left in the body', () => {
  // Defensive: stripping recursively could corrupt code blocks inside the
  // SOAP body (e.g. a model that paraphrased part of a chart in fences).
  // We only trim the outermost pair.
  const input = '```json\n{"x": "```inner```"}\n```';
  assert.equal(_strip(input), '{"x": "```inner```"}');
});
