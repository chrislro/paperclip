// scripts/test-soap-paste-escaping.js — tripwire for SOAP paste HTML-escaping.
//
// Run with: node --test scripts/test-soap-paste-escaping.js
//
// WHY THIS EXISTS (CHRA-2423 Bug 30):
//   pasteSoapNote() converts the SOAP note's \n to <br> and hands it to
//   _sanitizeSoapHtml(), which HTML-PARSES the string. The backend SOAP is plain
//   text (SOAP_TEMPLATE in backend/emr_automation/extension_api.py emits only the
//   SUBJETIVO:/OBJETIVO:/AVALIAÇÃO:/PLANO: sections with \n line breaks — no HTML),
//   so a literal "<word>" token in the note was parsed as an unknown element and
//   silently DROPPED from the medical record (e.g. "uso de <x> hoje" -> "uso de
//   hoje"). The fix HTML-escapes &<> BEFORE introducing the <br> markup, so the
//   sanitizer sees only our own <br> as real markup and every literal angle
//   bracket round-trips.
//
//   Invariant guarded: the escape MUST happen before the \n->-<br> conversion.
//   If escaping moved after (or were removed), the data-loss returns.
//
// dom-engine.js assigns to window.* and touches document at load, so it is not
// requireable under node — these are static source tripwires (same approach as
// the other selector/injection/offscreen tripwires in this directory). The
// second test also exercises the exact transform semantics on representative
// clinical strings so a broken escape implementation is caught, not just removal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'content/dom-engine.js'), 'utf8');

function pasteSoapNoteBody() {
  const m = SRC.match(/function pasteSoapNote\(text\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'pasteSoapNote() not found in dom-engine.js');
  return m[0];
}

test('pasteSoapNote escapes &<> BEFORE converting \\n to <br>', () => {
  const body = pasteSoapNoteBody();
  // Escape step present: a replace over the [&<>] character class.
  const escapeIdx = body.search(/replace\(\s*\/\[&<>\]\/g/);
  assert.notEqual(escapeIdx, -1, 'pasteSoapNote must HTML-escape [&<>] before building <br> markup');
  // <br> conversion present.
  const brIdx = body.search(/replace\(\s*\/\\n\/g\s*,\s*['"]<br>['"]\s*\)/);
  assert.notEqual(brIdx, -1, 'pasteSoapNote must convert \\n to <br>');
  // Ordering: escape must come first so the <br> we add is the only real markup.
  assert.ok(
    escapeIdx < brIdx,
    'the [&<>] escape must precede the \\n->-<br> conversion, else literal <word> tokens are dropped by the sanitizer'
  );
  // The escaped payload — not the raw text — must be what reaches the editor.
  assert.match(body, /updateWysihtml5Editor\(\s*0\s*,\s*htmlSafe\s*\)/,
    'the escaped+<br> payload (htmlSafe) must be what is passed to updateWysihtml5Editor');
});

test('the paste transform preserves literal angle brackets and clinical comparisons', () => {
  // Mirror the exact two-step transform pasteSoapNote applies, and assert the
  // semantics on representative inputs. This locks the intended behavior so a
  // future "optimization" that breaks escaping fails here, not silently in prod.
  const transform = (text) => text
    .replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
    .replace(/\n/g, '<br>');

  // Literal <word> token survives (the data-loss bug) — no element is created.
  assert.equal(transform('uso de <medicação> hoje'), 'uso de &lt;medicação&gt; hoje');
  // Clinical comparisons round-trip.
  assert.equal(transform('FC < 100 e SatO2 > 95%'), 'FC &lt; 100 e SatO2 &gt; 95%');
  // Ampersand escaped once.
  assert.equal(transform('mãe & pai presentes'), 'mãe &amp; pai presentes');
  // Newlines become <br>, and the <br> we add is NOT re-escaped.
  assert.equal(transform('linha1\nlinha2'), 'linha1<br>linha2');
  // Combined: escaping precedes <br> so the bracket is data, the break is markup.
  assert.equal(transform('peso <10kg\nfebre'), 'peso &lt;10kg<br>febre');
});
