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
  const LOG_KEY     = 'orion_intercept_logs';
  const MAX_LOGS    = 200;
  const BLOCK_OPENS = true; // set false to allow window.open but still log it
  // ──────────────────────────────────────────────────────────────────────────


  // ─── STORAGE (GM_ gives cross-origin persistence) ─────────────────────────
  async function getLogs() {
    try {
      const raw = await GM_getValue(LOG_KEY, '[]');
      return JSON.parse(raw);
    } catch { return []; }
  }

  async function saveLog(type, detail) {
    const logs = await getLogs();
    logs.push({
      type,
      detail: String(detail),
      url:  location.href,
      time: new Date().toLocaleTimeString()
    });
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await GM_setValue(LOG_KEY, JSON.stringify(logs));
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── INTERCEPT HOOKS (run-at document-start, before page JS) ──────────────

  // 1. window.open
  const _open = window.open.bind(window);
  window.open = function (url, ...args) {
    saveLog('window.open', url || '(no url)');
    return BLOCK_OPENS ? null : _open(url, ...args);
  };

  // 2. location.href setter
  try {
    const origDesc = Object.getOwnPropertyDescriptor(window.location, 'href')
      || Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (origDesc && origDesc.set) {
      Object.defineProperty(window.location, 'href', {
        set(val) {
          saveLog('location.href', val);
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
      saveLog(`location.${method}`, url);
      return orig(url);
    };
  });

  // 4. history.pushState / replaceState (SPA navigation)
  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method].bind(history);
    history[method] = function (state, title, url) {
      saveLog(`history.${method}`, url || '(no url)');
      return orig(state, title, url);
    };
  });

  // 6. Global document click/touch listeners (hijack detection)
  const _addEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (['click', 'mousedown', 'touchend'].includes(type) && this === document) {
      saveLog('doc-listener', `type="${type}" fn=${fn?.name || 'anonymous'}`);
    }
    return _addEL.call(this, type, fn, opts);
  };

  // 7. Meta-refresh detection & removal
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.tagName === 'META' && node.httpEquiv?.toLowerCase() === 'refresh') {
          saveLog('meta-refresh', node.content);
          node.remove();
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 8. Embed mousedown redirect blocker (capture phase, fires before their handler)
  const EMBED_HOSTS = ['pooembed.eu', 'embedsports.top'];
  if (EMBED_HOSTS.some(h => location.hostname.includes(h))) {
    document.addEventListener('mousedown', e => {
      saveLog('embed-mousedown-blocked', `target: ${e.target.tagName} class="${e.target.className}"`);
      e.stopImmediatePropagation();
    }, true);
  }

  // ──────────────────────────────────────────────────────────────────────────


  // ─── WINDOW HELPERS (accessible from Eruda console) ──────────────────────
  window.__getLogs   = getLogs;
  window.__clearLogs = () => GM_setValue(LOG_KEY, '[]').then(() => console.log('Logs cleared'));
  window.__copyLogs  = async () => {
    const logs = await getLogs();
    const text = logs.map(({ time, url, type, detail }) =>
      `[${time}] [${type}]\nPage:   ${url}\nDetail: ${detail}`
    ).join('\n\n────────────────────\n\n');
    await navigator.clipboard.writeText(text);
    console.log(`Copied ${logs.length} log(s) to clipboard`);
  };
  window.__printLogs = async () => {
    const logs = await getLogs();
    logs.forEach(l => console.warn(`[${l.time}] [${l.type}]\n  ${l.url}\n  -> ${l.detail}`));
  };
  // ──────────────────────────────────────────────────────────────────────────

  // ─── ERUDA + UI (after page load so body exists) ──────────────────────────
  window.addEventListener('load', () => {

    // Only init Eruda on top-level frame, not inside iframes/embeds
    if (window.self !== window.top) return;

    // Load Eruda
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/eruda@3.0.1/eruda.min.js';
    s.onload = async () => {
      eruda.init();
      eruda.show();
      const ec = eruda.get('console');

      // Replay persisted logs
      const logs = await getLogs();
      if (logs.length) {
        ec.log(`%c── Restored ${logs.length} log(s) from previous pages ──`, 'color:#888');
        logs.forEach(({ time, url, type, detail }) => {
          ec.warn(`[${time}] [${type}]\n  page: ${url}\n  detail: ${detail}`);
        });
        ec.log('%c── Current page ──', 'color:#888');
      }

      // Pipe future saveLog calls into Eruda live
      const _origSave = saveLog;
      window.__interceptLog = async (type, detail) => {
        await saveLog(type, detail);
        ec.warn(`[LIVE][${type}] ${detail}`);
      };
    };
    document.body.appendChild(s);


    // ── Floating button bar ────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.style.cssText = `
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 6px;
    `;

    function makeBtn(emoji, label, onClick) {
      const b = document.createElement('button');
      b.innerHTML = `${emoji} ${label}`;
      b.style.cssText = `
        background: #1a1a1a;
        color: #00ff88;
        border: 1px solid #00ff88;
        padding: 8px 12px;
        font: 12px monospace;
        border-radius: 6px;
        cursor: pointer;
        white-space: nowrap;
        -webkit-tap-highlight-color: transparent;
      `;
      b.addEventListener('click', async () => {
        await onClick(b);
      });
      return b;
    }

    // Copy button
    const copyBtn = makeBtn('📋', 'Copy Logs', async (b) => {
      const logs = await getLogs();
      if (!logs.length) { b.innerHTML = '⚠️ No logs'; setTimeout(() => b.innerHTML = '📋 Copy Logs', 2000); return; }

      const text = logs.map(({ time, url, type, detail }) =>
        `[${time}] [${type}]\nPage:   ${url}\nDetail: ${detail}`
      ).join('\n\n────────────────────\n\n');

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        b.innerHTML = '✅ Copied!';
      } else {
        // Fallback: open in new tab as selectable plain text
        const w = _open();
        w.document.write(`<pre style="font:13px monospace;padding:16px">${text}</pre>`);
      }
      setTimeout(() => b.innerHTML = '📋 Copy Logs', 2000);
    });

    // Export as JSON button
    const jsonBtn = makeBtn('📤', 'Export JSON', async (b) => {
      const logs = await getLogs();
      const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `orion-logs-${Date.now()}.json`;
      a.click();
      b.innerHTML = '✅ Exported!';
      setTimeout(() => b.innerHTML = '📤 Export JSON', 2000);
    });

    // Clear button
    const clearBtn = makeBtn('🗑', 'Clear Logs', async (b) => {
      await GM_setValue(LOG_KEY, '[]');
      b.innerHTML = '✅ Cleared';
      setTimeout(() => b.innerHTML = '🗑 Clear Logs', 2000);
    });

    bar.appendChild(copyBtn);
    bar.appendChild(jsonBtn);
    bar.appendChild(clearBtn);
    document.body.appendChild(bar);
    // ──────────────────────────────────────────────────────────────────────
  });
  // ──────────────────────────────────────────────────────────────────────────

})();
