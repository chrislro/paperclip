// content.js — Entry point do Toca Ficha Dr. (injetado em todas as páginas do G-Hosp)

(async function() {
  'use strict';

  if (!window.TOCAFICHADR_dom || !window.TOCAFICHADR_hud) {
    console.error('[Toca Ficha Dr.] Dependências não carregadas (TOCAFICHADR_dom ou TOCAFICHADR_hud ausentes). Abortando.');
    return;
  }

  // Carrega seletores do backend (com fallback para bundled)
  try {
    await window.TOCAFICHADR_dom.loadSelectors();
  } catch (err) {
    console.warn('[Toca Ficha Dr.] Falha ao carregar seletores do backend; usando bundled.', err);
  }

  // Inicializa o painel HUD
  window.TOCAFICHADR_hud.createHUD();

  // Observa mudanças de URL (G-Hosp usa navegação SPA)
  setupPageObserver();

  // Configuração inicial
  autoSetupPatientPage();
  const _testModeListener = await setupTestMode();
  if (_testModeListener) {
    window.addEventListener('beforeunload', () => {
      chrome.storage.onChanged.removeListener(_testModeListener);
    }, { once: true });
  }

  async function setupTestMode() {
    let listener = null;
    try {
      const { testMode } = await chrome.storage.sync.get(['testMode']);
      if (testMode) {
        document.body.classList.add('tfdr-test-mode');
        if (window.TOCAFICHADR_hud && window.TOCAFICHADR_hud.injectTestBanner) {
          window.TOCAFICHADR_hud.injectTestBanner();
        }
      }
      // Listen for live toggles
      listener = (changes, area) => {
        if (area === 'sync' && changes.testMode) {
          const on = !!changes.testMode.newValue;
          document.body.classList.toggle('tfdr-test-mode', on);
          const banner = document.getElementById('tfdr-test-banner');
          if (banner) {
            banner.style.display = on ? '' : 'none';
          } else if (on && window.TOCAFICHADR_hud && window.TOCAFICHADR_hud.injectTestBanner) {
            window.TOCAFICHADR_hud.injectTestBanner();
          }
        }
      };
      chrome.storage.onChanged.addListener(listener);
    } catch (err) {
      console.warn('[Toca Ficha Dr.] Falha ao ler testMode do storage.', err);
    }
    return listener;
  }

  function setupPageObserver() {
    let lastUrl = window.location.href;
    let debounceTimer = null;

    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          window.TOCAFICHADR_hud.refreshPatient();
          autoSetupPatientPage();
        }, 800);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('beforeunload', () => {
      observer.disconnect();
    }, { once: true });
  }

  async function autoSetupPatientPage() {
    const url = window.location.href;
    const isPatientPage = url.includes('intern_id=') || /\/interns\/\d+/.test(url);

    if (isPatientPage) {
      // Mirror bridge.js _autoSetupPatientPage: read from chrome.storage.local
      // ['userConfig'] first (written by user-config-client.js after sign-in;
      // hydrate() removes the legacy autoClearSoap key from sync). Fall back to
      // sync only for unauthenticated users who have no local cache yet.
      let autoClearSoap = true;
      try {
        const local = await chrome.storage.local.get(['userConfig']);
        const cfg = local && local.userConfig;
        if (cfg && typeof cfg.auto_clear_soap !== 'undefined') {
          autoClearSoap = cfg.auto_clear_soap !== false;
        } else {
          const sync = await chrome.storage.sync.get(['autoClearSoap']);
          autoClearSoap = sync.autoClearSoap !== false;
        }
      } catch (_) {}
      if (autoClearSoap) {
        setTimeout(() => {
          try {
            const cleared = window.TOCAFICHADR_dom.clearSoapFields();
            if (cleared > 0) {
              console.log(`[Toca Ficha Dr.] ${cleared} campos SOAP limpos automaticamente`);
            }
          } catch (err) {
            console.warn('[Toca Ficha Dr.] Falha ao limpar campos SOAP:', err);
          }
        }, 1200);
      }
    }
  }
})();
