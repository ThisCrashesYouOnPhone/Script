// ==UserScript==
// @name         Orion Intercept & Persistent Console
// @namespace    orion-stack
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  const LOG_KEY           = 'orion_intercept_logs';
  const MAX_LOGS          = 300;
  const BLOCK_OPENS       = true;
  const TRUSTED_EVENT_TTL = 600;

  // Known embed/ad host patterns — anything matching these gets full neutralization
  const EMBED_HOST_PATTERNS = [
    'pooembed.eu',
    'embedsports.top',
    'embedhd.org',
    'exposestrat.com',
    'onandasmilee.com',
    'top-toones.com',
    'boomerang-bet.com',
    'bonusandspins.com',
    'togglevpn.app',
    'adcash.com',
    'appsflyer.com',
  ];

  // Specific known redirect handler names (fallback for non-_0x patterns)
  const REDIRECT_FN_NAMES = ['s', 'io'];

  const onEmbedHost = EMBED_HOST_PATTERNS.some(h => location.hostname.includes(h));

  // Pattern test — the real weapon: catches ALL obfuscated handlers regardless of rotation
  const isObfuscatedFn = name => /^_0x[0-9a-f]+$/i.test(name);
  // ──────────────────────────────────────────────────────────────────────────


  // ─── STORAGE (queued writes — prevents async race on rapid blocks) ─────────
  let _logQueue = Promise.resolve();
  async function getLogs() {
    try { return JSON.parse(await GM_getValue(LOG_KEY, '[]')); } catch { return []; }
  }
  function saveLog(type, detail) {
    _logQueue = _logQueue.then(async () => {
      try {
        const logs = await getLogs();
        logs.push({ type, detail: String(detail), url: location.href, time: new Date().toLocaleTimeString() });
        if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
        await GM_setValue(LOG_KEY, JSON.stringify(logs));
      } catch(e) {}
    });
    return _logQueue;
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── TRUSTED INTERACTION TRACKER ──────────────────────────────────────────
  let lastTrustedEventTime = 0;
  function recordTrustedEvent(evt) {
    if (evt && evt.isTrusted) lastTrustedEventTime = Date.now();
  }
  function isWithinTrustedWindow() {
    return (Date.now() - lastTrustedEventTime) < TRUSTED_EVENT_TTL;
  }
  ['click', 'mousedown', 'touchstart', 'touchend'].forEach(type => {
    document.addEventListener(type, recordTrustedEvent, { capture: true, passive: true });
  });
  // ──────────────────────────────────────────────────────────────────────────


  // ─── INTERCEPT HOOKS ──────────────────────────────────────────────────────

  // 1. window.open
  const _open = window.open.bind(window);
  window.open = function (url, ...args) {
    if (!isWithinTrustedWindow()) {
      saveLog('window.open-blocked', (url || '(no url)') + ' | ms: ' + (Date.now() - lastTrustedEventTime));
      return null;
    }
    saveLog('window.open-allowed', url || '(no url)');
    return BLOCK_OPENS ? null : _open(url, ...args);
  };

  // 2. location.href setter
  try {
    const origDesc = Object.getOwnPropertyDescriptor(window.location, 'href')
      || Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (origDesc?.set) {
      Object.defineProperty(window.location, 'href', {
        set(val) {
          if (!isWithinTrustedWindow()) { saveLog('location.href-blocked', String(val)); return; }
          saveLog('location.href-allowed', val);
          origDesc.set.call(window.location, val);
        },
        get: origDesc.get, configurable: true
      });
    }
  } catch(e) {}

  // 3. location.replace / assign
  ['replace', 'assign'].forEach(method => {
    const orig = location[method].bind(location);
    location[method] = function (url) {
      if (!isWithinTrustedWindow()) { saveLog('location.' + method + '-blocked', String(url)); return; }
      saveLog('location.' + method + '-allowed', url);
      return orig(url);
    };
  });

  // 4. window.location setter — catches top.location = url from child iframes
  try {
    const d = Object.getOwnPropertyDescriptor(Window.prototype, 'location')
      || Object.getOwnPropertyDescriptor(window, 'location');
    if (d?.set) {
      Object.defineProperty(window, 'location', {
        set(val) {
          if (!isWithinTrustedWindow()) { saveLog('window.location-blocked', String(val)); return; }
          d.set.call(this, val);
        },
        get: d.get, configurable: true
      });
    }
  } catch(e) {}

  // 5. history.pushState / replaceState
  const _origPush    = history.pushState.bind(history);
  const _origReplace = history.replaceState.bind(history);
  history.pushState = function(s, t, url) {
    saveLog('history.pushState', url || '(no url)');
    return _origPush(s, t, url);
  };
  history.replaceState = function(s, t, url) {
    if (url) {
      try {
        if (new URL(String(url), location.href).origin !== location.origin && !isWithinTrustedWindow()) {
          saveLog('history.replaceState-cross-origin-blocked', String(url));
          return;
        }
      } catch(e) {}
    }
    saveLog('history.replaceState', url || '(no url)');
    return _origReplace(s, t, url);
  };

  // 6. addEventListener — THE KEY WEAPON: pattern-match ALL _0x handlers on embed hosts
  const _addEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const name = fn?.name || 'anonymous';
    const isRedirectType = ['click', 'mousedown', 'touchend'].includes(type);

    if (onEmbedHost && isRedirectType) {
      // Block ALL obfuscated _0x handlers — catches new ones automatically
      if (isObfuscatedFn(name)) {
        saveLog('embed-obfuscated-neutralized', 'type="' + type + '" fn=' + name);
        return;
      }
      // Block specific known redirect names
      if (REDIRECT_FN_NAMES.includes(name)) {
        saveLog('embed-handler-neutralized', 'type="' + type + '" fn=' + name);
        return;
      }
      // Block anonymous mousedown on document
      if (type === 'mousedown' && name === 'anonymous' && this === document) {
        saveLog('embed-anon-mousedown-dropped', 'target: document');
        return;
      }
    }

    if (isRedirectType && this === document) {
      saveLog('doc-listener', 'type="' + type + '" fn=' + name);
    }

    return _addEL.call(this, type, fn, opts);
  };

  // 7. Anchor click interception — catches programmatic .click() on hidden ad anchors
  document.addEventListener('click', e => {
    const anchor = e.target.closest('a');
    if (!anchor) return;
    const href = anchor.href || '';
    const isExternal = href && !href.startsWith(location.origin) && !/^(javascript|#|data):/.test(href);
    const isBlankOrTop = ['_blank','_top','_parent'].includes(anchor.target);
    if (!e.isTrusted && (isExternal || isBlankOrTop)) {
      saveLog('anchor-click-blocked-untrusted', href);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // 8. HTMLElement.click() hook — catches el.click() calls that bypass event listeners
  const _origClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function() {
    const anchor = this.closest?.('a');
    if (anchor) {
      const href = anchor.href || '';
      const isExternal = href && !href.startsWith(location.origin) && !/^(javascript|#|data):/.test(href);
      if (isExternal && !isWithinTrustedWindow()) {
        saveLog('el.click-blocked', href);
        return;
      }
    }
    return _origClick.call(this);
  };

  // 9. Form submit hook
  const _origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    if (['_blank','_top'].includes(this.target) && !isWithinTrustedWindow()) {
      saveLog('form.submit-blocked', this.action || location.href);
      return;
    }
    return _origSubmit.call(this);
  };

  // 10. Meta-refresh removal
  new MutationObserver(muts => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.tagName === 'META' && node.httpEquiv?.toLowerCase() === 'refresh') {
        saveLog('meta-refresh-blocked', node.content);
        node.remove();
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 11. IFRAME SANDBOX INJECTION — the nuclear option
  // Strips allow-top-navigation from all iframes, preventing ANY iframe from
  // navigating the parent page at the browser level — no JS hook can bypass this.
  // We preserve allow-scripts, allow-same-origin, allow-forms, allow-presentation
  // so video players continue working.
  const SAFE_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation allow-popups';

  function sandboxIframe(iframe) {
    // Don't re-sandbox or touch same-origin iframes (they're trusted)
    try {
      if (iframe.contentWindow?.location?.origin === location.origin) return;
    } catch(e) {} // cross-origin throws — that's fine, we want to sandbox those

    const existing = iframe.getAttribute('sandbox');
    if (existing !== null) {
      // Already sandboxed — just strip top-navigation if present
      const cleaned = existing
        .replace(/allow-top-navigation(-by-user-activation)?/gi, '')
        .trim();
      if (cleaned !== existing) {
        iframe.setAttribute('sandbox', cleaned);
        saveLog('iframe-sandbox-stripped-top-nav', iframe.src || '(no src)');
      }
    } else {
      // No sandbox — add one that blocks top navigation
      iframe.setAttribute('sandbox', SAFE_SANDBOX);
      saveLog('iframe-sandboxed', iframe.src || '(no src)');
    }
  }

  // Apply to iframes as they're added
  new MutationObserver(muts => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.tagName === 'IFRAME') sandboxIframe(node);
      else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(sandboxIframe);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Apply to any iframes already in the page
  document.querySelectorAll?.('iframe').forEach(sandboxIframe);

  // 12. Embed-domain anchor mousedown block (refined)
  if (onEmbedHost) {
    document.addEventListener('mousedown', e => {
      const anchor = e.target.closest('a');
      if (anchor) {
        saveLog('embed-anchor-mousedown-blocked', 'href=' + anchor.href);
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  }

  // ──────────────────────────────────────────────────────────────────────────


  // ─── WINDOW HELPERS ───────────────────────────────────────────────────────
  window.__getLogs   = getLogs;
  window.__clearLogs = () => GM_setValue(LOG_KEY, '[]').then(() => console.log('Logs cleared'));
  window.__copyLogs  = async () => {
    const logs = await getLogs();
    const text = logs.map(({ time, url, type, detail }) =>
      '[' + time + '] [' + type + ']\nPage:   ' + url + '\nDetail: ' + detail
    ).join('\n\n--------------------\n\n');
    await navigator.clipboard.writeText(text);
    console.log('Copied ' + logs.length + ' log(s) to clipboard');
  };
  window.__printLogs = async () => {
    const logs = await getLogs();
    logs.forEach(l => console.warn('[' + l.time + '] [' + l.type + ']\n  ' + l.url + '\n  -> ' + l.detail));
  };
  window.__stats = async () => {
    const logs = await getLogs();
    const counts = {};
    logs.forEach(l => { counts[l.type] = (counts[l.type] || 0) + 1; });
    console.table(counts);
  };
  // ──────────────────────────────────────────────────────────────────────────


  // ─── ERUDA (top frame only) ───────────────────────────────────────────────
  window.addEventListener('load', () => {
    if (window.self !== window.top) return;

    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/eruda@3.0.1/eruda.min.js';
    s.onload = async () => {
      eruda.init();
      eruda.show();
      const ec = eruda.get('console');
      const logs = await getLogs();
      if (logs.length) {
        ec.log('%c-- Restored ' + logs.length + ' log(s) --', 'color:#888');
        logs.forEach(({ time, url, type, detail }) => {
          ec.warn('[' + time + '] [' + type + ']\n  page: ' + url + '\n  detail: ' + detail);
        });
        ec.log('%c-- Current page --', 'color:#888');
      }
    };
    document.body.appendChild(s);

    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px';
    function makeBtn(emoji, label, fn) {
      const b = document.createElement('button');
      b.innerHTML = emoji + ' ' + label;
      b.style.cssText = 'background:#1a1a1a;color:#00ff88;border:1px solid #00ff88;padding:8px 12px;font:12px monospace;border-radius:6px;cursor:pointer;white-space:nowrap';
      b.addEventListener('click', async () => fn(b));
      return b;
    }
    bar.appendChild(makeBtn('📋', 'Copy', async b => {
      const logs = await getLogs();
      const text = logs.map(({ time, url, type, detail }) => '[' + time + '] [' + type + ']\nPage:   ' + url + '\nDetail: ' + detail).join('\n\n--------------------\n\n');
      await navigator.clipboard.writeText(text).catch(() => {});
      b.innerHTML = '✅'; setTimeout(() => b.innerHTML = '📋 Copy', 2000);
    }));
    bar.appendChild(makeBtn('📤', 'JSON', async b => {
      const logs = await getLogs();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }));
      a.download = 'orion-logs-' + Date.now() + '.json';
      a.click();
      b.innerHTML = '✅'; setTimeout(() => b.innerHTML = '📤 JSON', 2000);
    }));
    bar.appendChild(makeBtn('🗑', 'Clear', async b => {
      await GM_setValue(LOG_KEY, '[]');
      b.innerHTML = '✅'; setTimeout(() => b.innerHTML = '🗑 Clear', 2000);
    }));
    document.body.appendChild(bar);
  });

})();
