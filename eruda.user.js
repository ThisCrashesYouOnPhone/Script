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
    'nectsideaments.com',
  ];

  // These are actual video player iframes — do NOT sandbox them
  // (sandboxing breaks the player and causes blank video)
  const PLAYER_IFRAME_PATTERNS = [
    'pooembed.eu/embed-noads',
    'pooembed.eu/embed',
  ];

  // Known ad-only iframes — sandbox or block these specifically
  const AD_IFRAME_PATTERNS = [
    '/ad.html',
    'adcash.com',
    'top-toones.com',
    'onandasmilee.com',
    'bonusandspins.com',
  ];

  const REDIRECT_FN_NAMES = ['s', 'io'];
  const onEmbedHost       = EMBED_HOST_PATTERNS.some(h => location.hostname.includes(h));
  const isObfuscatedFn    = name => /^_0x[0-9a-f]+$/i.test(name);
  // ──────────────────────────────────────────────────────────────────────────


  // ─── STORAGE ──────────────────────────────────────────────────────────────
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
    if (evt?.isTrusted) lastTrustedEventTime = Date.now();
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
    const d = Object.getOwnPropertyDescriptor(window.location, 'href')
      || Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (d?.set) {
      Object.defineProperty(window.location, 'href', {
        set(val) {
          if (!isWithinTrustedWindow()) { saveLog('location.href-blocked', String(val)); return; }
          saveLog('location.href-allowed', val);
          d.set.call(window.location, val);
        },
        get: d.get, configurable: true
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

  // 4. window.location setter (top.location = url from iframes)
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

  // 5. history.replaceState — block cross-origin
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

  // 6. addEventListener — pattern-match ALL _0x handlers on embed hosts
  const _addEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const name = fn?.name || 'anonymous';
    const isRedirectType = ['click', 'mousedown', 'touchend'].includes(type);

    if (onEmbedHost && isRedirectType) {
      if (isObfuscatedFn(name)) {
        saveLog('embed-obfuscated-neutralized', 'type="' + type + '" fn=' + name);
        return;
      }
      if (REDIRECT_FN_NAMES.includes(name)) {
        saveLog('embed-handler-neutralized', 'type="' + type + '" fn=' + name);
        return;
      }
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

  // 7. Meta-refresh removal
  new MutationObserver(muts => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.tagName === 'META' && node.httpEquiv?.toLowerCase() === 'refresh') {
        saveLog('meta-refresh-blocked', node.content);
        node.remove();
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 8. Anchor click interception
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

  // 9. HTMLElement.click() hook
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

  // 10. Form submit hook
  const _origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    if (['_blank','_top'].includes(this.target) && !isWithinTrustedWindow()) {
      saveLog('form.submit-blocked', this.action || location.href);
      return;
    }
    return _origSubmit.call(this);
  };

  // 11. IFRAME SANDBOX — surgical, not blanket
  // Only sandbox known ad iframes. Never touch player iframes.
  // Remove allow-popups entirely — this is how new-tab ad redirects happen.
  const SAFE_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation';
  // No allow-popups — prevents window.open() from iframes opening ad tabs

  function isPlayerIframe(src) {
    return src && PLAYER_IFRAME_PATTERNS.some(p => src.includes(p));
  }

  function isAdIframe(src) {
    return src && AD_IFRAME_PATTERNS.some(p => src.includes(p));
  }

  function handleIframe(iframe) {
    const src = iframe.getAttribute('src') || iframe.src || '';

    // Never touch player iframes
    if (isPlayerIframe(src)) return;

    if (isAdIframe(src)) {
      // Known ad iframe — block it entirely
      iframe.setAttribute('sandbox', ''); // Empty sandbox = no permissions at all
      iframe.removeAttribute('src');
      iframe.src = 'about:blank';
      saveLog('iframe-ad-blocked', src);
      return;
    }

    // All other cross-origin iframes: sandbox without allow-popups and allow-top-navigation
    // This prevents them from opening new tabs or navigating the parent
    try {
      // Check if same-origin (trusted, leave alone)
      if (iframe.contentWindow?.location?.origin === location.origin) return;
    } catch(e) {
      // Cross-origin — apply safe sandbox
      const existing = iframe.getAttribute('sandbox');
      if (existing === null) {
        // No sandbox yet — add one
        iframe.setAttribute('sandbox', SAFE_SANDBOX);
        saveLog('iframe-sandboxed', src || '(no src)');
      } else if (existing.includes('allow-top-navigation') || existing.includes('allow-popups')) {
        // Has dangerous permissions — strip them
        const cleaned = existing
          .replace(/allow-top-navigation(-by-user-activation)?/gi, '')
          .replace(/allow-popups(-to-escape-sandbox)?/gi, '')
          .trim();
        iframe.setAttribute('sandbox', cleaned);
        saveLog('iframe-sandbox-stripped-dangerous', src);
      }
    }
  }

  new MutationObserver(muts => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.tagName === 'IFRAME') handleIframe(node);
      else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(handleIframe);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.querySelectorAll?.('iframe').forEach(handleIframe);

  // 12. Embed-domain anchor mousedown block
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


  // ─── STREAM SNIPER BRIDGE (top frame only) ────────────────────────────────
  // Listens for m3u8 URLs reported by the sniper script running in embed iframes.
  // When a stream URL is found, AUTO-LAUNCHES the clean player immediately.
  // No button to tap — it just happens.
  if (window.self === window.top) {
    let lastSniperUrl = null;
    let cleanPlayerOpen = false;

    window.addEventListener('message', e => {
      if (e.data?.type === 'sniper:url' && e.data?.url && !cleanPlayerOpen) {
        lastSniperUrl = e.data.url;
        autoLaunchCleanPlayer(lastSniperUrl);
      }
    });

    // Poll iframes every second in case postMessage missed
    setInterval(() => {
      if (cleanPlayerOpen) return;
      document.querySelectorAll('iframe').forEach(iframe => {
        try { iframe.contentWindow?.postMessage('sniper:request_url', '*'); } catch(e) {}
      });
    }, 1000);

    function autoLaunchCleanPlayer(m3u8url) {
      if (cleanPlayerOpen) return;
      cleanPlayerOpen = true;

      // Build a fullscreen clean player overlay on the streamed.pk page itself
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483646',
        'background:#000', 'display:flex', 'flex-direction:column'
      ].join(';');

      const topBar = document.createElement('div');
      topBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#111;flex-shrink:0;';

      const statusLabel = document.createElement('span');
      statusLabel.textContent = '▶ Clean stream — no ads';
      statusLabel.style.cssText = 'color:#00ff88;font:12px monospace;';

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;';

      function makeBtn(label, onClick) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'background:#222;color:#ccc;border:1px solid #444;padding:5px 12px;font:12px monospace;border-radius:4px;cursor:pointer;';
        b.addEventListener('click', onClick);
        return b;
      }

      const copyBtn = makeBtn('📋 Copy URL', () => {
        navigator.clipboard.writeText(m3u8url).then(() => {
          copyBtn.textContent = '✅ Copied';
          setTimeout(() => copyBtn.textContent = '📋 Copy URL', 2000);
        });
      });

      const closeBtn = makeBtn('✕ Close', () => {
        video.pause();
        overlay.remove();
        cleanPlayerOpen = false;
      });

      btnRow.append(copyBtn, closeBtn);
      topBar.append(statusLabel, btnRow);

      // The clean video element — iOS WebKit natively supports HLS
      const video = document.createElement('video');
      video.src         = m3u8url;
      video.controls    = true;
      video.autoplay    = true;
      video.playsInline = true;
      video.setAttribute('webkit-playsinline', '');
      video.style.cssText = 'flex:1;width:100%;background:#000;object-fit:contain;min-height:0;';

      video.addEventListener('error', () => {
        statusLabel.textContent = '⚠ Stream needs auth — copied URL to try in another player';
        statusLabel.style.color = '#ff6666';
        navigator.clipboard.writeText(m3u8url).catch(() => {});
      });

      overlay.append(topBar, video);
      document.body.appendChild(overlay);

      // iOS fullscreen
      if (video.webkitEnterFullscreen) {
        setTimeout(() => {
          try { video.webkitEnterFullscreen(); } catch(e) {}
        }, 800);
      }

      saveLog('clean-player-launched', m3u8url);
    }
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
    console.log('Copied ' + logs.length + ' log(s)');
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

    // ── Sniper bridge — listens for m3u8 URLs from embed iframes ──────────────
    let sniperUrl = null;

    window.addEventListener('message', e => {
      if (e.data?.type === 'sniper:url' && e.data?.url) {
        sniperUrl = e.data.url;
        showSniperButton(sniperUrl, e.data.host || '');
      }
    });

    // Poll embed iframes every second asking for their captured stream URL
    setInterval(() => {
      document.querySelectorAll('iframe').forEach(iframe => {
        try { iframe.contentWindow?.postMessage('sniper:request_url', '*'); } catch(e) {}
      });
    }, 1000);

    function showSniperButton(url, host) {
      let btn = document.getElementById('orion-sniper-btn');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'orion-sniper-btn';
        btn.style.cssText = [
          'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
          'z-index:2147483647', 'background:#0a2a0a', 'color:#00ff88',
          'border:1px solid #00ff88', 'padding:12px 24px', 'font:15px monospace',
          'border-radius:8px', 'cursor:pointer', 'white-space:nowrap',
          'box-shadow:0 0 20px rgba(0,255,136,0.25)'
        ].join(';');
        document.body.appendChild(btn);
      }
      const label = host || url.split('/').slice(-2).join('/');
      btn.textContent = '▶ Play Clean — ' + label;
      btn.onclick = () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646;display:flex;flex-direction:column';

        const video = document.createElement('video');
        video.src        = url;
        video.controls   = true;
        video.autoplay   = true;
        video.playsInline = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:contain';

        video.addEventListener('error', () => {
          video.insertAdjacentHTML('afterend', '<p style="color:#ff6666;font:13px monospace;text-align:center;padding:20px">Stream requires auth headers — copy URL and use VLC/Infuse</p>');
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕ Close';
        closeBtn.style.cssText = 'position:absolute;top:12px;left:12px;background:rgba(255,255,255,0.15);color:#fff;border:none;padding:8px 16px;font:14px monospace;border-radius:6px;cursor:pointer;z-index:1';
        closeBtn.onclick = () => overlay.remove();

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 Copy URL';
        copyBtn.style.cssText = 'position:absolute;top:12px;right:12px;background:rgba(255,255,255,0.15);color:#fff;border:none;padding:8px 16px;font:14px monospace;border-radius:6px;cursor:pointer;z-index:1';
        copyBtn.onclick = () => navigator.clipboard.writeText(url).then(() => { copyBtn.textContent = '✅ Copied!'; setTimeout(() => copyBtn.textContent = '📋 Copy URL', 2000); });

        overlay.append(closeBtn, copyBtn, video);
        document.body.appendChild(overlay);

        if (video.webkitEnterFullscreen) setTimeout(() => video.webkitEnterFullscreen(), 400);
      };
    }
    // ──────────────────────────────────────────────────────────────────────────
  });

})();
