#!/usr/bin/env bash
# selftest.sh — Fast autonomous tests for Toca Ficha Dr. extension
# Usage: ./scripts/selftest.sh
# Tests that can run without Chrome, without a live server, without G-Hosp.
# Good for: pre-commit, CI, rebuilding trust after refactors.

set -euo pipefail

cd "$(dirname "$0")/.."

FAIL=0

echo "=========================================="
echo " Toca Ficha Dr. self-test — $(date '+%Y-%m-%d %H:%M')"
echo "=========================================="
echo ""

# --- 1. JavaScript syntax ---
echo "[1/33] JS syntax..."
# Skip popup/*.src.js and background/*.src.js — they are ESM source files
# bundled by esbuild (validated at build time) and node --check rejects ESM
# under the package's commonjs default. Bundle outputs are gitignored.
for f in content/*.js; do
  if ! node --check "$f" 2>/dev/null; then
    echo "  ✗ FAIL: $f"
    FAIL=1
  fi
done
[ $FAIL -eq 0 ] && echo "  ✓ all content/*.js files OK"

# --- 2. JSON validity ---
echo ""
echo "[2/33] JSON validity..."
for f in manifest.json content/selectors.json; do
  if python3 -m json.tool "$f" > /dev/null 2>&1; then
    echo "  ✓ $f"
  else
    echo "  ✗ FAIL: $f"
    FAIL=1
  fi
done

# --- 3. CID database integrity ---
echo ""
echo "[3/33] CID database..."
python3 << 'PY'
import re, sys
txt = open('content/cid.js').read()
entries = re.findall(r'code:\s*"([^"]+)"[^}]*name:\s*"([^"]+)"', txt)
codes = [e[0] for e in entries]
print(f"  entries: {len(entries)}")
# Check for duplicates
dups = [c for c in set(codes) if codes.count(c) > 1]
if dups:
    print(f"  ✗ duplicates: {dups}")
    sys.exit(1)
# Check format (CID-10 is letter + 2 digits, optionally .digit)
bad = [c for c in codes if not re.match(r'^[A-Z]\d{2}(\.\d+)?$', c)]
if bad:
    print(f"  ✗ malformed codes: {bad[:5]}")
    sys.exit(1)
# Key general CIDs (adulto + pediátrico)
required = ['J06.9', 'K52.9', 'R50', 'R10', 'J20', 'A09', 'J45.9', 'H10.9', 'J00', 'I10']
missing = [c for c in required if c not in codes]
if missing:
    print(f"  ✗ missing essential CIDs: {missing}")
    sys.exit(1)
print("  ✓ no duplicates, all codes well-formed, essentials present")
PY
[ $? -ne 0 ] && FAIL=1

# --- 4. Selector parity (bundled vs external) ---
echo ""
echo "[4/33] Selector parity..."
python3 << 'PY'
import re, json, sys
txt = open('content/dom-engine.js').read()
marker = 'const BUNDLED_SELECTORS ='
start = txt.find(marker)
if start == -1:
    print("  ✗ BUNDLED_SELECTORS declaration not found")
    sys.exit(1)
brace = txt.find('{', start)
if brace == -1:
    print("  ✗ BUNDLED_SELECTORS object start not found")
    sys.exit(1)

depth = 0
quote = None
escape = False
end = None
for i in range(brace, len(txt)):
    ch = txt[i]
    if quote:
        if escape:
            escape = False
        elif ch == '\\':
            escape = True
        elif ch == quote:
            quote = None
        continue
    if ch in ('"', "'"):
        quote = ch
    elif ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break

if end is None:
    print("  ✗ BUNDLED_SELECTORS object end not found")
    sys.exit(1)

bundled = txt[brace:end]
bundled_keys = set(re.findall(r'^\s*"([^"]+)":', bundled, re.MULTILINE))
external = json.load(open('content/selectors.json'))['selectors']
missing = set(external.keys()) - bundled_keys
extra = bundled_keys - set(external.keys())
if missing:
    print(f"  ✗ in external.json but NOT in BUNDLED_SELECTORS: {missing}")
    sys.exit(1)
if extra:
    print(f"  ⚠ in BUNDLED_SELECTORS but NOT in external.json: {extra} (ok — bundled is superset)")
print(f"  ✓ all {len(external)} external keys present in bundled fallback")
PY
[ $? -ne 0 ] && FAIL=1

# --- 5. Service worker handlers match client call sites ---
echo ""
echo "[5/33] SW message type parity..."
python3 << 'PY'
import re, sys
# v3.0.3: SW renamed to service-worker.src.js (esbuild input).
sw = open('background/service-worker.src.js').read()
api = open('content/api-client.js').read()
sw_types = set(re.findall(r"message\.type === '(TOCAFICHADR_[A-Z]+)'", sw))
client_types = set(re.findall(r'type:\s*"(TOCAFICHADR_[A-Z]+)"', api))
only_sw = sw_types - client_types
only_client = client_types - sw_types
if only_client:
    print(f"  ✗ client sends but SW doesn't handle: {only_client}")
    sys.exit(1)
if only_sw:
    print(f"  ⚠ SW handles but client never sends: {only_sw}")
print(f"  ✓ {len(client_types & sw_types)} message types consistent")
PY
[ $? -ne 0 ] && FAIL=1

# --- 6. No PII in console.log ---
echo ""
echo "[6/33] No PII in console.log..."
if find content background popup sidepanel offscreen \
  -type f -name '*.js' \
  ! -name '*.bundle.js' \
  ! -name '*.map' \
  -print0 | xargs -0 grep -nE 'console\.(log|warn|error).*(patient_name|\.cpf|paciente\.nome|authUser\.email)' 2>/dev/null; then
  echo "  ✗ PII leak found above"
  FAIL=1
else
  echo "  ✓ no PII in console logs"
fi

# --- 7. VAD math unit tests (node:test, no deps) ---
echo ""
echo "[7/33] VAD math unit tests..."
if node --test scripts/test-vad.js > /tmp/tocafichadr-vad-test.log 2>&1; then
  # Node's TAP-ish "ℹ pass N" line is the most reliable count.
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-vad-test.log)
  echo "  ✓ ${PASSED:-?} VAD test cases passed"
else
  echo "  ✗ VAD tests failed"
  cat /tmp/tocafichadr-vad-test.log
  FAIL=1
fi

# (v2.6.1 SW auth-refresh tests removed in v3.0.3 — Clerk SDK manages
# JWT rotation natively, so the _refreshInFlight + _refreshAccessToken
# logic those tests covered no longer exists.)

# --- 8. Atestado drawer tests (v3.5 chip rename + Gravar selector) ---
echo ""
echo "[8/33] Atestado drawer tests..."
if node --test scripts/test-atestado.js > /tmp/tocafichadr-atestado-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-atestado-test.log)
  echo "  ✓ ${PASSED:-?} atestado test cases passed"
else
  echo "  ✗ atestado tests failed"
  cat /tmp/tocafichadr-atestado-test.log
  FAIL=1
fi

# --- 9. Debug-log pipeline tripwires (console-shipper + SW handler + endpoint) ---
echo ""
echo "[9/33] Debug-log pipeline tests..."
if node --test scripts/test-debug-log.js > /tmp/tocafichadr-debuglog-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-debuglog-test.log)
  echo "  ✓ ${PASSED:-?} debug-log test cases passed"
else
  echo "  ✗ debug-log tests failed"
  cat /tmp/tocafichadr-debuglog-test.log
  FAIL=1
fi

# --- 10. Prescription Simples selector tripwires ---
echo ""
echo "[10/33] Prescription Simples selector tests..."
if node --test scripts/test-prescription-simples.js > /tmp/tocafichadr-prescription-simples-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-prescription-simples-test.log)
  echo "  ✓ ${PASSED:-?} prescription Simples test cases passed"
else
  echo "  ✗ prescription Simples tests failed"
  cat /tmp/tocafichadr-prescription-simples-test.log
  FAIL=1
fi

# --- 11. Phase 003 user-config-gate tripwires (gate UI + storage hygiene) ---
echo ""
echo "[11/33] User-config gate tests..."
if node --test scripts/test-config-gate.js > /tmp/tocafichadr-configgate-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-configgate-test.log)
  echo "  ✓ ${PASSED:-?} user-config gate test cases passed"
else
  echo "  ✗ user-config gate tests failed"
  cat /tmp/tocafichadr-configgate-test.log
  FAIL=1
fi

# --- 12. SW token preference tripwires (storage-first, see 2026-05-25 401 regression) ---
echo ""
echo "[12/33] SW auth token preference tests..."
if node --test scripts/test-auth-token-preference.js > /tmp/tocafichadr-authtoken-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-authtoken-test.log)
  echo "  ✓ ${PASSED:-?} SW auth token preference test cases passed"
else
  echo "  ✗ SW auth token preference tests failed"
  cat /tmp/tocafichadr-authtoken-test.log
  FAIL=1
fi

# --- 13. SOAP fence-stripping tripwires (2026-04-15 model quirk) ---
echo ""
echo "[13/33] SOAP fence stripping tests..."
if node --test scripts/test-soap-fence-stripping.js > /tmp/tocafichadr-fence-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-fence-test.log)
  echo "  ✓ ${PASSED:-?} SOAP fence stripping test cases passed"
else
  echo "  ✗ SOAP fence stripping tests failed"
  cat /tmp/tocafichadr-fence-test.log
  FAIL=1
fi

# --- 14. Medication catalog integrity (CHRA-2044: >=100 SUS/RENAME meds) ---
echo ""
echo "[14/33] Medication catalog tests..."
if node --test scripts/test-med-catalog.js > /tmp/tocafichadr-medcatalog-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-medcatalog-test.log)
  echo "  ✓ ${PASSED:-?} medication catalog test cases passed"
else
  echo "  ✗ medication catalog tests failed"
  cat /tmp/tocafichadr-medcatalog-test.log
  FAIL=1
fi

# --- 15. Offline handling tripwires (CHRA-2166: connectivity + IndexedDB queue) ---
echo ""
echo "[15/33] Offline handling tests..."
if node --test scripts/test-offline-queue.js > /tmp/tocafichadr-offline-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-offline-test.log)
  echo "  ✓ ${PASSED:-?} offline handling test cases passed"
else
  echo "  ✗ offline handling tests failed"
  cat /tmp/tocafichadr-offline-test.log
  FAIL=1
fi

# --- 16. _unescapeJsString regression (space-as-marker bug) ---
echo ""
echo "[16/33] _unescapeJsString tests..."
if node --test scripts/test-unescape-js-string.js > /tmp/tocafichadr-unescape-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-unescape-test.log)
  echo "  ✓ ${PASSED:-?} _unescapeJsString test cases passed"
else
  echo "  ✗ _unescapeJsString tests failed"
  cat /tmp/tocafichadr-unescape-test.log
  FAIL=1
fi

# --- 17. Dynamic G-Hosp content-script injection deps (CHRA-2423 Bug 28) ---
echo ""
echo "[17/33] Dynamic injection dependency order..."
if node --test scripts/test-injection-deps.js > /tmp/tocafichadr-injection-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-injection-test.log)
  echo "  ✓ ${PASSED:-?} injection dependency test cases passed"
else
  echo "  ✗ injection dependency tests failed"
  cat /tmp/tocafichadr-injection-test.log
  FAIL=1
fi

# --- 18. Realtime offscreen lifecycle re-entrancy (CHRA-2423 Bug 29) ---
echo ""
echo "[18/33] Offscreen realtime lifecycle..."
if node --test scripts/test-offscreen-lifecycle.js > /tmp/tocafichadr-offscreen-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-offscreen-test.log)
  echo "  ✓ ${PASSED:-?} offscreen lifecycle test cases passed"
else
  echo "  ✗ offscreen lifecycle tests failed"
  cat /tmp/tocafichadr-offscreen-test.log
  FAIL=1
fi

# --- 19. SOAP paste HTML-escaping (CHRA-2423 Bug 30) ---
echo ""
echo "[19/33] SOAP paste escaping..."
if node --test scripts/test-soap-paste-escaping.js > /tmp/tocafichadr-soap-paste-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-soap-paste-test.log)
  echo "  ✓ ${PASSED:-?} SOAP paste escaping test cases passed"
else
  echo "  ✗ SOAP paste escaping tests failed"
  cat /tmp/tocafichadr-soap-paste-test.log
  FAIL=1
fi

# --- 20. Connectivity feedback from failed recordings (CHRA-2423 Bug 31) ---
echo ""
echo "[20/33] Connectivity feedback..."
if node --test scripts/test-connectivity-feedback.js > /tmp/tocafichadr-conn-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-conn-test.log)
  echo "  ✓ ${PASSED:-?} connectivity feedback test cases passed"
else
  echo "  ✗ connectivity feedback tests failed"
  cat /tmp/tocafichadr-conn-test.log
  FAIL=1
fi

# --- 21. Popup recording state machine (CHRA-2423 Bug 32) ---
echo ""
echo "[21/33] Popup recording state..."
if node --test scripts/test-popup-recording-state.js > /tmp/tocafichadr-recstate-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-recstate-test.log)
  echo "  ✓ ${PASSED:-?} popup recording-state test cases passed"
else
  echo "  ✗ popup recording-state tests failed"
  cat /tmp/tocafichadr-recstate-test.log
  FAIL=1
fi

# --- 22. Popup Clerk init singleton (CHRA-2423 Bug 35) ---
echo ""
echo "[22/33] Clerk init singleton..."
if node --test scripts/test-clerk-init-singleton.js > /tmp/tocafichadr-clerkinit-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-clerkinit-test.log)
  echo "  ✓ ${PASSED:-?} Clerk init singleton test cases passed"
else
  echo "  ✗ Clerk init singleton tests failed"
  cat /tmp/tocafichadr-clerkinit-test.log
  FAIL=1
fi

# --- 23. Popup backend-URL validation (CHRA-2423 Bug 50) ---
echo ""
echo "[23/33] Popup backend-URL validation..."
if node --test scripts/test-popup-url-validation.js > /tmp/tocafichadr-popupurl-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-popupurl-test.log)
  echo "  ✓ ${PASSED:-?} popup URL validation test cases passed"
else
  echo "  ✗ popup URL validation tests failed"
  cat /tmp/tocafichadr-popupurl-test.log
  FAIL=1
fi

# --- 24. dom-engine guards (CHRA-2423 Bugs 51–53) ---
echo ""
echo "[24/33] dom-engine selector + ordering guards..."
if node --test scripts/test-dom-engine-guards.js > /tmp/tocafichadr-domengine-guards-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-domengine-guards-test.log)
  echo "  ✓ ${PASSED:-?} dom-engine guard test cases passed"
else
  echo "  ✗ dom-engine guard tests failed"
  cat /tmp/tocafichadr-domengine-guards-test.log
  FAIL=1
fi

# --- 25. sidepanel-prontuario guards (CHRA-2423 Bugs 63–64) ---
echo ""
echo "[25/33] sidepanel-prontuario applyBtn + onUpdated guards..."
if node --test scripts/test-sidepanel-prontuario-guards.js > /tmp/tocafichadr-sidepanel-guards-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-sidepanel-guards-test.log)
  echo "  ✓ ${PASSED:-?} sidepanel guard test cases passed"
else
  echo "  ✗ sidepanel guard tests failed"
  cat /tmp/tocafichadr-sidepanel-guards-test.log
  FAIL=1
fi

# --- 26. selector config parity: BUNDLED_SELECTORS ⇄ ghosp.json (CHRA-2423 Bug 70) ---
echo ""
echo "[26/33] selector config parity (bundle ⇄ ghosp.json)..."
if node --test scripts/test-selector-config-parity.js > /tmp/tocafichadr-selector-parity-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-selector-parity-test.log)
  echo "  ✓ ${PASSED:-?} selector parity test cases passed"
else
  echo "  ✗ selector parity tests failed"
  cat /tmp/tocafichadr-selector-parity-test.log
  FAIL=1
fi

# --- 27. med-catalog fallback drift detector (CHRA-2423 Bug 71 follow-up) ---
echo ""
echo "[27/33] med-catalog fallback drift detector (offline picker ⇄ backend)..."
if node --test scripts/test-med-catalog-fallback-parity.js > /tmp/tocafichadr-medcatalog-parity-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-medcatalog-parity-test.log)
  echo "  ✓ ${PASSED:-?} med-catalog drift test cases passed"
else
  echo "  ✗ med-catalog fallback drift detected"
  cat /tmp/tocafichadr-medcatalog-parity-test.log
  FAIL=1
fi

# --- 28. externally_connectable ⇄ onMessageExternal consistency (CHRA-2423 Bug 76) ---
echo ""
echo "[28/33] externally_connectable ⇄ onMessageExternal handler..."
if node --test scripts/test-externally-connectable.js > /tmp/tocafichadr-extconn-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-extconn-test.log)
  echo "  ✓ ${PASSED:-?} externally_connectable test cases passed"
else
  echo "  ✗ externally_connectable consistency failed"
  cat /tmp/tocafichadr-extconn-test.log
  FAIL=1
fi

# --- 29. Patient weight extraction (CHRA-2423 Bug 79) ---
echo ""
echo "[29/33] Patient weight extraction (neonatal grams + integer kg)..."
if node --test scripts/test-weight-extraction.js > /tmp/tocafichadr-weight-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-weight-test.log)
  echo "  ✓ ${PASSED:-?} weight extraction test cases passed"
else
  echo "  ✗ weight extraction tests failed"
  cat /tmp/tocafichadr-weight-test.log
  FAIL=1
fi

# --- 30. Audio-capture mediaStream lifecycle (CHRA-2423 Bug 80) ---
echo ""
echo "[30/33] Audio-capture mediaStream lifecycle (mic released on start() failure)..."
if node --test scripts/test-audio-capture-lifecycle.js > /tmp/tocafichadr-audiocap-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-audiocap-test.log)
  echo "  ✓ ${PASSED:-?} audio-capture lifecycle test cases passed"
else
  echo "  ✗ audio-capture lifecycle tests failed"
  cat /tmp/tocafichadr-audiocap-test.log
  FAIL=1
fi

# --- 31. Transcribe timeout budget (CHRA-2423 Bug 81) ---
echo ""
echo "[31/33] Transcribe timeout budget (SW fetch covers 7-90s envelope, under HUD race)..."
if node --test scripts/test-transcribe-timeout-budget.js > /tmp/tocafichadr-timeout-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-timeout-test.log)
  echo "  ✓ ${PASSED:-?} timeout budget test cases passed"
else
  echo "  ✗ transcribe timeout budget tests failed"
  cat /tmp/tocafichadr-timeout-test.log
  FAIL=1
fi

# --- 32. Offline-queue flush coalesce race (CHRA-2423 Bug 82) ---
echo ""
echo "[32/33] Offline-queue flush race (newer coalesced write must survive flush)..."
if node --test scripts/test-offline-queue-flush-race.js > /tmp/tocafichadr-offqueue-test.log 2>&1; then
  PASSED=$(awk '/pass [0-9]+/ {for (i=1;i<=NF;i++) if ($i=="pass") {print $(i+1); exit}}' /tmp/tocafichadr-offqueue-test.log)
  echo "  ✓ ${PASSED:-?} offline-queue race test cases passed"
else
  echo "  ✗ offline-queue flush race tests failed"
  cat /tmp/tocafichadr-offqueue-test.log
  FAIL=1
fi

# --- Summary ---
echo ""
echo "=========================================="
if [ $FAIL -eq 0 ]; then
  echo " ALL CHECKS PASSED ✓"
  exit 0
else
  echo " FAILURES ABOVE ✗"
  exit 1
fi
