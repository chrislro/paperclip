// scripts/test-selector-config-parity.js — CHRA-2423 Bug 70
//
// Run with: node --test scripts/test-selector-config-parity.js
//
// Enforces the invariant the dom-engine.js comment claims but nothing checked:
// BUNDLED_SELECTORS "mirrors data/selectors/ghosp.json".
//
// Why it matters: sel(key) returns the SERVER value only when the loaded config
// has that key (hasOwnProperty), else it falls back to the hardcoded bundle. So a
// selector key present in BUNDLED_SELECTORS but ABSENT from ghosp.json is NOT
// remotely patchable — if G-Hosp changes that DOM element, the operator cannot
// hot-fix it via the /api/selectors config and must ship a whole new extension
// (CWS healthcare review = 1–3 weeks). Bug 70 found 10 such keys (the entire
// atestado flow, discharge_date_input, recomendas_field, parent_info_block*).
//
// This test fails if (a) any bundled key is missing from the server config, or
// (b) a shared key has a different value (which would silently change selector
// behaviour ~one network round-trip after page load).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadBundledSelectors() {
  const src = fs.readFileSync(path.join(ROOT, 'content/dom-engine.js'), 'utf8');
  const m = src.match(/const BUNDLED_SELECTORS\s*=\s*(\{[\s\S]*?\n {2}\});/);
  assert.ok(m, 'could not locate the BUNDLED_SELECTORS object literal in dom-engine.js');
  // eval (not JSON.parse): the literal carries // comments, trailing commas, and
  // XPath strings with escaped quotes that JSON.parse rejects. Source is trusted.
  // eslint-disable-next-line no-eval
  return eval('(' + m[1] + ')');
}

function loadServerSelectors() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'backend/data/selectors/ghosp.json'), 'utf8'));
  assert.ok(raw && raw.selectors && typeof raw.selectors === 'object',
    'ghosp.json must have a .selectors object');
  return raw.selectors;
}

// content/selectors.json is a THIRD copy of the selector config. It is NOT loaded
// at runtime (the content scripts fetch /api/selectors → ghosp.json), but the
// legacy selftest block 4 treats it as a reference, so it must not silently drift
// from the runtime sources — a future operator editing it would expect an effect
// and get none. Guard it for full value parity with the served config.
function loadContentSelectors() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'content/selectors.json'), 'utf8'));
  assert.ok(raw && raw.selectors && typeof raw.selectors === 'object',
    'content/selectors.json must have a .selectors object');
  return raw.selectors;
}

const bundled = loadBundledSelectors();
const server = loadServerSelectors();
const contentJson = loadContentSelectors();
const norm = (v) => JSON.stringify(v);

test('every BUNDLED_SELECTORS key is present in ghosp.json (remotely patchable)', () => {
  const missing = Object.keys(bundled).filter((k) => !(k in server));
  assert.deepEqual(
    missing, [],
    'these bundled selector keys are missing from data/selectors/ghosp.json and '
      + 'therefore cannot be hot-patched when G-Hosp changes: ' + missing.join(', '));
});

test('shared selector keys have identical values in bundle and server', () => {
  const diverged = Object.keys(bundled)
    .filter((k) => k in server && norm(bundled[k]) !== norm(server[k]))
    .map((k) => `${k} (bundle=${norm(bundled[k])} vs server=${norm(server[k])})`);
  assert.deepEqual(
    diverged, [],
    'these keys diverge between BUNDLED_SELECTORS and ghosp.json — selector '
      + 'behaviour would change after loadSelectors(): ' + diverged.join('; '));
});

test('ghosp.json serves no unknown selector key the bundle lacks a fallback for', () => {
  // A server-only key isn't a hard break (sel() returns it directly), but it
  // signals the bundle drifted behind the server — flag it so the two stay paired.
  const serverOnly = Object.keys(server).filter((k) => !(k in bundled));
  assert.deepEqual(
    serverOnly, [],
    'ghosp.json defines keys not in BUNDLED_SELECTORS (bundle drifted behind): '
      + serverOnly.join(', '));
});

test('content/selectors.json (3rd copy) is value-identical to the served ghosp.json', () => {
  // CHRA-2423: content/selectors.json had 3 stale values (parent_info_block*,
  // presatestado_save) that the refined runtime selectors had moved past. It is
  // not loaded at runtime, so the drift was invisible — but it's a trap for anyone
  // who edits it expecting an effect. Keep it in lockstep with ghosp.json.
  const ck = Object.keys(contentJson), gk = Object.keys(server);
  const onlyContent = ck.filter((k) => !(k in server));
  const onlyServer = gk.filter((k) => !(k in contentJson));
  const diverged = ck
    .filter((k) => k in server && norm(contentJson[k]) !== norm(server[k]))
    .map((k) => `${k} (content=${norm(contentJson[k])} vs ghosp=${norm(server[k])})`);
  assert.deepEqual(onlyContent, [], 'keys only in content/selectors.json: ' + onlyContent.join(', '));
  assert.deepEqual(onlyServer, [], 'keys only in ghosp.json (missing from content/selectors.json): ' + onlyServer.join(', '));
  assert.deepEqual(diverged, [], 'content/selectors.json values drifted from ghosp.json: ' + diverged.join('; '));
});
