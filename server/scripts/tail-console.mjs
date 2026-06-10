#!/usr/bin/env node
// tail-console.mjs — live stream of console.* + page errors from any/all
// Toca Ficha Dr. extension contexts via Chrome DevTools Protocol.
//
// Usage:
//   node scripts/tail-console.mjs                  # all relevant targets
//   node scripts/tail-console.mjs ghosp            # only G-Hosp tab
//   node scripts/tail-console.mjs sidepanel        # only side panel page
//   node scripts/tail-console.mjs sw               # only service worker
//   node scripts/tail-console.mjs --grep 'simples' # filter messages
//
// Ctrl+C to stop. Subscribes to Runtime.consoleAPICalled +
// Runtime.exceptionThrown so it catches both console.* and uncaught errors.

const CDP_HOST = process.env.TOCAF_CDP || 'http://localhost:9222';
const args = process.argv.slice(2);
const grepIdx = args.indexOf('--grep');
const grep = grepIdx >= 0 ? new RegExp(args[grepIdx + 1], 'i') : null;
const wanted = new Set(args.filter(a => !a.startsWith('--') && a !== (grep && args[grepIdx + 1])));
if (wanted.size === 0) { wanted.add('ghosp'); wanted.add('sidepanel'); wanted.add('sw'); wanted.add('popup'); }

function classify(t) {
  if (t.type === 'service_worker' && t.url.includes('/background/service-worker')) return 'sw';
  if (t.type === 'page' && /sidepanel\/sidepanel\.html/.test(t.url)) return 'sidepanel';
  if (t.type === 'page' && /popup\/popup\.html/.test(t.url)) return 'popup';
  if (t.type === 'page' && /prbentogoncalves\.g-hosp\.com\.br/.test(t.url)) return 'ghosp';
  return null;
}

function fmt(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function colorize(level) {
  const COLOR = { error: '\x1b[31m', warning: '\x1b[33m', info: '\x1b[36m', log: '', debug: '\x1b[90m' };
  return COLOR[level] || '';
}
const RESET = '\x1b[0m';

async function listTargets() {
  const r = await fetch(`${CDP_HOST}/json/list`);
  return await r.json();
}

function attach(target, label) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.enable' }));
    console.log(`\x1b[90m[attached] ${label.padEnd(10)} ${target.url.slice(0, 80)}${RESET}`);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params;
      const args = (p.args || []).map(a => {
        if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
        if (a.description) return a.description;
        if (a.preview) return JSON.stringify(a.preview);
        return a.type;
      }).join(' ');
      if (grep && !grep.test(args)) return;
      console.log(`${colorize(p.type)}${fmt(p.timestamp)} ${label.padEnd(10)} ${p.type.padEnd(7)} ${args}${RESET}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const e = msg.params.exceptionDetails;
      const text = (e.exception && (e.exception.description || e.exception.value)) || e.text || '(unknown exception)';
      if (grep && !grep.test(text)) return;
      console.log(`\x1b[41m\x1b[37m${fmt(msg.params.timestamp)} ${label.padEnd(10)} EXCEPTION ${text}${RESET}`);
    }
  };
  ws.onerror = (e) => console.error(`[${label}] ws error:`, e.message || e);
  ws.onclose = () => console.log(`\x1b[90m[detached] ${label}${RESET}`);
  return ws;
}

async function main() {
  const targets = await listTargets();
  const sockets = [];
  for (const t of targets) {
    const cls = classify(t);
    if (!cls || !wanted.has(cls)) continue;
    sockets.push(attach(t, cls));
  }
  if (sockets.length === 0) {
    console.error('No matching targets. Available types:', [...new Set(targets.map(classify).filter(Boolean))].join(', '));
    process.exit(1);
  }
  process.on('SIGINT', () => { for (const s of sockets) s.close(); process.exit(0); });
  // Keep alive
  await new Promise(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
