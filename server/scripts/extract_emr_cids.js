/**
 * extract_emr_cids.js — Browser console script to dump G-Hosp's available CID-10 list
 *
 * Run this in Chrome DevTools Console while logged into G-Hosp
 * (prbentogoncalves.g-hosp.com.br) on any patient chart page.
 *
 * Discovered endpoint: /acs/autocomplete_cid_descricao_favs
 * This is the "favorites" CID list the UPA actually allows.
 */

(async function extractEmrCids() {
  'use strict';

  const ENDPOINT = '/acs/autocomplete_cid_descricao_favs';
  const DELAY_MS = 250; // be polite to the EMR server
  const MIN_RESULTS_THRESHOLD = 3; // if we get this many, try 2-char prefix

  // Search alphabet: single chars + common 2-char prefixes for dense sections
  const singleChars = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
  const extraPrefixes = [
    'aa','ab','ac','ad','ae','af','ag','ah','ai','aj','ak','al','am','an','ao','ap','aq','ar','as','at','au','av','ax',
    'ba','be','bi','bl','bo','br','bu','bx','ca','ce','ch','ci','cl','co','cr','cu','cx','cy','cz',
    'da','de','di','do','dr','du','dx','dy','dz','ea','eb','ec','ed','ee','ef','eg','ei','ej','el','em','en','eo','ep','eq','er','es','et','eu','ev','ex','ey','ez',
    'fa','fe','fi','fl','fo','fr','fu','fx','ga','ge','gi','gl','go','gr','gu','gy','gz',
    'ha','he','hi','ho','hr','hu','hx','hy','ia','ib','ic','id','ie','if','ig','ih','ii','ij','il','im','in','io','ip','iq','ir','is','it','iu','iv','ix','iz',
    'ja','je','ji','jo','ju','ka','ke','ki','kl','ko','kr','ku','la','le','li','lo','lu','lx','ly','ma','me','mi','mn','mo','mu','mx','my','na','ne','ni','no','nu','nx','ny','oa','ob','oc','od','oe','of','og','oh','oi','oj','ok','ol','om','on','oo','op','oq','or','os','ot','ou','ov','ox','oy','oz',
    'pa','pb','pc','pe','ph','pi','pl','pn','po','pp','pr','ps','pt','pu','py','qa','qe','qi','qu','ra','re','ri','ro','ru','rx','ry','sa','sb','sc','se','sg','sh','si','sk','sl','sm','sn','so','sp','sq','sr','ss','st','su','sv','sw','sy','ta','tb','tc','te','th','ti','to','tr','ts','tu','tx','ty','ua','ub','uc','ud','ue','uf','ug','uh','ui','uj','ul','um','un','uo','up','uq','ur','us','ut','uu','uv','ux','uz',
    'va','vc','ve','vi','vo','vu','wa','we','wi','wo','wu','xa','xe','xi','xo','xu','ya','ye','yi','yo','yu','za','ze','zi','zo','zu'
  ];

  const allCodes = new Map(); // code -> name
  let requestsMade = 0;

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function fetchTerm(term) {
    const url = `${location.origin}${ENDPOINT}?term=${encodeURIComponent(term)}`;
    try {
      const resp = await fetch(url, {
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*;q=0.01',
        },
      });
      if (!resp.ok) {
        console.warn(`HTTP ${resp.status} for term "${term}"`);
        return [];
      }
      const data = await resp.json();
      requestsMade++;
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn(`Fetch failed for term "${term}":`, e.message);
      return [];
    }
  }

  function record(items) {
    for (const item of items) {
      // Handle both {id, label, value} and {id, name, code} shapes
      const code = (item.value || item.code || item.id || '').toString().trim();
      const label = (item.label || item.name || item.descricao || '').toString().trim();
      if (!code) continue;
      // Extract name from "J00 - Nasofaringite aguda" format
      let name = label;
      const dashMatch = label.match(/^\s*[^\s]+\s*[-–]\s*(.+)$/);
      if (dashMatch) name = dashMatch[1];
      if (!allCodes.has(code)) {
        allCodes.set(code, name);
      }
    }
  }

  // Phase 1: single-character prefixes
  console.log('[CID Extractor] Phase 1: single-character prefixes...');
  for (const ch of singleChars) {
    const items = await fetchTerm(ch);
    record(items);
    if (items.length > 0) {
      console.log(`  "${ch}" → ${items.length} results (total unique: ${allCodes.size})`);
    }
    await sleep(DELAY_MS);
  }

  // Phase 2: two-character prefixes for dense buckets (where single char returned many results)
  console.log('[CID Extractor] Phase 2: two-character prefixes...');
  let twoCharRequests = 0;
  for (const prefix of extraPrefixes) {
    const firstChar = prefix[0];
    // Only drill down if the first char bucket had substantial results
    // (We don't have per-bucket counts, so we just run a subset of dense medical prefixes)
    if (twoCharRequests > 200) break; // safety cap
    const items = await fetchTerm(prefix);
    record(items);
    if (items.length > 0) {
      console.log(`  "${prefix}" → ${items.length} results (total unique: ${allCodes.size})`);
    }
    twoCharRequests++;
    await sleep(DELAY_MS);
  }

  // Phase 3: numeric CID chapter prefixes (A00, B01, C20, J00, etc.)
  console.log('[CID Extractor] Phase 3: CID chapter prefixes...');
  const chapters = [
    'A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','V','W','X','Y','Z'
  ];
  for (const ch of chapters) {
    for (let i = 0; i <= 9; i++) {
      const term = `${ch}${i}`;
      const items = await fetchTerm(term);
      record(items);
      if (items.length > 0) {
        console.log(`  "${term}" → ${items.length} results (total unique: ${allCodes.size})`);
      }
      await sleep(DELAY_MS);
    }
  }

  // Output
  const sorted = Array.from(allCodes.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const jsonOutput = sorted.map(([code, name]) => ({ code, name }));

  console.log('\n========== EXTRACTION COMPLETE ==========');
  console.log(`Requests made: ${requestsMade}`);
  console.log(`Unique CID codes found: ${sorted.length}`);
  console.log('\n--- JSON array (copy this) ---');
  console.log(JSON.stringify(jsonOutput, null, 2));

  // Also output as cid.js format
  const cidJsLines = sorted.map(([code, name]) => `  { code: "${code}", name: "${name}" },`);
  console.log('\n--- cid.js format (copy this) ---');
  console.log('const EMR_CID_LIST = [');
  console.log(cidJsLines.join('\n'));
  console.log('];');

  // Download as file
  const blob = new Blob([JSON.stringify(jsonOutput, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `emr_cid_extract_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  return jsonOutput;
})();
