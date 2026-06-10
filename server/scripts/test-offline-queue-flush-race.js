// scripts/test-offline-queue-flush-race.js — CHRA-2423 Bug 82
//
// Run with: node --test scripts/test-offline-queue-flush-race.js
//
// Guards shared/offline-queue.js flush() against the coalesce-while-in-flight
// race that silently drops the doctor's NEWEST config edit:
//
//   1. flush() lists the queue → gets record {id:"config", body:v1, key:K1}
//   2. sender(v1) is on the wire (slow network — the very situation the
//      offline queue exists for)
//   3. the doctor edits config → enqueue() coalesces v2 over the SAME id
//      (last-write-wins by design), idempotencyKey becomes K2
//   4. sender(v1) resolves ok → flush calls remove("config")
//   5. ...which deletes the v2 record. v2 was NEVER sent and is now gone.
//
// The record already carries an idempotencyKey that changes with the body —
// the fix is compare-and-delete: remove the record only if its key still
// matches what was actually sent (get+delete inside ONE readwrite tx, atomic
// against enqueue's put). A mismatch means a newer edit landed mid-flight;
// it stays queued for the next flush pass.
//
// offline-queue.js is Node-requireable (module.exports) but its plumbing
// needs `indexedDB`, so we provide a minimal in-memory fake that preserves
// the semantics the race depends on: async request callbacks, transactions
// that stay open while requests are issued from onsuccess handlers, and
// last-write-wins put().

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Minimal fake IndexedDB (only what offline-queue.js touches)
// ---------------------------------------------------------------------------
function createFakeIndexedDB() {
  const stores = new Map(); // storeName -> Map(id -> record)

  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name) {
      stores.set(name, new Map());
      return { createIndex() {} };
    },
    transaction(name, _mode) {
      const data = stores.get(name);
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      let pending = 0;
      let completed = false;
      const maybeComplete = () => {
        if (pending === 0 && !completed) {
          completed = true;
          queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
        }
      };
      // Faithful-enough IDB semantics: requests resolve async; a request
      // issued from another request's onsuccess keeps the tx open (pending
      // is incremented synchronously inside the handler, before
      // maybeComplete checks it).
      const mkReq = (executor) => {
        const req = { onsuccess: null, onerror: null, result: undefined, error: null };
        pending++;
        queueMicrotask(() => {
          try {
            req.result = executor();
            pending--;
            if (req.onsuccess) req.onsuccess();
          } catch (e) {
            req.error = e;
            pending--;
            if (req.onerror) req.onerror();
          }
          maybeComplete();
        });
        return req;
      };
      const store = {
        put: (rec) => mkReq(() => { data.set(rec.id, JSON.parse(JSON.stringify(rec))); return rec.id; }),
        get: (id) => mkReq(() => data.get(id)),
        delete: (id) => mkReq(() => { data.delete(id); }),
        getAll: () => mkReq(() => Array.from(data.values())),
        count: () => mkReq(() => data.size),
        clear: () => mkReq(() => { data.clear(); }),
      };
      tx.objectStore = () => store;
      queueMicrotask(maybeComplete); // empty-tx fallback
      return tx;
    },
    close() {},
  };

  return {
    open(_name, _version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db, error: null };
      queueMicrotask(() => {
        if (!stores.size && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    _stores: stores, // test introspection
  };
}

// _idb() reads the `indexedDB` global dynamically on every call, so a single
// require() works — we just swap in a fresh fake before each test.
const queue = require(path.join(__dirname, '..', 'shared', 'offline-queue.js'));

beforeEach(() => {
  globalThis.indexedDB = createFakeIndexedDB();
});

test('happy path: flush sends and removes an unchanged record', async () => {
  await queue.enqueue({ kind: 'config', body: { doctor_name: 'v1' } });
  const res = await queue.flush(async () => ({ ok: true }));
  assert.equal(res.sent, 1);
  assert.equal(await queue.size(), 0, 'sent record must be removed');
});

test('failed send leaves the record queued', async () => {
  await queue.enqueue({ kind: 'config', body: { doctor_name: 'v1' } });
  const res = await queue.flush(async () => ({ ok: false }));
  assert.equal(res.sent, 0);
  assert.equal(await queue.size(), 1, 'unsent record must stay queued');
});

test('flush must NOT delete a newer write coalesced while the old body was in flight', async () => {
  await queue.enqueue({ kind: 'config', body: { doctor_name: 'v1' } });

  await queue.flush(async (record) => {
    assert.equal(record.body.doctor_name, 'v1', 'flush sends the listed (old) body');
    // While v1 is "on the wire", the doctor edits config: v2 coalesces over
    // the same id with a NEW idempotencyKey. This is the documented
    // last-write-wins behavior of enqueue() — the race is in flush's remove.
    await queue.enqueue({ kind: 'config', body: { doctor_name: 'v2' } });
    return { ok: true }; // v1 send succeeds
  });

  const rows = await queue.list();
  assert.equal(rows.length, 1,
    'v2 was enqueued mid-flight and never sent — flush must not delete it');
  assert.equal(rows[0].body.doctor_name, 'v2',
    'the surviving record must be the newer body');
});

test('removeIfKeyMatches semantics: unchanged record IS removed after mid-flight no-op edit', async () => {
  // An edit that produces the IDENTICAL body (same idempotencyKey) may be
  // removed — nothing newer exists. Guards against over-correcting into
  // "never remove anything".
  await queue.enqueue({ kind: 'config', body: { doctor_name: 'v1' } });
  await queue.flush(async () => {
    await queue.enqueue({ kind: 'config', body: { doctor_name: 'v1' } }); // same body → same key
    return { ok: true };
  });
  assert.equal(await queue.size(), 0,
    'identical re-enqueue (same idempotencyKey) must still be cleaned up');
});
