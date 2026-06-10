// scripts/test-offline-queue.js — CHRA-2166 offline-handling tripwires.
//
// Run with: node --test scripts/test-offline-queue.js
// No deps — uses Node's built-in test runner.
//
// Covers two layers:
//   1. Behavioral: the offline-queue's pure logic (PHI allowlist, idempotency
//      key, config picking) plus real enqueue/list/flush against a tiny
//      in-memory IndexedDB shim — this is where "no duplicate writes" lives.
//   2. Static tripwires: the surfaces are wired (HTML load order, manifest left
//      unchanged, user-config-client integrates the queue, side panel exposes
//      the "Backend indisponível" banner + retry + PHI cleanup).

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────
// Minimal in-memory IndexedDB shim (just enough for shared/offline-queue.js).
// Installed on globalThis BEFORE requiring the module; the module reads
// `indexedDB` lazily per call, so this is picked up at enqueue/flush time.
// Requests fire callbacks on a microtask; transactions complete on a later
// macrotask, preserving the real "handlers attached, then events fire" order.
// ─────────────────────────────────────────────────────────────────────────
function installFakeIndexedDB() {
  const dbs = {}; // name -> { stores: { storeName: Map } }

  function fireReq(req, getResult) {
    queueMicrotask(() => {
      try { req.result = getResult(); req.onsuccess && req.onsuccess(); }
      catch (e) { req.error = e; req.onerror && req.onerror(); }
    });
    return req;
  }

  function makeStore(map) {
    return {
      createIndex() {},
      put(rec) { return fireReq({}, () => { map.set(rec.id, rec); return rec.id; }); },
      // CHRA-2423 Bug 82: flush() now compare-and-deletes via store.get —
      // the mock mirrors the module's grown API surface.
      get(id) { return fireReq({}, () => map.get(id)); },
      getAll() { return fireReq({}, () => Array.from(map.values())); },
      delete(id) { return fireReq({}, () => { map.delete(id); }); },
      clear() { return fireReq({}, () => { map.clear(); }); },
      count() { return fireReq({}, () => map.size); },
    };
  }

  globalThis.indexedDB = {
    open(name) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
      const fresh = !dbs[name];
      if (fresh) dbs[name] = { stores: {} };
      const entry = dbs[name];
      const db = {
        objectStoreNames: { contains: (s) => !!entry.stores[s] },
        createObjectStore(s) { entry.stores[s] = entry.stores[s] || new Map(); return makeStore(entry.stores[s]); },
        transaction(s) {
          const map = entry.stores[s] || (entry.stores[s] = new Map());
          const tx = { objectStore: () => makeStore(map), oncomplete: null, onerror: null, onabort: null };
          // Complete after request microtasks have run.
          setTimeout(() => { tx.oncomplete && tx.oncomplete(); }, 0);
          return tx;
        },
        close() {},
      };
      req.result = db;
      queueMicrotask(() => {
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
  return () => { delete globalThis.indexedDB; };
}

// Require AFTER the shim is installed (module reads indexedDB lazily anyway).
const teardownIdb = installFakeIndexedDB();
const Q = require('../shared/offline-queue.js');

// ─────────────────────────────────────────────────────────────────────────
// 1a. Pure logic — PHI allowlist
// ─────────────────────────────────────────────────────────────────────────

test('_isPhiSafe accepts a config patch of allowlisted keys', () => {
  assert.equal(Q._isPhiSafe('config', { rx_templates: [], doctor_name: 'Dr X' }), true);
  assert.equal(Q._isPhiSafe('config', { auto_cid: true, custom_instructions: 'x' }), true);
});

test('_isPhiSafe REJECTS patient PHI fields', () => {
  assert.equal(Q._isPhiSafe('config', { patient_name: 'Maria' }), false);
  assert.equal(Q._isPhiSafe('config', { cpf: '000' }), false);
  assert.equal(Q._isPhiSafe('config', { soap_text: '...' }), false);
  assert.equal(Q._isPhiSafe('config', { paciente_nome: 'x' }), false);
  // Even mixed with a valid key, one PHI key poisons the whole payload.
  assert.equal(Q._isPhiSafe('config', { rx_templates: [], patient_name: 'Maria' }), false);
});

test('_isPhiSafe REJECTS unknown keys and non-config kinds', () => {
  assert.equal(Q._isPhiSafe('config', { foo: 1 }), false);
  assert.equal(Q._isPhiSafe('config', {}), false);
  assert.equal(Q._isPhiSafe('audit', { rx_templates: [] }), false);
  assert.equal(Q._isPhiSafe('config', null), false);
  assert.equal(Q._isPhiSafe('config', [1, 2]), false);
});

test('_containsPhiKey flags common patient identifiers', () => {
  assert.equal(Q._containsPhiKey({ patient_id: 1 }), true);
  assert.equal(Q._containsPhiKey({ telefone: 1 }), true);
  assert.equal(Q._containsPhiKey({ rx_templates: [] }), false);
});

test('pickAllowedConfig strips non-allowlisted / PHI keys', () => {
  const picked = Q.pickAllowedConfig({
    rx_templates: [1], doctor_name: 'D', patient_name: 'Maria', _id: 9, foo: 'bar',
  });
  assert.deepEqual(Object.keys(picked).sort(), ['doctor_name', 'rx_templates']);
});

// ─────────────────────────────────────────────────────────────────────────
// 1b. Pure logic — idempotency key
// ─────────────────────────────────────────────────────────────────────────

test('makeIdempotencyKey is stable for identical content (key order independent)', () => {
  assert.equal(
    Q.makeIdempotencyKey('config', { a: 1, b: 2 }),
    Q.makeIdempotencyKey('config', { b: 2, a: 1 }));
});

test('makeIdempotencyKey changes when the body changes', () => {
  assert.notEqual(
    Q.makeIdempotencyKey('config', { doctor_name: 'A' }),
    Q.makeIdempotencyKey('config', { doctor_name: 'B' }));
});

test('makeIdempotencyKey is namespaced by dedupeKey', () => {
  assert.ok(Q.makeIdempotencyKey('config', { a: 1 }).startsWith('config:'));
});

// ─────────────────────────────────────────────────────────────────────────
// 1c. Behavioral — enqueue / coalesce / flush idempotency (fake IndexedDB)
// ─────────────────────────────────────────────────────────────────────────

test('enqueue REJECTS a PHI payload (never reaches storage)', async () => {
  await Q.clear();
  await assert.rejects(
    () => Q.enqueue({ kind: 'config', body: { patient_name: 'Maria' } }),
    /PHI|allowlist/i);
  assert.equal(await Q.size(), 0);
});

test('config writes coalesce by dedupeKey (last-write-wins, single record)', async () => {
  await Q.clear();
  await Q.enqueue({ kind: 'config', body: { doctor_name: 'A' }, dedupeKey: 'config' });
  await Q.enqueue({ kind: 'config', body: { doctor_name: 'B' }, dedupeKey: 'config' });
  const rows = await Q.list();
  assert.equal(rows.length, 1, 'must collapse to one config record');
  assert.equal(rows[0].body.doctor_name, 'B', 'latest write wins');
  assert.ok(rows[0].idempotencyKey, 'record carries an idempotency key');
});

test('flush sends each record once with its Idempotency-Key, then removes it', async () => {
  await Q.clear();
  await Q.enqueue({ kind: 'config', body: { doctor_name: 'A' }, dedupeKey: 'config' });
  const seen = [];
  const res = await Q.flush((record) => {
    seen.push({ key: record.idempotencyKey, body: record.body });
    return Promise.resolve({ ok: true });
  });
  assert.equal(seen.length, 1, 'sender called once');
  assert.ok(seen[0].key.startsWith('config:'), 'replay carries the idempotency key');
  assert.equal(res.sent, 1);
  assert.equal(res.remaining, 0, 'record removed after a successful send');
  assert.equal(await Q.size(), 0);
});

test('flush keeps the record when the send fails (ret* on next reconnect)', async () => {
  await Q.clear();
  await Q.enqueue({ kind: 'config', body: { doctor_name: 'A' }, dedupeKey: 'config' });
  const res = await Q.flush(() => Promise.resolve({ ok: false }));
  assert.equal(res.sent, 0);
  assert.equal(await Q.size(), 1, 'failed write stays queued');
  // A later successful flush drains it — and does NOT double-send.
  let calls = 0;
  const res2 = await Q.flush(() => { calls++; return Promise.resolve({ ok: true }); });
  assert.equal(calls, 1);
  assert.equal(res2.sent, 1);
  assert.equal(await Q.size(), 0);
});

test.after(() => teardownIdb());

// ─────────────────────────────────────────────────────────────────────────
// 2a. Static tripwires — shared modules exist + expose the API
// ─────────────────────────────────────────────────────────────────────────

test('shared/connectivity.js publishes the connectivity API + wires events', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/connectivity.js'), 'utf8');
  assert.ok(/window\.TOCAFICHADR_connectivity|root\.TOCAFICHADR_connectivity/.test(src));
  for (const fn of ['isOnline', 'onChange', 'notifyReachable']) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(src), `must expose ${fn}`);
  }
  assert.ok(/navigator\.onLine/.test(src), 'must read navigator.onLine');
  assert.ok(/addEventListener\(["']online["']/.test(src), 'must listen for the online event');
  assert.ok(/addEventListener\(["']offline["']/.test(src), 'must listen for the offline event');
});

test('shared/offline-queue.js publishes the queue API + uses IndexedDB', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/offline-queue.js'), 'utf8');
  assert.ok(/TOCAFICHADR_offlineQueue/.test(src));
  for (const fn of ['enqueue', 'list', 'flush', 'remove', 'clear']) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(src), `must expose ${fn}`);
  }
  assert.ok(/indexedDB/.test(src), 'must use IndexedDB for durable queueing');
  assert.ok(/idempotencyKey|Idempotency/.test(src), 'records must carry an idempotency key');
});

// ─────────────────────────────────────────────────────────────────────────
// 2b. Static tripwires — user-config-client integrates the queue
// ─────────────────────────────────────────────────────────────────────────

test('user-config-client queues offline writes and flushes on reconnect', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/user-config-client.js'), 'utf8');
  assert.ok(/TOCAFICHADR_offlineQueue/.test(src), 'must use the offline queue');
  assert.ok(/Idempotency-Key/.test(src), 'replay must send an Idempotency-Key header');
  assert.ok(/_flushQueue/.test(src), 'must define a queue-flush routine');
  assert.ok(/onChange\(function \(online\)|onChange\(\(online\)/.test(src),
    'must flush when connectivity returns');
  assert.ok(/_isConnectivityFailure|status === 0/.test(src),
    'must distinguish a connectivity failure from a server rejection before queuing');
});

// ─────────────────────────────────────────────────────────────────────────
// 2c. Static tripwires — HTML surfaces load order
// ─────────────────────────────────────────────────────────────────────────

for (const surf of [
  { label: 'sidepanel.html', path: 'sidepanel/sidepanel.html', uc: 'user-config-client' },
  { label: 'popup.html',     path: 'popup/popup.html',         uc: 'user-config-client' },
]) {
  test(`${surf.label} loads connectivity + offline-queue BEFORE user-config-client`, () => {
    const src = fs.readFileSync(path.join(ROOT, surf.path), 'utf8');
    const conn = src.search(/<script\s+src="[^"]*connectivity\.js"/);
    const queue = src.search(/<script\s+src="[^"]*offline-queue\.js"/);
    const uc = src.search(new RegExp(`<script\\s+src="[^"]*${surf.uc}\\.js"`));
    assert.ok(conn >= 0, `${surf.label} must load connectivity.js`);
    assert.ok(queue >= 0, `${surf.label} must load offline-queue.js`);
    assert.ok(uc >= 0, `${surf.label} must load user-config-client.js`);
    assert.ok(conn < uc && queue < uc,
      `${surf.label}: connectivity.js + offline-queue.js must load before user-config-client.js`);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 2d. Static tripwires — side panel "Backend indisponível" UX + PHI cleanup
// ─────────────────────────────────────────────────────────────────────────

test('sidepanel.html declares the non-blocking offline banner + retry', () => {
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
  assert.ok(/id="sp-offline-banner"/.test(html), 'must declare #sp-offline-banner');
  assert.ok(/id="sp-offline-retry"/.test(html), 'must declare the retry button');
  assert.ok(/Backend indispon[ií]vel/.test(html), 'banner must say "Backend indisponível"');
  assert.ok(/id="sp-offline-banner"[^>]*\bhidden\b/.test(html),
    'banner element must carry the hidden attribute by default (non-blocking)');
});

test('sidepanel-prontuario.js wires connectivity, retry, guard and PHI cleanup', () => {
  const js = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel-prontuario.js'), 'utf8');
  assert.ok(/_wireConnectivity/.test(js), 'must wire connectivity in init');
  assert.ok(/_retryConnection/.test(js), 'must implement the retry handler');
  assert.ok(/_guardOnline\(\)/.test(js), 'recording must short-circuit when offline');
  assert.ok(/TOCAFICHADR_HEALTH/.test(js), 'retry must re-probe backend health');
  assert.ok(/_clearSessionPHI/.test(js) && /pagehide/.test(js),
    'must clear in-memory patient data on session end (pagehide)');
});

// ─────────────────────────────────────────────────────────────────────────
// 2e. Static tripwire — manifest left unchanged (no new permissions)
// ─────────────────────────────────────────────────────────────────────────

test('manifest permissions are unchanged (offline handling adds none)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const expected = [
    'activeTab', 'storage', 'cookies', 'scripting',
    'clipboardWrite', 'sidePanel', 'offscreen', 'alarms',
  ].sort();
  assert.deepEqual([...(manifest.permissions || [])].sort(), expected,
    'CHRA-2166 must not add a permission — the offline queue uses IndexedDB ' +
    '(no permission required) and connectivity uses navigator.onLine.');
});
