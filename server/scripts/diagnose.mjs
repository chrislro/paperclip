#!/usr/bin/env node
// diagnose.mjs — autonomous diagnostic runner for the Toca Ficha Dr. extension.
//
// Connects to the developer Chrome on localhost:9222 (CDP) and executes
// targeted JavaScript in each runtime context. The side panel context is
// used as a proxy to ping the content-script bridge in the G-Hosp tab,
// because content-script globals live in an isolated world that CDP's
// page-level Runtime.evaluate cannot see directly.
//
// Usage:
//   node scripts/diagnose.mjs               # full report
//   node scripts/diagnose.mjs --raw         # also dump raw target list
//   node scripts/diagnose.mjs --rx          # also exercise prescription flow
//   node scripts/diagnose.mjs --weight      # also check weight extraction
//
// Prerequisite: Chrome must be running with `--remote-debugging-port=9222`
// (verified live: the developer launcher already does this).

const CDP_HOST = process.env.TOCAF_CDP || 'http://localhost:9222';

async function listTargets() {
  const r = await fetch(`${CDP_HOST}/json/list`);
  if (!r.ok) throw new Error(`CDP /json/list HTTP ${r.status}`);
  return await r.json();
}

function openTarget(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    ws.onerror = (e) => reject(new Error('WebSocket error: ' + (e.message || 'unknown')));
    ws.onopen = async () => {
      function send(method, params) {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      }
      try { await send('Runtime.enable'); } catch {}
      async function evaluate(expression) {
        const r = await send('Runtime.evaluate', {
          expression: `(async () => { try { return await (${expression}); } catch (e) { return { __error: e && e.message || String(e), stack: e && e.stack }; } })()`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) {
          return { __error: r.exceptionDetails.exception?.description || 'evaluate exception', exception: r.exceptionDetails };
        }
        return r.result?.value;
      }
      function close() { try { ws.close(); } catch {} }
      resolve({ evaluate, close });
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const showRaw = args.includes('--raw');
  const probeRx = args.includes('--rx');
  const probeWeight = args.includes('--weight');

  const targets = await listTargets();
  if (showRaw) {
    console.log('=== ALL TARGETS ===');
    for (const t of targets) console.log(`${t.type.padEnd(14)} ${t.id.slice(0,8)} ${t.url.slice(0, 100)}`);
    console.log('');
  }

  const ghosp = targets.find(t => t.type === 'page' && /prbentogoncalves\.g-hosp\.com\.br/.test(t.url));
  const sidepanel = targets.find(t => t.type === 'page' && /sidepanel\/sidepanel\.html/.test(t.url));
  const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('/background/service-worker'));

  const report = {
    timestamp: new Date().toISOString(),
    targets_found: { ghosp: !!ghosp, sidepanel: !!sidepanel, sw: !!sw },
  };

  // Side panel is the proxy — it owns the chrome.tabs.sendMessage channel
  // to the content-script bridge AND has chrome.storage access.
  if (sidepanel) {
    const ctx = await openTarget(sidepanel.webSocketDebuggerUrl);

    report.sidepanel = {
      url: sidepanel.url,
      ext_version: await ctx.evaluate(`chrome.runtime.getManifest().version`),
      ext_id: await ctx.evaluate(`chrome.runtime.id`),
      api_base_url: await ctx.evaluate(`new Promise(r => chrome.storage.sync.get(['apiBaseUrl'], d => r(d.apiBaseUrl || null)))`),
      g_hosp_tabs: await ctx.evaluate(`new Promise(r => chrome.tabs.query({url:'https://prbentogoncalves.g-hosp.com.br/*'}, t => r(t.map(x => ({id:x.id, active:x.active, url:x.url})))))`),
      token: await ctx.evaluate(`new Promise(r => chrome.storage.session.get(['authToken'], d => {
        const t = d.authToken;
        if (!t) return r({present:false});
        let payload = null;
        try { payload = JSON.parse(atob(t.split('.')[1])); } catch {}
        r({
          present: true,
          length: t.length,
          iss: payload && payload.iss,
          sub: payload && payload.sub,
          azp: payload && payload.azp,
          exp_iso: payload && payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
          expired: payload && payload.exp ? (payload.exp * 1000 < Date.now()) : null,
          seconds_until_exp: payload && payload.exp ? Math.round((payload.exp * 1000 - Date.now()) / 1000) : null,
        });
      }))`),
      clerk_user_email: await ctx.evaluate(`window.TOCAFICHADR_clerk && window.TOCAFICHADR_clerk.user && window.TOCAFICHADR_clerk.user.primaryEmailAddress && window.TOCAFICHADR_clerk.user.primaryEmailAddress.emailAddress`),
    };

    // Ask the bridge in the G-Hosp tab for live state. This proves content
    // scripts are loaded AND returns the patient info from the isolated world.
    const tabId = (report.sidepanel.g_hosp_tabs && report.sidepanel.g_hosp_tabs[0] && report.sidepanel.g_hosp_tabs[0].id) || null;
    if (tabId !== null) {
      report.bridge = await ctx.evaluate(`new Promise(r => {
        let done = false;
        const timeout = setTimeout(() => { if (!done) r({error:'bridge timeout after 3s — content scripts may be uninjected'}); done = true; }, 3000);
        try {
          chrome.tabs.sendMessage(${tabId}, {type:'SIDEPANEL_GET_PATIENT'}, (resp) => {
            if (done) return;
            done = true; clearTimeout(timeout);
            if (chrome.runtime.lastError) return r({error: chrome.runtime.lastError.message});
            r({ok:true, response: resp});
          });
        } catch (e) {
          if (!done) { done = true; clearTimeout(timeout); r({error: e.message}); }
        }
      })`);

      // Live API ping with the current token — verifies backend accepts us.
      report.api_ping = await ctx.evaluate(`(async () => {
        try {
          const tok = (await new Promise(r => chrome.storage.session.get(['authToken'], d => r(d.authToken))));
          if (!tok) return {error: 'no token in storage'};
          const r = await fetch('https://api.tocafichadr.com.br/api/me/config', {
            headers: { Authorization: 'Bearer ' + tok },
            signal: AbortSignal.timeout(5000),
          });
          const text = await r.text();
          return { status: r.status, body_len: text.length, body_first_200: text.slice(0, 200) };
        } catch (e) { return { error: e.message }; }
      })()`);

      if (probeWeight) {
        // Drive the bridge through the patient-info call and pull the
        // weight scan stripped from the live page body. Also surface what
        // BUNDLED weight_patterns are currently in use.
        report.weight_probe = await ctx.evaluate(`new Promise(r => {
          chrome.tabs.sendMessage(${tabId}, {type:'SIDEPANEL_GET_PATIENT'}, (resp) => {
            if (chrome.runtime.lastError) return r({error: chrome.runtime.lastError.message});
            r({patient: resp && resp.info});
          });
        })`);
      }

      if (probeRx) {
        // SIDEPANEL_RUN_TEMPLATE with a synthetic template — verifies the
        // prescription open path end-to-end. Body is harmless filler text so
        // a real prescription wouldn't be saved unless the user clicks
        // Finalizar Receita.
        report.rx_open = await ctx.evaluate(`new Promise(r => {
          let done = false;
          const timeout = setTimeout(() => { if (!done) r({error:'rx open timeout 20s'}); done = true; }, 20000);
          chrome.tabs.sendMessage(${tabId}, {
            type:'SIDEPANEL_RUN_TEMPLATE',
            template: { id:'tpl_diag', diagnosis:'__DIAG_PROBE__', ageBand:'', body:'__diagnostic_probe_body__\\nfor testing only — do not save' }
          }, (resp) => {
            if (done) return;
            done = true; clearTimeout(timeout);
            if (chrome.runtime.lastError) return r({error: chrome.runtime.lastError.message});
            r(resp);
          });
        })`);
      }
    } else {
      report.bridge = { error: 'no G-Hosp tab found' };
    }

    ctx.close();
  }

  if (sw) {
    const ctx = await openTarget(sw.webSocketDebuggerUrl);
    report.sw_ping = await ctx.evaluate(`'sw-reachable'`);
    ctx.close();
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('DIAGNOSE ERROR:', e.message); process.exit(1); });
