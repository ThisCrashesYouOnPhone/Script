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
  const MAX_LOGS          = 200;
  const BLOCK_OPENS       = true;
  const TRUSTED_EVENT_TTL = 600;   // ms — window after a real tap where navigation is allowed
  const SHIELD_DURATION   = 2500;  // ms — how long to hold beforeunload after blocking anything
  const EMBED_HOSTS       = ['pooembed.eu', 'embedsports.top', 'boomerang-bet.com', 'bonusandspins.com'];
  const REDIRECT_FN_NAMES = ['_0x22571e', '_0x291a5d', 's'];
  const onEmbedHost       = EMBED_HOSTS.some(h => location.hostname.includes(h));
  // ──────────────────────────────────────────────────────────────────────────


  // ─── STORAGE (sync-safe via queue) ────────────────────────────────────────
  // GM_setValue is async — queue writes so rapid blocks don't race each other
  let _logQueue = Promise.resolve();

  async function getLogs() {
    try {
      const raw = await GM_getValue(LOG_KEY, '[]');
      return JSON.parse(raw);
    } catch { return []; }
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


  // ─── REDIRECT SHIELD (beforeunload) ───────────────────────────────────────
  // When we block anything, arm this for SHIELD_DURATION ms.
  // It intercepts beforeunload which catches ALL navigation mechanisms —
  // including ones that bypass our location/open hooks entirely.
  const Shield = {
    active: false,
    timer: null,
    handler(e) {
      e.preventDefault();
      e.returnValue = '';
      saveLog('shield-blocked-navigation', location.href);
      return '';
    },
    arm() {
      if (!this.active) {
        this.boundHandler = this.handler.bind(this);
        window.addEventListener('beforeunload', this.boundHandler, true);
        this.active = true;
      }
      // Reset timer each time something new is blocked
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.disarm(), SHIELD_DURATION);
    },
    disarm() {
      if (!this.active) return;
      window.removeEventListener('beforeunload', this.boundHandler, true);
      this.active = false;
      this.timer = null;
    }
  };

  function blockAndShield(logType, detail) {
    saveLog(logType, detail);
    Shield.arm();
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── TRUSTED INTERACTION TRACKER ──────────────────────────────────────────
  let lastTrustedEventTime = 0;

  function recordTrustedEvent(evt) {
    if (evt && evt.isTrusted) {
      lastTrustedEventTime = Date.now();
      // Any real user interaction disarms the shield so navigation works normally
      Shield.disarm();
    }
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
    const trusted = isWithinTrustedWindow();
    const msSince = Date.now() - lastTrustedEventTime;
    if (!trusted) {
      blockAndShield('window.open-blocked', (url || '(no url)') + ' | ms-since-gesture: ' + msSince);
      return null;
    }
    saveLog('window.open-allowed', url || '(no url)');
    return BLOCK_OPENS ? null : _open(url, ...args);
  };

  // 2. location.href setter
  try {
    const origDesc = Object.getOwnPropertyDescriptor(window.location, 'href')
      || Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (origDesc && origDesc.set) {
      Object.defineProperty(window.location, 'href', {
        set(val) {
          const trusted = isWithinTrustedWindow();
          const msSince = Date.now() - lastTrustedEventTime;
          if (!trusted) {
            blockAndShield('location.href-blocked', String(val) + ' | ms-since-gesture: ' + msSince);
            return;
          }
          saveLog('location.href-allowed', val);
          origDesc.set.call(window.location, val);
        },
        get: origDesc.get,
        configurable: true
      });
    }
  } catch (e) {}

  // 3. location.replace / location.assign
  ['replace', 'assign'].forEach(method => {
    const orig = location[method].bind(location);
    location[method] = function (url) {
      const trusted = isWithinTrustedWindow();
      const msSince = Date.now() - lastTrustedEventTime;
      if (!trusted) {
        blockAndShield('location.' + method + '-blocked', String(url) + ' | ms-since-gesture: ' + msSince);
        return;
      }
      saveLog('location.' + method + '-allowed', url);
      return orig(url);
    };
  });

  // 4. window.location property setter (catches top.location = url from child iframes)
  try {
    const winLocDesc = Object.getOwnPropertyDescriptor(Window.prototype, 'location')
      || Object.getOwnPropertyDescriptor(window, 'location');
    if (winLocDesc && winLocDesc.set) {
      Object.defineProperty(window, 'location', {
        set(val) {
          const trusted = isWithinTrustedWindow();
          const msSince = Date.now() - lastTrustedEventTime;
          if (!trusted) {
            blockAndShield('window.location-blocked', String(val) + ' | ms-since-gesture: ' + msSince);
            return;
          }
          saveLog('window.location-allowed', String(val));
          winLocDesc.set.call(this, val);
        },
        get: winLocDesc.get,
        configurable: true
      });
    }
  } catch (e) {}

  // 5. history.pushState / replaceState — block cross-origin replaceState
  const _origPush    = history.pushState.bind(history);
  const _origReplace = history.replaceState.bind(history);

  history.pushState = function(state, title, url) {
    saveLog('history.pushState', url || '(no url)');
    return _origPush(state, title, url);
  };

  history.replaceState = function(state, title, url) {
    if (url) {
      try {
        const target = new URL(String(url), location.href);
        if (target.origin !== location.origin) {
          const trusted = isWithinTrustedWindow();
          const msSince = Date.now() - lastTrustedEventTime;
          if (!trusted) {
            blockAndShield('history.replaceState-blocked-cross-origin', String(url) + ' | ms-since-gesture: ' + msSince);
            return;
          }
        }
      } catch(e) {}
    }
    saveLog('history.replaceState', url || '(no url)');
    return _origReplace(state, title, url);
  };

  // 6. addEventListener — log doc listeners, neutralize redirect handlers on embed domains
  const _addEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const name = fn?.name || 'anonymous';

    if (onEmbedHost && ['click', 'mousedown'].includes(type) && REDIRECT_FN_NAMES.includes(name)) {
      saveLog('embed-handler-neutralized', 'type="' + type + '" fn=' + name);
      return;
    }

    if (onEmbedHost && type === 'mousedown' && name === 'anonymous' && this === document) {
      saveLog('embed-anon-mousedown-dropped', 'target: document');
      return;
    }

    if (['click', 'mousedown', 'touchend'].includes(type) && this === document) {
      saveLog('doc-listener', 'type="' + type + '" fn=' + name);
    }

    return _addEL.call(this, type, fn, opts);
  };

  // 7. Meta-refresh detection & removal
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.tagName === 'META' && node.httpEquiv?.toLowerCase() === 'refresh') {
          blockAndShield('meta-refresh-blocked', node.content);
          node.remove();
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 8. On embed domains: block mousedown on anchors, leave JWPlayer controls untouched
  if (onEmbedHost) {
    document.addEventListener('mousedown', e => {
      const anchor = e.target.closest('a');
      if (anchor) {
        blockAndShield('embed-anchor-mousedown-blocked', 'href=' + anchor.href);
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  }

  // 9. Intercept ALL click events — catches programmatic .click() on hidden anchor elements
  // This is the primary vector for sports-on-couch, shein, etc. style redirects
  document.addEventListener('click', e => {
    const anchor = e.target.closest('a');
    if (!anchor) return;

    const href = anchor.href || '';
    const isBlank = anchor.target === '_blank' || anchor.target === '_top' || anchor.target === '_parent';
    const isExternal = href && !href.startsWith(location.origin) && !href.startsWith('javascript:') && !href.startsWith('#');

    // Block untrusted (programmatic) clicks on external/blank links
    if (!e.isTrusted && (isBlank || isExternal)) {
      blockAndShield('anchor-click-blocked-untrusted', href);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Block ANY click (trusted or not) on anchor during shield period if we just blocked something
    if (Shield.active && isExternal && !isWithinTrustedWindow()) {
      blockAndShield('anchor-click-blocked-shield', href);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // 10. Hook HTMLElement.click() — catches el.click() on anchors which bypasses event listeners
  const _origClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function() {
    const anchor = this.closest ? this.closest('a') : null;
    if (anchor) {
      const href = anchor.href || '';
      const isExternal = href && !href.startsWith(location.origin) && !href.startsWith('javascript:') && !href.startsWith('#');
      if (isExternal && !isWithinTrustedWindow()) {
        blockAndShield('el.click-blocked', href);
        return;
      }
    }
    return _origClick.call(this);
  };

  // 11. Hook HTMLFormElement.submit — catches form-based popup redirects
  const _origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    if (this.target === '_blank' || this.target === '_top') {
      const url = this.action || location.href;
      if (!isWithinTrustedWindow()) {
        blockAndShield('form.submit-blocked', url);
        return;
      }
    }
    return _origSubmit.call(this);
  };

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
  window.__shieldStatus = () => console.log('Shield active:', Shield.active, '| ms since trusted gesture:', Date.now() - lastTrustedEventTime);
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

    // Floating buttons
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;flex-direction:column;gap:6px';

    function makeBtn(emoji, label, onClick) {
      const b = document.createElement('button');
      b.innerHTML = emoji + ' ' + label;
      b.style.cssText = 'background:#1a1a1a;color:#00ff88;border:1px solid #00ff88;padding:8px 12px;font:12px monospace;border-radius:6px;cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent';
      b.addEventListener('click', async () => { await onClick(b); });
      return b;
    }

    const copyBtn = makeBtn('📋', 'Copy Logs', async (b) => {
      const logs = await getLogs();
      if (!logs.length) { b.innerHTML = '⚠️ No logs'; setTimeout(() => b.innerHTML = '📋 Copy Logs', 2000); return; }
      const text = logs.map(({ time, url, type, detail }) =>
        '[' + time + '] [' + type + ']\nPage:   ' + url + '\nDetail: ' + detail
      ).join('\n\n--------------------\n\n');
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        b.innerHTML = '✅ Copied!';
      }
      setTimeout(() => b.innerHTML = '📋 Copy Logs', 2000);
    });

    const jsonBtn = makeBtn('📤', 'Export JSON', async (b) => {
      const logs = await getLogs();
      const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'orion-logs-' + Date.now() + '.json';
      a.click();
      b.innerHTML = '✅ Exported!';
      setTimeout(() => b.innerHTML = '📤 Export JSON', 2000);
    });

    const clearBtn = makeBtn('🗑', 'Clear Logs', async (b) => {
      await GM_setValue(LOG_KEY, '[]');
      b.innerHTML = '✅ Cleared';
      setTimeout(() => b.innerHTML = '🗑 Clear Logs', 2000);
    });

    bar.appendChild(copyBtn);
    bar.appendChild(jsonBtn);
    bar.appendChild(clearBtn);
    document.body.appendChild(bar);
  });
  // ──────────────────────────────────────────────────────────────────────────

})();
