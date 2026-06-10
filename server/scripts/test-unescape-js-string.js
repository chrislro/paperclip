// scripts/test-unescape-js-string.js — Regression test for _unescapeJsString
// Run with: node --test scripts/test-unescape-js-string.js
//
// Regression: space was used as a temp marker for \\, so any space in the
// input (e.g. "Mãe: LARISSA") was corrupted to a backslash. Fix: use \x00.

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'content', 'dom-engine.js'), 'utf8');

// Extract _unescapeJsString from dom-engine.js and eval it.
function loadFn() {
  const startIdx = src.indexOf('function _unescapeJsString(s)');
  assert.ok(startIdx >= 0, '_unescapeJsString not found in dom-engine.js');
  let depth = 0, i = startIdx;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src.slice(startIdx, i + 1) + ')')();
}

const unescape = loadFn();

test('_unescapeJsString: spaces in input are NOT converted to backslashes', () => {
  // Regression: old code used space as temp marker for \\, destroying all spaces.
  const result = unescape('<div>Mãe: LARISSA</div>');
  assert.ok(result.includes('Mãe: LARISSA'), 'space corrupted: ' + JSON.stringify(result));
  assert.ok(!result.includes('Mãe:\\'), 'space-to-backslash bug present: ' + JSON.stringify(result));
});

test('_unescapeJsString: escaped slash \\/ becomes /', () => {
  assert.equal(unescape('<\\/div>'), '</div>');
});

test('_unescapeJsString: escaped newline \\n becomes newline', () => {
  assert.equal(unescape('a\\nb'), 'a\nb');
});

test('_unescapeJsString: double-backslash \\\\ becomes single backslash', () => {
  assert.equal(unescape('a\\\\b'), 'a\\b');
});

test('_unescapeJsString: double-backslash before space — space preserved', () => {
  // "C:\\\\Users dir" should unescape to "C:\\Users dir" with space intact
  const result = unescape('C:\\\\\\\\Users dir');
  assert.ok(result.includes('Users dir'), 'space after backslash-path corrupted: ' + result);
  assert.ok(result.startsWith('C:\\'), 'backslash not unescaped: ' + result);
});

test('_unescapeJsString: realistic Rails JS response preserves companion name', () => {
  // Mirrors what G-Hosp /pr/shared/{id}/get_dados_paciente returns:
  // $.html("<fieldset><small><div>Mãe: ALICE SOUZA<\/div></small></fieldset>")
  const railsJs = '$.html("<fieldset><small><div>Mãe: ALICE SOUZA<\\/div></small></fieldset>")';
  const result = unescape(railsJs);
  assert.ok(result.includes('Mãe: ALICE SOUZA'), 'companion name corrupted: ' + JSON.stringify(result));
});

test('_unescapeJsString: null/empty input returns empty string', () => {
  assert.equal(unescape(''), '');
  assert.equal(unescape(null), '');
  assert.equal(unescape(undefined), '');
});

test('_unescapeJsString: temp marker is not a space (source check)', () => {
  // Guard: the old bug was .replace(/\\\\/g, ' ') + .replace(/ /g, '\\').
  // The fix uses \x00 (null byte). Assert the source no longer has the space marker.
  const fnStart = src.indexOf('function _unescapeJsString(s)');
  const fnEnd   = src.indexOf('\n  }', fnStart) + 4;
  const fnBody  = src.slice(fnStart, fnEnd);
  // The final replacement must NOT be on all spaces
  assert.doesNotMatch(fnBody, /\.replace\(\/ \/g,\s*'\\\\'\)/,
    'space-as-temp-marker bug is back: final replace is on spaces');
});
