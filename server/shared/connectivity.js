"use strict";
/* ============================================================================
 * shared/connectivity.js  (CHRA-2166 — offline handling)
 *
 * Single source of truth for client connectivity, shared by the side panel
 * and the popup. Combines the OS-level `navigator.onLine` signal with the
 * `online` / `offline` window events, plus an optional backend-reachability
 * probe (e.g. GET /api/health), so every surface reacts to connectivity the
 * same way.
 *
 * Why a shared module: before this, each surface re-implemented its own
 * health pill. Driving the UI from one connectivity source keeps the
 * "Backend indisponível" state consistent and lets the user-config write
 * queue (shared/offline-queue.js) flush the moment the link comes back.
 *
 * Public API — window.TOCAFICHADR_connectivity:
 *   isOnline()             -> boolean. False when the OS reports offline OR a
 *                             recent backend probe failed.
 *   onChange(fn)           -> subscribe to transitions; fn(online:boolean).
 *                             Returns an unsubscribe function.
 *   notifyReachable(bool)  -> feed a backend-reachability result (true/false),
 *                             or null/undefined to reset to "unknown" (defer
 *                             to navigator.onLine only).
 *
 * Browser- AND Node-safe: every host reference (window/navigator) is guarded
 * so the module can be required under `node --test` without a DOM. It never
 * touches the network or IndexedDB on load.
 * ========================================================================== */
(function (root) {
  if (root.TOCAFICHADR_connectivity) return; // idempotent across re-injection

  var listeners = [];
  // null  = unknown (defer to navigator.onLine)
  // true  = last backend probe succeeded
  // false = last backend probe failed (treated as offline for UI purposes)
  var backendReachable = null;

  function _navOnline() {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
        return navigator.onLine;
      }
    } catch (_) {}
    return true; // assume online when the signal is unavailable
  }

  function isOnline() {
    if (!_navOnline()) return false;       // OS says offline → definitively offline
    if (backendReachable === false) return false; // OS online but backend unreachable
    return true;
  }

  function _emit() {
    var online = isOnline();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](online);
      } catch (e) {
        try { console.warn("[Toca Ficha] connectivity listener error:", e); } catch (_) {}
      }
    }
  }

  function onChange(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function unsubscribe() {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function notifyReachable(reachable) {
    var next = (reachable === null || reachable === undefined) ? null : !!reachable;
    if (next === backendReachable) return;
    var was = isOnline();
    backendReachable = next;
    if (isOnline() !== was) _emit();
  }

  // Wire the OS-level events once. A transition back to "online" clears any
  // stale backend-down flag so isOnline() reflects the fresh OS signal —
  // callers re-probe the backend and call notifyReachable() again.
  try {
    if (typeof root.addEventListener === "function") {
      root.addEventListener("online", function () { backendReachable = null; _emit(); });
      root.addEventListener("offline", function () { _emit(); });
    }
  } catch (_) {}

  root.TOCAFICHADR_connectivity = {
    isOnline: isOnline,
    onChange: onChange,
    notifyReachable: notifyReachable,
  };
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
