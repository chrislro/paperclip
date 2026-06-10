#!/usr/bin/env node
// test-cua.mjs — exercise the Toca Ficha Dr. extension UI via Cua Driver
// (screenshots, AX-tree clicks) AND CDP (DOM, JS evaluation). The two
// halves complement each other: Cua sees pixels + native macOS surfaces,
// CDP sees the Chrome JS heap.
//
// Prerequisites:
//   1. Cua Driver daemon running with Accessibility + Screen Recording
//      grants — start: `open -n -g -a CuaDriver --args serve`
//      Verify: `cua-driver doctor`
//   2. Chrome running with --remote-debugging-port=9222 + the dev logger
//      profile (the existing setup at /Users/admin/.tocafichadr-chrome-profile-logger)
//
// Usage:
//   node scripts/test-cua.mjs              # full smoke suite
//   node scripts/test-cua.mjs --shot       # just take a screenshot
//   node scripts/test-cua.mjs --windows    # just list relevant windows
//
// Outputs to /tmp/tocaf-cua-<timestamp>/

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const execp = promisify(exec);
const DRIVER = '/Users/admin/.local/bin/cua-driver';
const TS = Date.now();
const OUT = `/tmp/tocaf-cua-${TS}`;

// ── Cua wrapper ──────────────────────────────────────────────────────────
async function cua(tool, args = {}, extra = '') {
  const argsJson = JSON.stringify(args).replace(/'/g, "'\\''");
  try {
    const { stdout } = await execp(`${DRIVER} call ${tool} '${argsJson}' ${extra}`, { maxBuffer: 50 << 20 });
    // Many tools return a human banner like "✅ <summary>" — keep it for logs,
    // but also try to parse JSON if the body looks structured.
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}
    return { ok: true, raw: stdout, parsed };
  } catch (e) {
    return { ok: false, error: e.message, stderr: (e.stderr || '').slice(0, 500) };
  }
}

// ── CDP wrapper (re-uses existing diagnose.mjs output) ───────────────────
async function cdp() {
  const { stdout } = await execp(`node ${join('/Users/admin/Dev/tocafichadr-extension/scripts/diagnose.mjs')}`, { maxBuffer: 10 << 20 });
  return JSON.parse(stdout);
}

async function step(label, fn) {
  const t0 = Date.now();
  process.stdout.write(`▶ ${label} `);
  const r = await fn();
  console.log(`(${Date.now() - t0}ms)`);
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  await mkdir(OUT, { recursive: true });
  console.log(`Output dir: ${OUT}\n`);

  // 0. Permission probe via the daemon (calls through the live socket so TCC
  //    is checked against CuaDriver.app, not this shell)
  // doctor exits 1 when "bundle attribution" is wrong (CLI vs CuaDriver.app)
  // even though the actual daemon-side tool calls work. Capture stdout
  // regardless of exit code so we can verify the ✅ markers ourselves.
  const doctor = await step('cua-driver doctor', async () => {
    try {
      const { stdout } = await execp(`${DRIVER} doctor`, { maxBuffer: 1 << 20 });
      return stdout;
    } catch (e) {
      return e.stdout || '';
    }
  });
  await writeFile(join(OUT, '00-doctor.txt'), doctor);
  if (!/✅ Accessibility/.test(doctor) || !/✅ Screen Recording/.test(doctor)) {
    console.error('Permissions not granted to CuaDriver.app — see 00-doctor.txt');
    process.exitCode = 1; return;
  }

  // 1. Discover Chrome windows
  const windows = await step('list_windows', () => cua('list_windows'));
  await writeFile(join(OUT, '01-windows.json'), windows.raw);
  // Filter to the dev logger Chrome (it's the one that has the extension loaded)
  let chromeWindows = [];
  try {
    const data = JSON.parse(windows.raw);
    chromeWindows = (data.windows || []).filter(w => /Chrome/.test(w.app_name || ''));
  } catch {}
  console.log(`  Found ${chromeWindows.length} Chrome window(s) across all profiles`);
  if (args.includes('--windows')) return;

  // 2. CDP — confirm extension state (the diagnose.mjs already wraps the
  //    isolated-world bridge ping, token decode, and live API check)
  const diag = await step('CDP diagnose', () => cdp());
  await writeFile(join(OUT, '02-cdp.json'), JSON.stringify(diag, null, 2));
  const internId = diag?.bridge?.response?.info?.internId ?? null;
  console.log(`  CDP version=${diag?.sidepanel?.ext_version} | token_ok=${!diag?.sidepanel?.token?.expired} | api=${diag?.api_ping?.status} | patient=${internId}`);

  // 3. The dev logger Chrome (the one with the extension loaded) is the
  //    process that owns the CDP debugging port 9222 — by definition. The
  //    user's main Chrome may also have G-UPA tabs open, but only the
  //    logger has the extension. Filter to that pid.
  const loggerPid = await step('find logger Chrome pid (owns :9222)', async () => {
    try {
      const { stdout } = await execp(`lsof -nP -iTCP:9222 -sTCP:LISTEN -t`);
      return parseInt(stdout.trim().split('\n')[0], 10) || null;
    } catch { return null; }
  });
  if (!loggerPid) {
    console.error('No process owns localhost:9222 — start the dev logger Chrome first');
    process.exitCode = 1; return;
  }
  console.log(`  Logger Chrome pid: ${loggerPid}`);

  const loggerWindows = chromeWindows.filter(w => w.pid === loggerPid);
  const gupaWindow = loggerWindows.find(w => /G-UPA/.test(w.title || '')) || loggerWindows[0];
  if (!gupaWindow) {
    console.error(`Logger Chrome pid ${loggerPid} has no windows visible to Cua`);
    process.exitCode = 1; return;
  }
  console.log(`  Target window: pid=${gupaWindow.pid} window_id=${gupaWindow.window_id} title=${JSON.stringify(gupaWindow.title || '')}`);

  // 4. Screenshot (Cua's superpower over CDP — it captures the REAL pixels,
  //    including side-panel UI, OS chrome, and anything Chrome doesn't expose
  //    to its own DevTools).
  const shotPath = join(OUT, '03-gupa-window.png');
  await step('screenshot G-UPA window', () => cua(
    'screenshot',
    { pid: gupaWindow.pid, window_id: gupaWindow.window_id },
    `--screenshot-out-file ${shotPath}`
  ));
  console.log(`  Saved: ${shotPath}`);
  if (args.includes('--shot')) return;

  // 5. Cua's `page` tool falls back to AX-tree filtering when "Allow
  //    JavaScript from Apple Events" is OFF in Chrome (we deliberately
  //    leave it off — CDP already gives us full JS reach). Skip page DOM
  //    queries here; document the choice in 05-readme.txt.
  await writeFile(join(OUT, '05-readme.txt'),
    'page tool not used: Chrome\'s "Allow JS from Apple Events" pref is OFF by design — DOM access goes through CDP via diagnose.mjs.\n');

  // 6. Side-panel-state via CDP — the proxy that reaches the isolated
  //    world. We already have it in diag.bridge; surface it for the
  //    artifact bundle.
  await writeFile(join(OUT, '06-bridge.json'), JSON.stringify(diag.bridge, null, 2));

  console.log(`\n✓ Test artifacts: ${OUT}`);
  console.log('  00-doctor.txt        — TCC + AX smoke test');
  console.log('  01-windows.json      — every Chrome window Cua can see');
  console.log('  02-cdp.json          — full extension diagnostic');
  console.log('  03-gupa-window.png   — live pixel capture of G-Hosp + side panel');
  console.log('  06-bridge.json       — content-script bridge response');
}

main().catch(e => { console.error(e); process.exit(1); });
