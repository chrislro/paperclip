"use strict";
/* ============================================================================
 * shared/offline-queue.js  (CHRA-2166 — offline handling)
 *
 * Durable, IndexedDB-backed write queue for the doctor's clinical config
 * (rx templates, voices, toggles — the PATCH /api/me/config payload). When a
 * config write fails because the backend is unreachable, the side panel /
 * popup enqueue it here instead of dropping it; the queue is replayed the
 * moment connectivity returns (see shared/user-config-client.js).
 *
 * Idempotent replay — no duplicate writes:
 *   - Records coalesce by `dedupeKey` (last-write-wins): the config record's
 *     body is always the FULL current config, so re-queuing simply overwrites
 *     the previous body. There is never more than one config record.
 *   - Each record carries an `idempotencyKey` = dedupeKey + ":" + hash(body),
 *     sent as the `Idempotency-Key` header on replay. Retrying the SAME record
 *     reuses the key (backend can dedupe a half-applied write); a genuinely
 *     newer edit produces a new key. PATCH /api/me/config is itself idempotent.
 *
 * PHI safety — no durable patient data at rest (Rule 11):
 *   - enqueue() accepts ONLY kind "config" with an allowlist of doctor-config
 *     keys. Any unknown key, or any key that looks like patient data (name,
 *     CPF, SOAP text, prontuário…), is REFUSED. Patient data therefore never
 *     reaches IndexedDB. See _isPhiSafe / _containsPhiKey.
 *
 * Public API — window.TOCAFICHADR_offlineQueue:
 *   enqueue({ kind, method, path, body, dedupeKey })  -> Promise<record>
 *   list()                                            -> Promise<record[]>
 *   size()                                            -> Promise<number>
 *   remove(id)                                        -> Promise<void>
 *   clear()                                           -> Promise<void>
 *   flush(sender)   sender(record)->Promise<{ok}>     -> Promise<{sent,remaining}>
 *
 * Browser- AND Node-safe: pure helpers (hashing, idempotency key, PHI checks)
 * are exported via module.exports for `node --test`; IndexedDB calls reject
 * cleanly when `indexedDB` is absent (Node) so requiring the file never throws.
 * ========================================================================== */
(function (root) {
  var DB_NAME = "tocafichadr-offline";
  var DB_VERSION = 1;
  var STORE = "pendingWrites";

  var KIND_CONFIG = "config";

  // Doctor-config keys that PATCH /api/me/config accepts. Mirrors the
  // UserConfig model (see scripts/test-config-gate.js). NOT patient data.
  var CONFIG_ALLOWED_KEYS = [
    "rx_templates",
    "voices",
    "active_voice_id",
    "custom_instructions",
    "doctor_name",
    "auto_cid",
    "auto_clear_soap",
    "auto_fill_companion",
    "auto_prefill_encaminh",
    "auto_transcribe_on_dictation",
    "updated_at",
  ];

  // Belt-and-suspenders denylist: substrings that flag a key as patient PHI.
  // Even if a key slipped past the allowlist, anything matching these is
  // refused so PHI can never be written to durable storage. NB: we use "nome"
  // (pt-BR) rather than the bare "name" so the legitimate config key
  // `doctor_name` is not false-flagged — the allowlist is the primary gate.
  var PHI_DENY_KEYS = [
    "patient", "paciente", "cpf", "nome", "birth", "nascimento",
    "soap", "prontuario", "prontuário", "atendimento", "diagnos", "anamnese",
    "phone", "telefone", "email", "address", "endereco", "endereço",
  ];

  // ---- Pure helpers (also exported for Node tests) -------------------------

  // djb2 string hash → unsigned base36. Stable across processes; good enough
  // to detect "did the body change?" for idempotency-key derivation.
  function _hash(str) {
    var s = String(str == null ? "" : str);
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // h * 33 + c, kept uint32
    }
    return h.toString(36);
  }

  // Deterministic JSON: sort object keys so hashing is order-independent.
  function _stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map(_stableStringify).join(",") + "]";
    }
    var keys = Object.keys(value).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(JSON.stringify(keys[i]) + ":" + _stableStringify(value[keys[i]]));
    }
    return "{" + parts.join(",") + "}";
  }

  function makeIdempotencyKey(dedupeKey, body) {
    return String(dedupeKey) + ":" + _hash(_stableStringify(body));
  }

  function _containsPhiKey(body) {
    if (!body || typeof body !== "object") return false;
    var keys = Object.keys(body);
    for (var i = 0; i < keys.length; i++) {
      var lower = keys[i].toLowerCase();
      for (var j = 0; j < PHI_DENY_KEYS.length; j++) {
        if (lower.indexOf(PHI_DENY_KEYS[j]) !== -1) return true;
      }
    }
    return false;
  }

  // A payload is safe to persist iff it is a "config" write whose top-level
  // keys are ALL allowlisted and NONE look like PHI.
  function _isPhiSafe(kind, body) {
    if (kind !== KIND_CONFIG) return false;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    if (_containsPhiKey(body)) return false;
    var allow = {};
    for (var i = 0; i < CONFIG_ALLOWED_KEYS.length; i++) allow[CONFIG_ALLOWED_KEYS[i]] = true;
    var keys = Object.keys(body);
    if (!keys.length) return false;
    for (var k = 0; k < keys.length; k++) {
      if (!allow[keys[k]]) return false;
    }
    return true;
  }

  // Keep only allowlisted keys — strips server-only / unexpected fields before
  // they ever reach the queue. Callers pass this the full local config.
  function pickAllowedConfig(config) {
    var out = {};
    if (!config || typeof config !== "object") return out;
    for (var i = 0; i < CONFIG_ALLOWED_KEYS.length; i++) {
      var key = CONFIG_ALLOWED_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(config, key)) out[key] = config[key];
    }
    return out;
  }

  // ---- IndexedDB plumbing --------------------------------------------------

  function _idb() {
    return (typeof indexedDB !== "undefined" && indexedDB) ||
           (typeof root !== "undefined" && root.indexedDB) || null;
  }

  function _openDb() {
    return new Promise(function (resolve, reject) {
      var idb = _idb();
      if (!idb) {
        reject(new Error("IndexedDB unavailable in this context"));
        return;
      }
      var req;
      try {
        req = idb.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB open failed")); };
    });
  }

  function _tx(mode, fn) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var result;
        try {
          result = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = function () { try { db.close(); } catch (_) {} resolve(result); };
        tx.onerror = function () { try { db.close(); } catch (_) {} reject(tx.error || new Error("tx failed")); };
        tx.onabort = function () { try { db.close(); } catch (_) {} reject(tx.error || new Error("tx aborted")); };
      });
    });
  }

  function _reqValue(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // ---- Public queue operations --------------------------------------------

  function enqueue(item) {
    item = item || {};
    var kind = item.kind;
    var body = item.body;
    if (!_isPhiSafe(kind, body)) {
      return Promise.reject(new Error(
        "offline-queue: refusing to persist non-allowlisted / PHI payload (kind=" + kind + ")"));
    }
    var dedupeKey = item.dedupeKey || kind;
    var now = Date.now();
    var record = {
      id: dedupeKey,                       // coalesce by dedupeKey (last-write-wins)
      kind: kind,
      method: (item.method || "PATCH").toUpperCase(),
      path: item.path || "/api/me/config",
      body: body,
      idempotencyKey: makeIdempotencyKey(dedupeKey, body),
      createdAt: now,
      updatedAt: now,
    };
    return _tx("readwrite", function (store) {
      store.put(record);
      return record;
    });
  }

  function list() {
    return _tx("readonly", function (store) {
      return _reqValue(store.getAll());
    }).then(function (rows) {
      rows = Array.isArray(rows) ? rows : [];
      rows.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      return rows;
    });
  }

  function size() {
    return _tx("readonly", function (store) {
      return _reqValue(store.count());
    });
  }

  function remove(id) {
    return _tx("readwrite", function (store) { store.delete(id); });
  }

  // CHRA-2423 Bug 82 — compare-and-delete for flush(): remove the record ONLY
  // if its idempotencyKey still matches the body that was actually sent.
  // enqueue() coalesces by id (last-write-wins by design), so a doctor edit
  // landing while flush() has the OLD body on the wire would otherwise be
  // deleted UNSENT by the post-send remove(). get+delete run inside one
  // readwrite transaction, so the check is atomic against enqueue's put. A
  // key mismatch means a newer edit superseded the sent body — leave it
  // queued for the next flush pass. Guarded by
  // scripts/test-offline-queue-flush-race.js.
  function _removeIfKeyMatches(id, idempotencyKey) {
    return _tx("readwrite", function (store) {
      var req = store.get(id);
      req.onsuccess = function () {
        var current = req.result;
        if (current && current.idempotencyKey === idempotencyKey) {
          store.delete(id);
        }
      };
    });
  }

  function clear() {
    return _tx("readwrite", function (store) { store.clear(); });
  }

  var _flushing = false;

  // Replay every queued write through `sender`. On a truthy {ok} the record is
  // removed; on the first failure we STOP (still offline / backend down) and
  // leave the remainder for the next flush. Single-flight: concurrent calls
  // (e.g. an `online` event firing twice) collapse to one pass.
  function flush(sender) {
    if (typeof sender !== "function") {
      return Promise.reject(new Error("offline-queue.flush requires a sender(record) function"));
    }
    if (_flushing) return Promise.resolve({ sent: 0, remaining: -1, skipped: true });
    _flushing = true;
    var sent = 0;
    return list().then(function (rows) {
      return rows.reduce(function (chain, record) {
        return chain.then(function (stop) {
          if (stop) return true;
          return Promise.resolve(sender(record)).then(function (res) {
            if (res && res.ok) {
              sent++;
              // Compare-and-delete (Bug 82): a newer body may have coalesced
              // over this id while the send was in flight — never delete what
              // was not sent.
              return _removeIfKeyMatches(record.id, record.idempotencyKey)
                .then(function () { return false; });
            }
            return true; // stop on first failure
          }).catch(function () { return true; });
        });
      }, Promise.resolve(false));
    }).then(function () {
      return size();
    }).then(function (remaining) {
      _flushing = false;
      return { sent: sent, remaining: remaining };
    }).catch(function (err) {
      _flushing = false;
      throw err;
    });
  }

  var api = {
    enqueue: enqueue,
    list: list,
    size: size,
    remove: remove,
    clear: clear,
    flush: flush,
    pickAllowedConfig: pickAllowedConfig,
    makeIdempotencyKey: makeIdempotencyKey,
    KIND_CONFIG: KIND_CONFIG,
    CONFIG_ALLOWED_KEYS: CONFIG_ALLOWED_KEYS.slice(),
    PHI_DENY_KEYS: PHI_DENY_KEYS.slice(),
    // exposed for tripwire tests
    _isPhiSafe: _isPhiSafe,
    _containsPhiKey: _containsPhiKey,
    _hash: _hash,
    _stableStringify: _stableStringify,
  };

  if (root && !root.TOCAFICHADR_offlineQueue) {
    root.TOCAFICHADR_offlineQueue = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
