// shared/error-helpers.js — Error normalization utility (CSO-016)
// Used by:
//   • content scripts — injected before api-client.js via manifest content_scripts;
//     defines _normalizeApiError as a script-scope global.
//   • service worker — imported as a side-effect in service-worker.src.js so esbuild
//     inlines the function into the IIFE bundle scope.
function _normalizeApiError(err) {
  const msg = (err && err.message) || String(err || '');
  if (/abort|timeout|timed out/i.test(msg)) return 'Servidor não respondeu. Tente novamente.';
  if (/failed to fetch|network|net::|internet/i.test(msg)) return 'Sem conexão com o servidor. Verifique sua internet.';
  const m = msg.match(/HTTP\s*(\d+)/i);
  if (m) {
    const status = parseInt(m[1], 10);
    if (status === 401) return 'Sessão expirada. Faça login novamente.';
    if (status === 403) return 'Acesso negado.';
    if (status === 429) {
      if (/USAGE_LIMIT/i.test(msg)) return 'Limite diário atingido — assine Pro ou aguarde até amanhã.';
      return 'Muitas requisições. Aguarde um momento.';
    }
    if (status >= 500) return 'Erro no servidor. Tente novamente em instantes.';
  }
  return msg || 'Erro desconhecido.';
}
