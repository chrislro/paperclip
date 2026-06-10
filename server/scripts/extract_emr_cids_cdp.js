#!/usr/bin/env node
/**
 * extract_emr_cids_cdp.js — Extract G-Hosp CID list via Chrome Remote Debugging Protocol
 *
 * Chrome is running with --remote-debugging-port=9222
 * This script connects directly to the browser (no cookie needed).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const ENDPOINT = '/acs/autocomplete_cid_descricao_favs';
const DELAY_MS = 250;

function fetchJsonList() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json/list`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function extractCids(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const codes = new Map();
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
    let idx = 0;
    let finished = false;

    function sendEvaluate(term) {
      const expr = `
        (async function() {
          try {
            const r = await fetch('${ENDPOINT}?term=' + encodeURIComponent('${term}'), {
              credentials: 'same-origin',
              headers: { 'X-Requested-With': 'XMLHttpRequest' }
            });
            const data = await r.json();
            return { ok: true, term: '${term}', data };
          } catch (e) {
            return { ok: false, term: '${term}', error: e.message };
          }
        })()
      `;
      ws.send(JSON.stringify({
        id: ++msgId,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise: true, returnByValue: true }
      }));
    }

    function next() {
      if (idx >= chars.length) {
        if (finished) return;
        finished = true;
        ws.close();
        const sorted = Array.from(codes.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        const output = sorted.map(([code, name]) => ({ code, name }));
        resolve(output);
        return;
      }
      sendEvaluate(chars[idx++]);
    }

    ws.onopen = () => {
      console.log(`[CDP] Connected. Fetching ${chars.length} prefixes...`);
      next();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.result && msg.result.result && msg.result.result.value) {
        const val = msg.result.result.value;
        if (val.ok && Array.isArray(val.data)) {
          for (const item of val.data) {
            const code = String(item.value || item.id || item.code || '').trim();
            let name = String(item.label || item.name || '').trim();
            const m = name.match(/^[^-]+-\s*(.+)$/);
            if (m) name = m[1];
            if (code) codes.set(code, name);
          }
          console.log(`  "${val.term}" → ${val.data.length} results (total unique: ${codes.size})`);
        } else {
          console.warn(`  "${val.term}" failed: ${val.error || 'unknown'}`);
        }
      }
      setTimeout(next, DELAY_MS);
    };

    ws.onerror = (err) => reject(new Error('WebSocket error: ' + err.message));
    ws.onclose = () => {
      if (!finished) {
        finished = true;
        const sorted = Array.from(codes.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        resolve(sorted.map(([code, name]) => ({ code, name })));
      }
    };
  });
}

async function main() {
  try {
    const tabs = await fetchJsonList();
    const ghospTab = tabs.find(t => t.url && t.url.includes('g-hosp.com.br'));
    if (!ghospTab) {
      console.error('ERROR: No G-Hosp tab found in Chrome. Make sure you are logged in.');
      process.exit(1);
    }
    console.log(`[CDP] Found tab: ${ghospTab.title} (${ghospTab.url})`);

    const results = await extractCids(ghospTab.webSocketDebuggerUrl);

    const outFile = path.join(__dirname, `emr_cids_extracted_${new Date().toISOString().slice(0,10)}.json`);
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf-8');

    console.log(`\n========== DONE ==========`);
    console.log(`Unique CIDs found: ${results.length}`);
    console.log(`Saved to: ${outFile}`);
    console.log('\nFirst 10:');
    results.slice(0, 10).forEach(c => console.log(`  ${c.code} - ${c.name}`));
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
}

main();
