// scripts/test-config-gate.js — Tripwires for phase 003 (user-account-linked
// config + auth gate). Verifies that:
//   - shared/user-config-client.js exists with the expected exports
//   - sidepanel.html and popup.html load it BEFORE popup.bundle.js
//   - sidepanel.html and popup.html declare the auth-gate UI (#auth-gate)
//   - popup.src.js drives body[data-authed] from chrome.storage.local.authToken
//   - No personal-config key reaches chrome.storage.sync.{get,set} in the
//     UI scripts (sidepanel-prontuario.js, popup.src.js). user-config-client.js
//     is exempted because it intentionally REMOVES legacy keys.
//   - user-config-client.js implements the self-write grace window so writers
//     don't lose input focus from their own optimistic update.
//
// Run with: node --test scripts/test-config-gate.js
// All assertions are static-source invariants; this is a tripwire suite,
// not behavioral coverage. Behavioral tests live in backend/tests/test_user_config.py.

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');

// Personal-config keys that MUST NOT appear inside chrome.storage.sync calls
// in the UI scripts after phase 003 ships. These are now backed by
// /api/me/config via window.TOCAFICHADR_userConfig.
const BANNED_SYNC_KEYS = [
  'prescriptionTemplates',
  '_rxV31Migrated',
  'soapVoices',
  'activeSoapVoiceId',
  'customInstructions',
  'doctorName',
  'autoCid',
  'autoClearSoap',
  'autoFillCompanion',
  'autoPrefillEncaminh',
  'autoTranscribeOnDictation',
];

// =====================================================================
// user-config-client.js — file presence + exports + self-write window
// =====================================================================

test('shared/user-config-client.js exists', () => {
  const p = path.join(ROOT, 'shared/user-config-client.js');
  assert.ok(fs.existsSync(p), 'shared/user-config-client.js must exist');
});

test('user-config-client exposes hydrate, getCached, patch, onChange', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/user-config-client.js'), 'utf8');
  // The IIFE must publish window.TOCAFICHADR_userConfig with these methods.
  assert.ok(/window\.TOCAFICHADR_userConfig\s*=/.test(src),
    'must publish window.TOCAFICHADR_userConfig');
  for (const fn of ['hydrate', 'getCached', 'patch', 'onChange']) {
    const re = new RegExp(`\\b${fn}\\s*[:=]`);
    assert.ok(re.test(src), `must export ${fn}`);
  }
});

test('user-config-client uses /api/me/config endpoint', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/user-config-client.js'), 'utf8');
  assert.ok(/\/api\/me\/config/.test(src),
    'client must hit /api/me/config (the GET/PATCH endpoint added in 03-01)');
});

test('user-config-client routes through service worker via TOCAFICHADR_FETCH', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/user-config-client.js'), 'utf8');
  assert.ok(/TOCAFICHADR_FETCH/.test(src),
    'client must use the SW fetch proxy so URL allowlist + Bearer attachment apply');
});

test('user-config-client implements the self-write grace window', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/user-config-client.js'), 'utf8');
  // The grace window prevents own writes from re-emitting via storage.onChanged
  // (which fires in the writer's context too) and stealing input focus.
  assert.ok(/_lastSelfWriteAt/.test(src),
    'client must track _lastSelfWriteAt to suppress self-emit');
  assert.ok(/_SELF_WRITE_GRACE_MS/.test(src),
    'client must have a self-write grace constant');
});

test('user-config-client clears cache on signout (authToken removed)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/user-config-client.js'), 'utf8');
  // The chrome.storage.onChanged listener must clear userConfig when authToken
  // is removed (sign-out). Otherwise a previous user's data leaks to the next.
  assert.ok(/_clearCache/.test(src),
    'client must call _clearCache on sign-out');
});

test('user-config-client wipes legacy storage.sync keys after first hydrate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/user-config-client.js'), 'utf8');
  // After a successful hydrate, the legacy chrome.storage.sync.prescriptionTemplates
  // (and the other personal keys) must be removed so they don't confuse readers
  // and don't leak across users on a shared Chrome profile.
  assert.ok(/chrome\.storage\.sync\.remove/.test(src),
    'client must call chrome.storage.sync.remove on hydrate to drop legacy keys');
  assert.ok(/prescriptionTemplates/.test(src),
    'client must list prescriptionTemplates in the legacy-cleanup list');
});

// =====================================================================
// HTML surfaces — gate UI + script load order
// =====================================================================

const HTML_SURFACES = [
  { label: 'sidepanel.html', path: 'sidepanel/sidepanel.html' },
  { label: 'popup.html',     path: 'popup/popup.html' },
];

for (const surf of HTML_SURFACES) {
  test(`${surf.label} declares <div id="auth-gate"> with sign-in CTA`, () => {
    const src = fs.readFileSync(path.join(ROOT, surf.path), 'utf8');
    assert.ok(/<div\s+id="auth-gate"/.test(src),
      `${surf.label} must contain <div id="auth-gate">`);
    assert.ok(/id="auth-gate-signin-btn"/.test(src),
      `${surf.label} must contain the gate's sign-in button`);
  });

  test(`${surf.label} CSS hides gated UI when not authed`, () => {
    const src = fs.readFileSync(path.join(ROOT, surf.path), 'utf8');
    assert.ok(/body:not\(\[data-authed="true"\]\)/.test(src),
      `${surf.label} must use body:not([data-authed="true"]) CSS to hide UI`);
  });

  test(`${surf.label} loads user-config-client BEFORE popup.bundle.js`, () => {
    const src = fs.readFileSync(path.join(ROOT, surf.path), 'utf8');
    const ucIdx = src.search(/<script\s+src="[^"]*user-config-client\.js"/);
    const bundleIdx = src.search(/<script\s+src="[^"]*popup\.bundle\.js"/);
    assert.ok(ucIdx >= 0,
      `${surf.label} must load shared/user-config-client.js`);
    assert.ok(bundleIdx >= 0,
      `${surf.label} must load popup.bundle.js`);
    assert.ok(ucIdx < bundleIdx,
      `${surf.label}: user-config-client.js must load BEFORE popup.bundle.js so window.TOCAFICHADR_userConfig is defined when the bundle's IIFE runs`);
  });
}

// =====================================================================
// popup.src.js — auth-gate observer drives body[data-authed]
// =====================================================================

test('popup.src.js sets body.dataset.authed based on authToken', () => {
  const src = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');
  assert.ok(/document\.body\.dataset\.authed/.test(src),
    'popup.src.js must set body.dataset.authed (the gate CSS hook)');
  assert.ok(/_setAuthGate/.test(src),
    'popup.src.js must define _setAuthGate observer helper');
  assert.ok(/authToken/.test(src) && /chrome\.storage\.session/.test(src),
    'popup.src.js must read chrome.storage.session.authToken to drive the gate (CHRA-2133)');
});

test('popup.src.js wires #auth-gate-signin-btn to the Clerk URL flow', () => {
  const src = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');
  assert.ok(/auth-gate-signin-btn/.test(src),
    'popup.src.js must wire #auth-gate-signin-btn');
  assert.ok(/buildSignInUrl/.test(src),
    'popup.src.js gate handler must call buildSignInUrl');
});

test('sidepanel exposes medication-mix Receita UI and flow wiring', () => {
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel-prontuario.js'), 'utf8');
  assert.ok(/id="sp-rx-print-btn"/.test(html),
    'sidepanel must expose the Imprimir Receita mix button');
  assert.ok(/id="sp-rx-empty"/.test(html),
    'sidepanel must expose an empty-state hint for medication shortcuts');
  assert.ok(/selectedRxTemplateIds/.test(js),
    'sidepanel must track selected medication shortcut ids');
  assert.ok(/_wireRxMix/.test(js),
    'sidepanel must wire the mix print button');
  assert.ok(/SIDEPANEL_RUN_SIMPLES_WITH_BODY/.test(js),
    'sidepanel medication mix must reuse the existing Simples prescription flow');
});

// =====================================================================
// chrome.storage.sync hygiene — banned personal keys
// =====================================================================
//
// Pure regex scan: for each UI script (NOT user-config-client.js, which
// intentionally REMOVES legacy keys), grep for chrome.storage.sync.get(...)
// or chrome.storage.sync.set(...) calls and assert no banned key appears
// inside the (...). matchAll captures up to ~400 chars per call site.

const UI_SCRIPTS_TO_SCAN = [
  'sidepanel/sidepanel-prontuario.js',
  'popup/popup.src.js',
];

function _scanSyncCalls(src) {
  const re = /chrome\.storage\.sync\.(get|set)\s*\(([\s\S]{0,400}?)\)/g;
  const out = [];
  for (const m of src.matchAll(re)) {
    out.push({ method: m[1], args: m[2], at: m.index });
  }
  return out;
}

for (const script of UI_SCRIPTS_TO_SCAN) {
  test(`${script}: no banned personal keys in chrome.storage.sync calls`, () => {
    const src = fs.readFileSync(path.join(ROOT, script), 'utf8');
    const calls = _scanSyncCalls(src);
    const violations = [];
    for (const call of calls) {
      for (const key of BANNED_SYNC_KEYS) {
        const re = new RegExp(`['"]${key}['"]`);
        if (re.test(call.args)) {
          violations.push({ key, method: call.method, at: call.at, snippet: call.args.slice(0, 80) });
        }
      }
    }
    assert.equal(violations.length, 0,
      `${script}: chrome.storage.sync.{get,set} contains banned personal keys after phase 003. ` +
      `These must be read/written via window.TOCAFICHADR_userConfig (server-backed). ` +
      `Violations:\n` +
      violations.map(v => `  - ${v.key} (in .${v.method} at offset ${v.at}): ${v.snippet}…`).join('\n'));
  });
}

// =====================================================================
// Backend bookkeeping — phase 003 model + endpoint contract
// =====================================================================

test('backend/tests/test_user_config.py exists', () => {
  const p = path.join(ROOT, 'backend/tests/test_user_config.py');
  assert.ok(fs.existsSync(p),
    'backend/tests/test_user_config.py must exist (phase 03-01 contract)');
});

test('UserConfig model declares all phase-003 fields', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/emr_automation/models.py'), 'utf8');
  // The model must carry every field the client surfaces. If a new toggle
  // gets wired into the UI without a column here, the PATCH call will silently
  // discard it.
  for (const field of [
    'rx_templates', 'voices', 'active_voice_id',
    'custom_instructions', 'doctor_name',
    'auto_cid', 'auto_clear_soap',
    'auto_fill_companion', 'auto_prefill_encaminh',
    'auto_transcribe_on_dictation',
  ]) {
    assert.ok(new RegExp(`${field}\\s*=\\s*Column`).test(src),
      `UserConfig model must declare ${field} = Column(...)`);
  }
});

test('routes.py registers GET and PATCH /api/me/config with @require_auth', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/emr_automation/dashboard/routes.py'), 'utf8');
  assert.ok(/@bp\.route\("\/api\/me\/config",\s*methods=\["GET"\]\)/.test(src),
    'routes.py must register GET /api/me/config');
  assert.ok(/@bp\.route\("\/api\/me\/config",\s*methods=\["PATCH"\]\)/.test(src),
    'routes.py must register PATCH /api/me/config');
  // Both endpoints must be gated by @require_auth (Clerk JWT).
  const matches = src.match(/@bp\.route\("\/api\/me\/config".+?\)\s*\n@require_auth/gs);
  assert.ok(matches && matches.length >= 2,
    'both /api/me/config routes must be decorated with @require_auth');
});
