// The editors' release renderers hard-code the "Genspark" panel title. When the
// AI provider is UAO's local gateway, show the real backend instead. Injected
// into Office editor pages only; it reads the same settings API the editors use.
export const GATEWAY_MARKER_VALUE = 'uao-local-gateway';

export const brandingScript = `(() => {
  if (window.__uaoAiBranding) return;
  window.__uaoAiBranding = true;
  let label = null, fetchedAt = 0, pending = false;
  const read = () => {
    const now = Date.now();
    // Each editor's preload exposes the same settings call under its own name.
    const api = [window.desktop, window.desktopApi, window.slidesApi, window.htmlApi, window.markdownApi, window.pdfApi]
      .find(candidate => candidate && typeof candidate.getAiSettings === 'function');
    if (pending || now - fetchedAt < 2000 || !api) return;
    pending = true;
    api.getAiSettings().then(settings => {
      const custom = settings && settings.providers && settings.providers.custom;
      const next = settings && settings.provider === 'custom' && custom && custom.apiKey === '${GATEWAY_MARKER_VALUE}'
        ? 'Local AI \\u00b7 ' + (custom.model || 'gateway') : null;
      fetchedAt = Date.now(); pending = false;
      if (next !== label) { label = next; apply(); }
    }).catch(() => { fetchedAt = Date.now(); pending = false; });
  };
  const apply = () => {
    if (!label) return;
    const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (text === 'Genspark') node.nodeValue = label;
      else if (text === 'Genspark AI') node.nodeValue = node.nodeValue.replace('Genspark AI', 'Local AI');
    }
    for (const el of document.querySelectorAll('[aria-label^="Genspark"],[data-tip^="Genspark"],[title^="Genspark"]')) {
      for (const name of ['aria-label', 'data-tip', 'title']) if (/^Genspark( account)?$/.test(el.getAttribute(name) || '')) el.setAttribute(name, label);
    }
  };
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; read(); apply(); });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => { fetchedAt = 0; read(); });
  read();
})()`;
