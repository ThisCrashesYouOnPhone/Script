// ==UserScript==
// @name         Navigation & Event Interceptor
// @namespace    your-stack
// @match        *://*/*
// @grant        none
// @run-at       document-start   // Critical — must run before page JS
// ==/UserScript==

(function() {
  const log = (type, detail) => console.warn(`[INTERCEPT:${type}]`, detail);

  // Patch window.open
  const _open = window.open.bind(window);
  window.open = function(url, ...args) {
    log('window.open', url);
    // Return null to block, or _open(url, ...args) to allow
    return null;
  };

  // Patch location assignments
  const locationProps = ['href', 'assign', 'replace'];
  // Watch location.href setter
  let _href = window.location.href;
  try {
    Object.defineProperty(window.location, 'href', {
      set(val) { log('location.href', val); _href = val; },
      get() { return _href; }
    });
  } catch(e) {} // location is guarded in some contexts

  // Patch addEventListener to log suspicious listeners
  const _addEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (['click','mousedown','touchend'].includes(type) && this === document) {
      log('doc-listener', type);
    }
    return _addEL.call(this, type, fn, opts);
  };

  // Detect meta-refresh
  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.tagName === 'META' && node.httpEquiv?.toLowerCase() === 'refresh') {
          log('meta-refresh', node.content);
          node.remove(); // block it
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

})();
