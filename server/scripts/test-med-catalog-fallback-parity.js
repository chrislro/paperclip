// scripts/test-med-catalog-fallback-parity.js — CHRA-2423 (Bug 71 follow-up)
//
// Run with: node --test scripts/test-med-catalog-fallback-parity.js
//
// DRIFT DETECTOR (not a clean parity assertion). The popup's offline
// `_MED_CATALOG_FALLBACK` (popup.src.js) is the static med picker shown when the
// /api/dosages catalog fetch fails (backend down / token-not-ready / >6s). A med
// the doctor picks there is saved into the template as `{ medId }` with NO name
// (popup.src.js:1228), so at apply-time an id the backend catalog
// (PEDIATRIC_MEDICATIONS/ADULT_MEDICATIONS in routes.py) does not serve renders
// the literal "[Medicação <id> não encontrada]" — the same failure as Bug 71.
//
// The fallback and backend currently use DIFFERENT id schemes (popup `azitro_adult`
// vs backend `azithromycin_adult`), so 18 fallback ids do not resolve. Fixing them
// is NOT a mechanical rename: e.g. `amoxclav_ped` (pediatric) name-matches
// `amox_clav_adult` (adult) — a naive remap would give a child an adult dose, and
// several ids have no correct backend variant at all. That remap needs clinical
// validation by the owner (and may require ADDING missing pediatric variants to the
// backend catalog). Tracked as a follow-up; deliberately not auto-fixed.
//
// This test PINS the current known divergence so it cannot silently grow: it fails
// if a NEW fallback id drifts (add the backend entry or fix the id) OR if a known
// one is resolved (good news — remove it from KNOWN_DIVERGENCE).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Backend catalog ids — textual parse of routes.py (avoids importing Flask).
function backendCatalogIds() {
  const py = fs.readFileSync(
    path.join(ROOT, 'backend/emr_automation/dashboard/routes.py'), 'utf8');
  return new Set([...py.matchAll(/"id":\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
}

// _MED_CATALOG_FALLBACK ids — every med entry carries an `is_adult:` flag.
function fallbackIds() {
  const js = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');
  const ids = js.split('\n')
    .filter((l) => /is_adult:/.test(l))
    .map((l) => (l.match(/id: "([a-z0-9_]+)"/) || [])[1])
    .filter(Boolean);
  return [...new Set(ids)];
}

// The known, clinically-pending divergence (CHRA-2423). Shrink this list as the
// owner validates each mapping / adds the missing backend variant. It must never
// GROW silently — that's what this test guards.
const KNOWN_DIVERGENCE = [
  'albendazol_ped', 'amoxclav_adult', 'amoxclav_ped', 'azitro_adult',
  'bromoprida_adult', 'cefalex_adult', 'cipro_adult', 'dexa_adult',
  'diclofenaco_adult', 'ibu_adult', 'loratadina_adult', 'metronidazol_ped',
  'omeprazol_adult', 'ondansetrona_adult', 'predniso_adult',
  'salbutamol_neb_adult', 'smxtmp_adult', 'smxtmp_ped',
].sort();

test('_MED_CATALOG_FALLBACK ↔ backend divergence matches the documented known set', () => {
  const backend = backendCatalogIds();
  const missing = fallbackIds().filter((id) => !backend.has(id)).sort();

  const newlyBroken = missing.filter((id) => !KNOWN_DIVERGENCE.includes(id));
  assert.deepEqual(
    newlyBroken, [],
    'NEW _MED_CATALOG_FALLBACK id(s) absent from the backend catalog — a med '
      + 'picked offline would render "[Medicação não encontrada]" at apply-time. '
      + 'Add the backend catalog entry or correct the fallback id: ' + newlyBroken.join(', '));

  const resolved = KNOWN_DIVERGENCE.filter((id) => !missing.includes(id));
  assert.deepEqual(
    resolved, [],
    'These previously-diverged fallback ids now resolve — good. Remove them from '
      + 'KNOWN_DIVERGENCE in this test: ' + resolved.join(', '));
});
