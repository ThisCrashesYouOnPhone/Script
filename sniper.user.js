// ==UserScript==
// @name         Orion Stream Sniper
// @namespace    orion-stack
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/sniper.user.js
// @downloadURL  https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/sniper.user.js
// ==/UserScript==

(function() {
  'use strict';

  const SNIPE_HOSTS = [
    'pooembed.eu',
    'embedsports.top',
    'embedhd.org',
    'exposestrat.com',
  ];

  if (!SNIPE_HOSTS.some(h => location.hostname.includes(h))) return;

  // ─── LOCAL STORAGE FALLBACKS FOR GM STORAGE ────────────────────────────────
  // Ensures compatibility in sandboxed extensions (Orion) where GM APIs might fail
  const _getValue = (key, def) => {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(key, def);
        return val instanceof Promise ? val : Promise.resolve(val);
      }
    } catch (e) {}
    try {
      const val = localStorage.getItem(key);
      return Promise.resolve(val !== null ? val : def);
    } catch (e) {
      return Promise.resolve(def);
    }
  };

  const _setValue = (key, val) => {
    try {
      if (typeof GM_setValue === 'function') {
        const res = GM_setValue(key, val);
        return res instanceof Promise ? res : Promise.resolve(res);
      }
    } catch (e) {}
    try {
      localStorage.setItem(key, val);
      return Promise.resolve();
    } catch (e) {
      return Promise.resolve();
    }
  };

  // ─── PHASE 1: IMMEDIATE TIMER BLOCKING & SAFE SWEEPER ──────────────────────
  // Overrides setTimeout/setInterval so future long-delay ad timers are blocked.
  // Long delays (>3s) from page JS are almost always ad/redirect triggers.
  const _realSetTimeout  = window.setTimeout.bind(window);
  const _realSetInterval = window.setInterval.bind(window);
  const _realClear       = window.clearTimeout.bind(window);

  const SAFE_DELAY_MS = 3000; 
  const timerLog = [];
  const safeTimerIds = new Set();

  // Custom setTimeout wrapper that registers safe timer IDs so they escape the sweeper
  function safeSetTimeout(fn, delay, ...args) {
    const id = _realSetTimeout(fn, delay, ...args);
    safeTimerIds.add(id);
    return id;
  }

  window.setTimeout = function(fn, delay, ...args) {
    const numDelay = Number(delay) || 0;
    if (numDelay > SAFE_DELAY_MS) {
      timerLog.push({ type: 'timeout-blocked', delay: numDelay, fn: fn?.name || 'anonymous' });
      return 0; // Return fake ID
    }
    return _realSetTimeout(fn, delay, ...args);
  };

  window.setInterval = function(fn, delay, ...args) {
    const numDelay = Number(delay) || 0;
    if (numDelay > SAFE_DELAY_MS) {
      timerLog.push({ type: 'interval-blocked', delay: numDelay, fn: fn?.name || 'anonymous' });
      return 0;
    }
    return _realSetInterval(fn, delay, ...args);
  };

  // Kill ALL timers set by initial page scripts, except our safe timers
  safeSetTimeout(() => {
    const maxId = _realSetTimeout(() => {}, 0);
    for (let i = 0; i <= maxId; i++) {
      if (!safeTimerIds.has(i)) {
        _realClear(i);
      }
    }
    timerLog.push({ type: 'sweep', killed: maxId });
  }, 600);

  // ─── PHASE 2: POP-UP POPUNDER AND REDIRECT SHIELDS ───────────────────────
  // Blocks attempts by ad platforms to trigger pop-ups on user interactions.
  const _realOpen = window.open;
  window.open = function(url, target, features) {
    console.log('[SNIPER] Blocked window.open attempt to:', url);
    // Return dummy window object to keep scripts from throwing
    return {
      focus: () => {},
      close: () => {},
      closed: true
    };
  };

  // Disable alert/confirm spam which redirects sometimes trigger
  window.alert = function(msg) { console.log('[SNIPER] Blocked alert:', msg); };
  window.confirm = function(msg) { console.log('[SNIPER] Blocked confirm:', msg); return true; };

  // Inject EasyList CSS to instantly hide visual ad banners and cookies overlays
  const AD_BLOCK_CSS = `
    iframe[src*="poop"], iframe[src*="ad"], iframe[src*="doubleclick"], iframe[src*="pop"],
    .ad-box, .banner-ad, #ad-container, .popunder, .pop-under, .cookie-banner,
    [class*="popunder"], [id*="popunder"], [class*="-ad-"], [id*="-ad-"], .adsbox {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      opacity: 0 !important;
      height: 0 !important;
      width: 0 !important;
    }
  `;
  
  const injectCSS = () => {
    const style = document.createElement('style');
    style.textContent = AD_BLOCK_CSS;
    (document.head || document.documentElement).appendChild(style);
  };

  if (document.head) {
    injectCSS();
  } else {
    document.addEventListener('DOMContentLoaded', injectCSS);
  }

  // ─── STATE ────────────────────────────────────────────────────────────────
  let capturedM3u8  = null;
  let takenOver     = false;

  // ─── NETWORK LOGGER ───────────────────────────────────────────────────────
  const NET_KEY = 'orion_net_log';
  const t0      = Date.now();
  const netLog  = [];

  function saveNet(entry) {
    entry.ms = Date.now() - t0;
    entry.page = location.href;
    netLog.push(entry);
    if (entry.flag) {
      _getValue(NET_KEY, '[]').then(raw => {
        try {
          const logs = JSON.parse(raw);
          logs.push(entry);
          if (logs.length > 150) logs.splice(0, logs.length - 150);
          _setValue(NET_KEY, JSON.stringify(logs));
        } catch(e) {}
      }).catch(() => {});
    }
  }

  function interesting(url) {
    return /\.m3u8|\.mpd|stream|token|auth|ad|pop|redirect|track|click|secure/i.test(url);
  }

  window.__netSummary = () => {
    _getValue(NET_KEY, '[]').then(raw => {
      const s = JSON.parse(raw);
      console.table(s.map(e => ({ ms: e.ms, type: e.type, status: e.status, url: (e.url||'').slice(0,80) })));
    });
  };
  
  window.__copyNet = () => {
    _getValue(NET_KEY, '[]').then(raw => {
      const s = JSON.parse(raw);
      navigator.clipboard.writeText(JSON.stringify(s, null, 2)).then(() => {
        console.log('Net log copied:', s.length, 'entries');
      });
    });
  };

  window.__clearNet = () => _setValue(NET_KEY, '[]').then(() => console.log('cleared'));
  window.__timerLog = () => console.table(timerLog);

  // ─── NETWORK SNIFFERS ─────────────────────────────────────────────────────
  const origOpen      = XMLHttpRequest.prototype.open;
  const origSend      = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._sUrl = String(url || '');
    this._sT0  = Date.now();
    this._sH   = {};
    if (/\.m3u8/i.test(this._sUrl)) onM3u8(this._sUrl);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(n, v) {
    if (this._sH) this._sH[n] = v;
    return origSetHeader.call(this, n, v);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const url = this._sUrl || '', t0 = this._sT0 || Date.now();
    this.addEventListener('loadend', () => {
      const entry = {
        type: 'xhr', url, status: this.status,
        duration: Date.now() - t0, headers: this._sH,
        flag: interesting(url)
      };
      if (/\.m3u8/i.test(url) && this.responseText) {
        entry.m3u8 = this.responseText.slice(0, 3000);
      }
      saveNet(entry);
    });
    return origSend.call(this, body);
  };

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const t0  = Date.now();
    if (/\.m3u8/i.test(url)) onM3u8(url);
    return origFetch.call(this, input, init).then(res => {
      const entry = { type: 'fetch', url, status: res.status, duration: Date.now() - t0, flag: interesting(url) };
      if (/\.m3u8/i.test(url)) {
        res.clone().text().then(text => { entry.m3u8 = text.slice(0, 3000); saveNet(entry); }).catch(() => saveNet(entry));
      } else saveNet(entry);
      return res;
    }).catch(err => { saveNet({ type: 'fetch-error', url, error: String(err), flag: interesting(url) }); throw err; });
  };

  // Hook video src setter
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
    if (d?.set) {
      Object.defineProperty(HTMLVideoElement.prototype, 'src', {
        set(val) { if (/\.m3u8/i.test(String(val))) onM3u8(String(val)); return d.set.call(this, val); },
        get: d.get, configurable: true
      });
    }
  } catch(e) {}

  const origLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function() {
    if (this.src && /\.m3u8/i.test(this.src)) onM3u8(this.src);
    return origLoad.call(this);
  };

  // ─── M3U8 DETECTED ────────────────────────────────────────────────────────
  function onM3u8(url) {
    if (takenOver) return;
    const lowerUrl = url.toLowerCase();
    
    // Check if it's a segment file (we prefer playlists)
    const isSegment = /(seg|chunk|ts|key|license)/i.test(lowerUrl);
    if (isSegment && capturedM3u8) return; // Keep our master playlist
    
    capturedM3u8 = url;
    // Notify parent immediately
    try {
      window.parent.postMessage({ type: 'sniper:url', url, host: location.hostname }, '*');
      window.top.postMessage({ type: 'sniper:url', url, host: location.hostname }, '*');
    } catch(e) {}
    // Schedule seamless takeover
    safeSetTimeout(() => takeover(url), 600);
  }

  // ─── SEAMLESS TAKEOVER ────────────────────────────────────────────────────
  function takeover(m3u8url) {
    if (takenOver) return;
    takenOver = true;

    // Kill JWPlayer
    try { if (typeof jwplayer === 'function') { jwplayer().stop(); jwplayer().remove(); } } catch(e) {}

    // Find the player container — try common JWPlayer containers first
    const container =
      document.getElementById('player') ||
      document.querySelector('.jwplayer') ||
      document.querySelector('[id*="player"]') ||
      document.querySelector('video')?.parentElement ||
      document.body;

    // Build clean player
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      position: absolute;
      inset: 0;
      background: #000;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: stretch;
    `;

    const video = document.createElement('video');
    video.controls     = true;
    video.autoplay     = true;
    video.playsInline  = true;
    video.muted        = false;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('playsinline', '');
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;flex:1';

    // Set src AFTER appending (iOS quirk — src set before DOM insertion can fail)
    video.src = m3u8url;

    // Status indicator
    const badge = document.createElement('div');
    badge.textContent = '▶ Clean stream — no ads';
    badge.style.cssText = `
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,255,136,0.15);
      color: #00ff88;
      font: 11px monospace;
      padding: 3px 12px;
      border-radius: 4px;
      border: 1px solid rgba(0,255,136,0.3);
      pointer-events: none;
      z-index: 1;
      white-space: nowrap;
      transition: opacity 1s;
      line-height: 1.4;
    `;

    video.addEventListener('playing', () => {
      safeSetTimeout(() => badge.style.opacity = '0', 3000);
    });

    video.addEventListener('error', (e) => {
      badge.style.cssText = badge.style.cssText.replace('rgba(0,255,136,0.15)', 'rgba(255,80,80,0.2)');
      badge.style.color = '#ff8888';
      badge.textContent = '⚠ Tap 📋 to copy URL → open in VLC or Infuse';
      badge.style.opacity = '1';
      console.warn('[SNIPER] Video error:', e.target.error?.message, 'URL:', m3u8url);
    });

    // Copy URL button — always visible, subtle until needed
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy raw stream URL';
    copyBtn.style.cssText = `
      position: absolute;
      bottom: 16px;
      right: 16px;
      background: rgba(0,0,0,0.5);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.2);
      width: 36px;
      height: 36px;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(m3u8url).then(() => {
        copyBtn.textContent = '✅';
        safeSetTimeout(() => copyBtn.textContent = '📋', 2000);
      });
    });

    wrapper.appendChild(video);
    wrapper.appendChild(badge);
    wrapper.appendChild(copyBtn);

    // Inject into container surgically
    if (container !== document.body) {
      container.style.position = 'relative';
      container.style.overflow = 'hidden';
      container.innerHTML = '';
      container.appendChild(wrapper);
    } else {
      document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden';
      wrapper.style.position = 'fixed';
      document.body.innerHTML = '';
      document.body.appendChild(wrapper);
    }

    console.log('[SNIPER] ✓ Takeover complete:', m3u8url);
    saveNet({ type: 'takeover', url: m3u8url, flag: true });
  }

  // ─── PARENT COMMUNICATION ─────────────────────────────────────────────────
  window.addEventListener('message', e => {
    if (e.data === 'sniper:request_url' && capturedM3u8) {
      try { e.source.postMessage({ type: 'sniper:url', url: capturedM3u8, host: location.hostname }, '*'); } catch(e) {}
    }
  });

})();
