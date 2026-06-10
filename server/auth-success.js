// v3.1: broadcast that auth completed so any open side panel / popup
// re-renders the logged-in view immediately (Clerk's SDK listener can be slow).
try {
  chrome.runtime.sendMessage({ type: "TOCAFICHADR_AUTH_COMPLETED" }).catch(() => {});
} catch (_) {}

document.getElementById("closeBtn").addEventListener("click", () => {
  window.close();
});
// Auto-close after 1.5s — the side panel/popup will pick up the new session
// from chrome.storage. If close fails (some Chromium variants), show the hint.
setTimeout(() => {
  try { window.close(); } catch (_) {}
}, 1500);
setTimeout(() => {
  const hint = document.getElementById("hint");
  if (hint) hint.textContent = "Se a aba não fechar, feche-a manualmente.";
}, 2500);
