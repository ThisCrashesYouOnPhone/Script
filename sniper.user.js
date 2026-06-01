// ==UserScript==
// @name         Orion Stream Sniper
// @namespace    orion-stack
// @match        *://*/*
// @match        http://localhost/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1/*
// @match        http://127.0.0.1:*/*
// @match        http://10.*/*
// @match        http://192.168.*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/sniper.user.js
// @downloadURL  https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/sniper.user.js
// ==/UserScript==

(function() {
  'use strict';

  // Flag that the Orion Stream Sniper is active
  window.__orionStreamSniperActive = true;
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-stream-sniper-active', 'true');
    }
  } catch (e) {}

  const SNIPE_HOSTS = [
    'pooembed.eu',
    'embedsports.top',
    'embedhd.org',
    'exposestrat.com',
    'localhost',
    '127.0.0.1',
    '10.0.0.120',
    '192.168.'
  ];

  if (!SNIPE_HOSTS.some(function (h) { return location.hostname.includes(h); })) return;

  // -------------------------------------------------------------------------
  // LOCAL STORAGE FALLBACKS FOR GM STORAGE
  // Ensures compatibility in sandboxed extensions (Orion) where GM APIs fail
  // -------------------------------------------------------------------------
  function _getValue(key, def) {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(key, def);
        return (val && typeof val.then === 'function') ? val : Promise.resolve(val);
      }
    } catch (e) {}
    try {
      const val = localStorage.getItem(key);
      return Promise.resolve(val !== null ? val : def);
    } catch (e) {
      return Promise.resolve(def);
    }
  }

  function _setValue(key, val) {
    try {
      if (typeof GM_setValue === 'function') {
        const res = GM_setValue(key, val);
        return (res && typeof res.then === 'function') ? res : Promise.resolve(res);
      }
    } catch (e) {}
    try {
      localStorage.setItem(key, val);
      return Promise.resolve();
    } catch (e) {
      return Promise.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // PHASE 1: IMMEDIATE TIMER BLOCKING & SAFE SWEEPER
  // -------------------------------------------------------------------------
  const _realSetTimeout  = window.setTimeout.bind(window);
  const _realSetInterval = window.setInterval.bind(window);
  const _realClear       = window.clearTimeout.bind(window);

  const SAFE_DELAY_MS = 3000;
  const timerLog = [];
  const safeTimerIds = new Set();

  function safeSetTimeout(fn, delay) {
    const id = _realSetTimeout(fn, delay);
    safeTimerIds.add(id);
    return id;
  }

  window.setTimeout = function (fn, delay) {
    const numDelay = Number(delay) || 0;
    if (numDelay > SAFE_DELAY_MS) {
      timerLog.push({ type: 'timeout-blocked', delay: numDelay, fn: (fn && fn.name) ? fn.name : 'anonymous' });
      return 0;
    }
    return _realSetTimeout.apply(window, arguments);
  };

  window.setInterval = function (fn, delay) {
    const numDelay = Number(delay) || 0;
    if (numDelay > SAFE_DELAY_MS) {
      timerLog.push({ type: 'interval-blocked', delay: numDelay, fn: (fn && fn.name) ? fn.name : 'anonymous' });
      return 0;
    }
    return _realSetInterval.apply(window, arguments);
  };

  // Kill ALL timers set by initial page scripts, except our safe timers
  safeSetTimeout(function () {
    const maxId = _realSetTimeout(function () {}, 0);
    for (let i = 0; i <= maxId; i++) {
      if (!safeTimerIds.has(i)) {
        _realClear(i);
      }
    }
    timerLog.push({ type: 'sweep', killed: maxId });
  }, 600);

  // -------------------------------------------------------------------------
  // PHASE 2: POP-UP, REDIRECT, AND ALERT SHIELDS
  // -------------------------------------------------------------------------
  const _realOpen = window.open;
  window.open = function (url) {
    console.log('[SNIPER] Blocked window.open attempt to:', url);
    return {
      focus: function () {},
      close: function () {},
      closed: true
    };
  };

  window.alert   = function (msg) { console.log('[SNIPER] Blocked alert:', msg); };
  window.confirm = function (msg) { console.log('[SNIPER] Blocked confirm:', msg); return true; };

  // Inject EasyList CSS to hide visual ad banners and cookie overlays
  const AD_BLOCK_CSS = 'iframe[src*="poop"], iframe[src*="ad"], iframe[src*="doubleclick"], iframe[src*="pop"], .ad-box, .banner-ad, #ad-container, .popunder, .pop-under, .cookie-banner, [class*="popunder"], [id*="popunder"], [class*="-ad-"], [id*="-ad-"], .adsbox { display: none !important; visibility: hidden !important; pointer-events: none !important; opacity: 0 !important; height: 0 !important; width: 0 !important; }';

  function injectCSS() {
    const style = document.createElement('style');
    style.textContent = AD_BLOCK_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  if (document.head) {
    injectCSS();
  } else {
    document.addEventListener('DOMContentLoaded', injectCSS);
  }

  // -------------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------------
  let capturedM3u8  = null;
  let takenOver     = false;

  // -------------------------------------------------------------------------
  // NETWORK LOGGER
  // -------------------------------------------------------------------------
  const NET_KEY = 'orion_net_log';
  const t0      = Date.now();
  const netLog  = [];

  function saveNet(entry) {
    entry.ms = Date.now() - t0;
    entry.page = location.href;
    netLog.push(entry);
    if (entry.flag) {
      _getValue(NET_KEY, '[]').then(function (raw) {
        try {
          const logs = JSON.parse(raw);
          logs.push(entry);
          if (logs.length > 150) logs.splice(0, logs.length - 150);
          _setValue(NET_KEY, JSON.stringify(logs));
        } catch (e) {}
      }).catch(function () {});
    }
  }

  function interesting(url) {
    return /\.m3u8|\.mpd|stream|token|auth|ad|pop|redirect|track|click|secure/i.test(url);
  }

  window.__netSummary = function () {
    _getValue(NET_KEY, '[]').then(function (raw) {
      const s = JSON.parse(raw);
      console.table(s.map(function (e) {
        return { ms: e.ms, type: e.type, status: e.status, url: (e.url || '').slice(0, 80) };
      }));
    });
  };

  window.__copyNet = function () {
    _getValue(NET_KEY, '[]').then(function (raw) {
      const s = JSON.parse(raw);
      navigator.clipboard.writeText(JSON.stringify(s, null, 2)).then(function () {
        console.log('Net log copied:', s.length, 'entries');
      });
    });
  };

  window.__clearNet = function () { _setValue(NET_KEY, '[]').then(function () { console.log('cleared'); }); };
  window.__timerLog = function () { console.table(timerLog); };

  // -------------------------------------------------------------------------
  // NETWORK SNIFFERS
  // -------------------------------------------------------------------------
  const origOpen      = XMLHttpRequest.prototype.open;
  const origSend      = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function () {
    this._sUrl = String(arguments[1] || '');
    this._sT0  = Date.now();
    this._sH   = {};
    if (/\.m3u8/i.test(this._sUrl)) onM3u8(this._sUrl);
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
    if (this._sH) this._sH[n] = v;
    return origSetHeader.call(this, n, v);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._sUrl || '';
    const t0local = this._sT0 || Date.now();
    const self = this;
    this.addEventListener('loadend', function () {
      const entry = {
        type: 'xhr', url: url, status: self.status,
        duration: Date.now() - t0local, headers: self._sH,
        flag: interesting(url)
      };
      if (/\.m3u8/i.test(url) && self.responseText) {
        entry.m3u8 = self.responseText.slice(0, 3000);
      }
      saveNet(entry);
    });
    return origSend.call(this, body);
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      const input = arguments[0];
      const init  = arguments[1];
      const url = typeof input === 'string' ? input : ((input && input.url) ? input.url : '');
      const t0local = Date.now();
      if (/\.m3u8/i.test(url)) onM3u8(url);
      return origFetch.call(this, input, init).then(function (res) {
        const entry = { type: 'fetch', url: url, status: res.status, duration: Date.now() - t0local, flag: interesting(url) };
        if (/\.m3u8/i.test(url)) {
          res.clone().text().then(function (text) { entry.m3u8 = text.slice(0, 3000); saveNet(entry); }).catch(function () { saveNet(entry); });
        } else {
          saveNet(entry);
        }
        return res;
      }).catch(function (err) { saveNet({ type: 'fetch-error', url: url, error: String(err), flag: interesting(url) }); throw err; });
    };
  }

  // Hook video src setter
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
    if (d && d.set) {
      Object.defineProperty(HTMLVideoElement.prototype, 'src', {
        set: function (val) { if (/\.m3u8/i.test(String(val))) onM3u8(String(val)); return d.set.call(this, val); },
        get: d.get, configurable: true
      });
    }
  } catch (e) {}

  const origLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function () {
    if (this.src && /\.m3u8/i.test(this.src)) onM3u8(this.src);
    return origLoad.call(this);
  };

  // -------------------------------------------------------------------------
  // M3U8 DETECTED
  // -------------------------------------------------------------------------
  function onM3u8(url) {
    if (takenOver) return;
    const lowerUrl = url.toLowerCase();

    // Keep master playlists, ignore segment files
    const isSegment = /(seg|chunk|ts|key|license)/i.test(lowerUrl);
    if (isSegment && capturedM3u8) return;

    capturedM3u8 = url;
    try {
      window.parent.postMessage({ type: 'sniper:url', url: url, host: location.hostname }, '*');
      window.top.postMessage({ type: 'sniper:url', url: url, host: location.hostname }, '*');
    } catch (e) {}
    safeSetTimeout(function () { takeover(url); }, 600);
  }

  // -------------------------------------------------------------------------
  // SEAMLESS TAKEOVER
  // -------------------------------------------------------------------------
  function takeover(m3u8url) {
    if (takenOver) return;
    takenOver = true;

    // Kill JWPlayer
    try { if (typeof jwplayer === 'function') { jwplayer().stop(); jwplayer().remove(); } } catch (e) {}

    const container =
      document.getElementById('player') ||
      document.querySelector('.jwplayer') ||
      document.querySelector('[id*="player"]') ||
      (document.querySelector('video') && document.querySelector('video').parentElement) ||
      document.body;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position: absolute; inset: 0; background: #000; z-index: 2147483647; display: flex; flex-direction: column; align-items: stretch;';

    const video = document.createElement('video');
    video.controls     = true;
    video.autoplay     = true;
    video.playsInline  = true;
    video.muted        = false;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('playsinline', '');
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;flex:1';

    video.src = m3u8url;

    const badge = document.createElement('div');
    badge.textContent = '\u25b6 Clean stream \u2014 no ads';
    badge.style.cssText = 'position: absolute; top: 8px; left: 50%; transform: translateX(-50%); background: rgba(0,255,136,0.15); color: #00ff88; font: 11px monospace; padding: 3px 12px; border-radius: 4px; border: 1px solid rgba(0,255,136,0.3); pointer-events: none; z-index: 1; white-space: nowrap; transition: opacity 1s; line-height: 1.4;';

    video.addEventListener('playing', function () {
      safeSetTimeout(function () { badge.style.opacity = '0'; }, 3000);
    });

    video.addEventListener('error', function (e) {
      badge.style.background = 'rgba(255,80,80,0.2)';
      badge.style.color = '#ff8888';
      badge.textContent = '\u26a0 Tap \ud83d\udccb to copy URL \u2192 open in VLC or Infuse';
      badge.style.opacity = '1';
      console.warn('[SNIPER] Video error:', e.target && e.target.error && e.target.error.message, 'URL:', m3u8url);
    });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '\ud83d\udccb';
    copyBtn.title = 'Copy raw stream URL';
    copyBtn.style.cssText = 'position: absolute; bottom: 16px; right: 16px; background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.2); width: 36px; height: 36px; border-radius: 8px; font-size: 16px; cursor: pointer; z-index: 2; display: flex; align-items: center; justify-content: center;';

    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(m3u8url).then(function () {
        copyBtn.textContent = '\u2705';
        safeSetTimeout(function () { copyBtn.textContent = '\ud83d\udccb'; }, 2000);
      });
    });

    wrapper.appendChild(video);
    wrapper.appendChild(badge);
    wrapper.appendChild(copyBtn);

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

    console.log('[SNIPER] Takeover complete:', m3u8url);
    saveNet({ type: 'takeover', url: m3u8url, flag: true });
  }

  // -------------------------------------------------------------------------
  // PARENT COMMUNICATION
  // -------------------------------------------------------------------------
  window.addEventListener('message', function (e) {
    if (e.data === 'sniper:request_url' && capturedM3u8) {
      try { e.source.postMessage({ type: 'sniper:url', url: capturedM3u8, host: location.hostname }, '*'); } catch (e2) {}
    }
  });

})();
