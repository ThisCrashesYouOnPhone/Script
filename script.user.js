// ==UserScript==
// @name         Universal AirPlay & Stream Sniper
// @description  Universal AirPlay enabler + stream sniffer. Works on any streaming site. Auto-activates ad shields when hostile behavior is detected.
// @match        *://*/*
// @include      /^https?:\/\/localhost(:[0-9]+)?\/.*/
// @include      /^https?:\/\/127\.0\.0\.1(:[0-9]+)?\/.*/
// @include      /^https?:\/\/10\..*/
// @include      /^https?:\/\/192\.168\..*/
// @run-at       document-start
// @grant        none
// @version      3.1
// @updateURL    https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/script.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 1. CONFIGURATION & SCOPE SETUP
  // -------------------------------------------------------------------------
  // SAFE_HOSTS: Never auto-activate aggressive shields here (trusted sites).
  // The core (AirPlay enforcement + network interceptor + logger) still runs everywhere.
  const SAFE_HOSTS = [
    'youtube.com', 'youtu.be',
    'netflix.com', 'hulu.com', 'disneyplus.com', 'max.com', 'primevideo.com',
    'twitch.tv', 'vimeo.com', 'dailymotion.com',
    'google.com', 'github.com', 'stackoverflow.com',
    'cineby.sc',    // top-level Cineby page — shields would break the native AirPlay picker
  ];

  // KNOWN_SHIELD_HOSTS: Always activate shields here regardless of behavior detection.
  // Add any embed/player host you know is hostile.
  const KNOWN_SHIELD_HOSTS = [
    'videasy.net',
    'blirtonethe.com',
    'pooembed.eu',
    'embedsports.top',
    'embedhd.org',
    'exposestrat.com',
    'onandasmilee.com',
    'top-toones.com',
    'boomerang-bet.com',
    'bonusandspins.com',
    'adcash.com',
    'localhost',
    '127.0.0.1',
  ];

  const isSafeHost = SAFE_HOSTS.some(function (h) { return location.hostname.includes(h); });
  const isKnownShieldHost = KNOWN_SHIELD_HOSTS.some(function (h) { return location.hostname.includes(h); });

  // shieldsActive: starts false, flips to true either because we're on a known
  // hostile host, or because hostile behavior is auto-detected at runtime.
  let shieldsActive = isKnownShieldHost && !isSafeHost;

  const isTopFrame = (window.self === window.top);
  const startTime = Date.now();
  const LOG_KEY = 'ap_network_logs';
  const sniffedURLs = new Map();
  const processedVideos = new WeakSet();
  const observedRoots = new WeakSet();

  // Keep original references
  const _origCreateElement = document.createElement.bind(document);
  const _origFetch         = window.fetch ? window.fetch.bind(window) : null;
  const _origXHROpen       = XMLHttpRequest.prototype.open;
  const _origXHRSend       = XMLHttpRequest.prototype.send;
  const _origXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const _origAttachShadow  = Element.prototype.attachShadow;
  const _origSetAttribute  = Element.prototype.setAttribute;
  const _origRemoveAttribute = Element.prototype.removeAttribute;

  // Global flags for activation
  window.__universalAirPlayEnablerActive = true;
  window.__orionStreamSniperActive = true;
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-airplay-enabler-active', 'true');
      document.documentElement.setAttribute('data-stream-sniper-active', 'true');
    }
  } catch (e) {}

  // Helper to detect stream URLs
  function isStreamURL(url) {
    if (!url) return false;
    try {
      const decoded = decodeURIComponent(url);
      if (/(seg|chunk|ts|m4s|key|license|drm)/i.test(decoded)) return false;
      const path = new URL(decoded, location.href).pathname;
      return /\.(m3u8|mpd)$/i.test(path) || /\.(m3u8|mpd)(?:\?|$)/i.test(decoded);
    } catch (e) {
      return /\.(m3u8|mpd)(?:\?|$)/i.test(url);
    }
  }

  // Helper to determine if we should capture and log response bodies
  function shouldCaptureBody(url) {
    if (!url) return false;
    if (isStreamURL(url)) return true;
    return /sources/i.test(url) || /sources-with-title/i.test(url);
  }

  // -------------------------------------------------------------------------
  // 2. PERSISTENT LOGGER & CROSS-FRAME MESSAGING
  // -------------------------------------------------------------------------
  let logQueue = Promise.resolve();

  function getLocalLogs() {
    try {
      const val = localStorage.getItem(LOG_KEY);
      return val ? JSON.parse(val) : [];
    } catch (e) {
      return [];
    }
  }

  function setLocalLogs(logs) {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(logs));
    } catch (e) {}
  }

  function logEvent(type, url, method, status, details) {
    const timestamp = Date.now();
    const relativeTime = '+' + ((timestamp - startTime) / 1000).toFixed(1) + 's';
    
    const entry = {
      id: 'log_' + timestamp + '_' + Math.random().toString(36).substr(2, 9),
      timestamp: timestamp,
      relativeTime: relativeTime,
      type: type,
      url: url || '',
      method: method || '',
      status: status || '',
      origin: location.hostname,
      details: details || ''
    };

    dispatchLog(entry);
    return entry.id;
  }

  function updateLogEventStatus(id, status, details) {
    if (isTopFrame) {
      logQueue = logQueue.then(function () {
        const logs = getLocalLogs();
        const entry = logs.find(function (l) { return l.id === id; });
        if (entry) {
          entry.status = status;
          if (details) entry.details = details;
          setLocalLogs(logs);
          triggerUIRedraw();
        }
      });
    } else {
      try {
        window.top.postMessage({
          type: 'ap-log-update',
          id: id,
          status: status,
          details: details
        }, '*');
      } catch (e) {}
    }
  }

  function dispatchLog(entry) {
    if (isTopFrame) {
      logQueue = logQueue.then(function () {
        const logs = getLocalLogs();
        logs.push(entry);
        if (logs.length > 200) {
          logs.splice(0, logs.length - 200);
        }
        setLocalLogs(logs);
        triggerUIRedraw();
      });
    } else {
      try {
        window.top.postMessage({
          type: 'ap-log-entry',
          entry: entry
        }, '*');
      } catch (e) {}
    }
  }

  // Cross-frame message listeners
  window.addEventListener('message', function (e) {
    if (!e.data) return;

    // Log entry from child frame
    if (e.data.type === 'ap-log-entry' && e.data.entry && isTopFrame) {
      logQueue = logQueue.then(function () {
        const logs = getLocalLogs();
        logs.push(e.data.entry);
        if (logs.length > 200) {
          logs.splice(0, logs.length - 200);
        }
        setLocalLogs(logs);
        triggerUIRedraw();
      });
    }

    // Log status update from child frame
    if (e.data.type === 'ap-log-update' && e.data.id && isTopFrame) {
      logQueue = logQueue.then(function () {
        const logs = getLocalLogs();
        const entry = logs.find(function (l) { return l.id === e.data.id; });
        if (entry) {
          entry.status = e.data.status;
          if (e.data.details) entry.details = e.data.details;
          setLocalLogs(logs);
          triggerUIRedraw();
        }
      });
    }

    // Stream URL sniffed from any frame
    if (e.data.type === 'ap-sniffed-url' && e.data.url) {
      const url = e.data.url;
      const host = location.hostname;
      if (!sniffedURLs.has(host)) sniffedURLs.set(host, []);
      const list = sniffedURLs.get(host);
      if (!list.includes(url)) {
        list.push(url);
      }

      if (isTopFrame) {
        logEvent('system', url, 'SNIFF', 'SWAP-READY', 'Stream URL sniffed from child frame: ' + e.data.origin);
        
        // Parent frame: delegate capabilities to all iframes
        document.querySelectorAll('iframe').forEach(function (iframe) {
          try {
            if (iframe.getAttribute('x-webkit-airplay') !== 'allow') {
              iframe.setAttribute('x-webkit-airplay', 'allow');
            }
            if (iframe.getAttribute('airplay') !== 'allow') {
              iframe.setAttribute('airplay', 'allow');
            }
          } catch (err) {}
        });

        // Swap parent video element if exists (less common on Cineby but possible)
        const localTarget = findPlayerTarget();
        if (localTarget && localTarget.tagName === 'VIDEO') {
          performNativePlayerSwap(url);
        }
      }
    }

    // Sniper requesting URL from iframe
    if (e.data === 'sniper:request_url' && !isTopFrame) {
      const best = getBestSniffedURL();
      if (best) {
        try {
          e.source.postMessage({ type: 'ap-sniffed-url', url: best, origin: location.hostname }, '*');
        } catch (e2) {}
      }
    }
  });

  // -------------------------------------------------------------------------
  // 3. NETWORK INTERCEPTOR (PROXIES FETCH & XHR)
  // -------------------------------------------------------------------------
  function storeStreamURL(url) {
    if (!isStreamURL(url)) return;
    const host = location.hostname;
    if (!sniffedURLs.has(host)) sniffedURLs.set(host, []);
    const list = sniffedURLs.get(host);
    if (!list.includes(url)) {
      list.push(url);
      logEvent('hls', url, 'SNIFFED', 'ready', 'Stream URL captured. Use Force Swap button to activate AirPlay player.');
    }

    // Notify other frames
    try {
      const msg = { type: 'ap-sniffed-url', url: url, origin: location.hostname };
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
      if (window.top && window.top !== window) window.top.postMessage(msg, '*');
      for (var i = 0; i < window.frames.length; i++) window.frames[i].postMessage(msg, '*');
    } catch (e) {}

    // Non-destructive: inject AirPlay attrs on existing videos without replacing them
    findAllVideos(document).forEach(tryInjectHLSSource);
    // NOTE: performNativePlayerSwap is NOT called automatically.
    // Use the Force Swap button in the log panel to trigger it manually.
  }

  // Intercept XHR
  XMLHttpRequest.prototype.open = function () {
    const method = arguments[0] || 'GET';
    const url = arguments[1] || '';
    this._sUrl = String(url);
    this._sMethod = String(method);
    this._sT0 = Date.now();
    this._sH = {};

    if (isStreamURL(this._sUrl)) {
      storeStreamURL(this._sUrl);
    }

    return _origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._sH) {
      this._sH[name] = value;
    }
    return _origXHRSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const self = this;
    const url = this._sUrl || '';
    const method = this._sMethod || 'GET';
    const headers = this._sH || {};
    
    let logId = logEvent('xhr', url, method, 'pending', 'Headers: ' + JSON.stringify(headers));

    this.addEventListener('loadend', function () {
        let details = 'Status: ' + self.status;
        if (shouldCaptureBody(url) && self.responseText) {
          const typeLabel = isStreamURL(url) ? 'Manifest preview' : 'Response body';
          details += '\n' + typeLabel + ':\n' + self.responseText.slice(0, 10000);
        }
        updateLogEventStatus(logId, self.status || 200, details);
    });

    return _origXHRSend.call(this, body);
  };

  // Intercept Fetch
  if (_origFetch) {
    window.fetch = function () {
      const input = arguments[0];
      const init = arguments[1];
      const url = typeof input === 'string' ? input : ((input && input.url) ? input.url : '');
      const method = (init && init.method) || (input && input.method) || 'GET';
      const headers = (init && init.headers) || (input && input.headers) || {};
      const t0 = Date.now();

      if (isStreamURL(url)) storeStreamURL(url);

      const logId = logEvent('fetch', url, method, 'pending', 'Headers: ' + JSON.stringify(headers));

      return _origFetch.apply(this, arguments).then(function (res) {
        const elapsed = Date.now() - t0;
        if (shouldCaptureBody(url)) {
          res.clone().text().then(function (text) {
            const typeLabel = isStreamURL(url) ? 'Manifest preview' : 'Response body';
            updateLogEventStatus(logId, res.status, 'Status: ' + res.status + ' (' + elapsed + 'ms)\n' + typeLabel + ':\n' + text.slice(0, 10000));
          }).catch(function () {
            updateLogEventStatus(logId, res.status, 'Status: ' + res.status + ' (' + elapsed + 'ms)');
          });
        } else {
          updateLogEventStatus(logId, res.status, 'Status: ' + res.status + ' (' + elapsed + 'ms)');
        }
        return res;
      }).catch(function (err) {
        updateLogEventStatus(logId, 'failed', 'Error: ' + String(err));
        throw err;
      });
    };
  }

  // Intercept Media elements
  try {
    const d = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
    if (d && d.set) {
      Object.defineProperty(HTMLVideoElement.prototype, 'src', {
        set: function (val) {
          if (isStreamURL(String(val))) storeStreamURL(String(val));
          return d.set.call(this, val);
        },
        get: d.get,
        configurable: true
      });
    }
  } catch (e) {}

  // -------------------------------------------------------------------------
  // 3b. CONSOLE & ERROR CAPTURE
  // -------------------------------------------------------------------------
  (function () {
    var methods = ['log', 'warn', 'error', 'info', 'debug'];
    methods.forEach(function (m) {
      var orig = console[m];
      console[m] = function () {
        var msg = Array.prototype.slice.call(arguments).map(function (a) {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e) { return String(a); }
        }).join(' ');
        logEvent('console', msg, m.toUpperCase(), '', '');
        return orig.apply(console, arguments);
      };
    });
  })();

  window.addEventListener('error', function (e) {
    logEvent('error', e.filename || location.href, 'JS-ERROR', e.message || 'Unknown error', 'Line ' + e.lineno + ':' + e.colno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    logEvent('error', location.href, 'PROMISE-ERR', 'Unhandled rejection', String(e.reason || ''));
  });

  const origLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function () {
    if (this.src && isStreamURL(this.src)) {
      storeStreamURL(this.src);
    }
    return origLoad.call(this);
  };

  // -------------------------------------------------------------------------
  // 4. AD & REDIRECT SHIELDS (SNIPER PROTECTIONS)
  // -------------------------------------------------------------------------
  // Shields activate when: (a) on a KNOWN_SHIELD_HOST, OR (b) hostile behavior
  // is auto-detected at runtime (window.open called, long timers fired, etc.)
  // They NEVER activate on SAFE_HOSTS.

  function activateShields() {
    if (shieldsActive || isSafeHost) return; // already on or suppressed
    shieldsActive = true;
    logEvent('system', location.hostname, 'SHIELD', 'AUTO-ACTIVATED', 'Hostile behavior detected — shields auto-activated.');
  }

  if (!isSafeHost) {
    if (shieldsActive) {
      logEvent('system', '', 'SHIELD', 'ACTIVE', 'Ad-blocking sniper shields active (known host): ' + location.hostname);
    }

    // Timeout & Interval filters — run on all non-safe hosts.
    // Long-delay timers (>3s) are a hallmark of redirect ad attacks.
    const _realSetTimeout = window.setTimeout.bind(window);
    const _realSetInterval = window.setInterval.bind(window);
    const _realClearTimeout = window.clearTimeout.bind(window);
    const safeTimerIds = new Set();

    function safeSetTimeout(fn, delay) {
      const id = _realSetTimeout(fn, delay);
      safeTimerIds.add(id);
      return id;
    }

    window.setTimeout = function (fn, delay) {
      const numDelay = Number(delay) || 0;
      if (numDelay > 3000) {
        activateShields(); // a long timer is suspicious — pre-arm shields
        if (shieldsActive) {
          logEvent('blocked', 'Timeout blocked', 'TIMER', 'BLOCKED', 'Delay: ' + numDelay + 'ms | Function: ' + (fn && fn.name ? fn.name : 'anonymous'));
          return 0;
        }
      }
      return _realSetTimeout.apply(window, arguments);
    };

    window.setInterval = function (fn, delay) {
      const numDelay = Number(delay) || 0;
      if (numDelay > 3000) {
        activateShields();
        if (shieldsActive) {
          logEvent('blocked', 'Interval blocked', 'TIMER', 'BLOCKED', 'Delay: ' + numDelay + 'ms | Function: ' + (fn && fn.name ? fn.name : 'anonymous'));
          return 0;
        }
      }
      return _realSetInterval.apply(window, arguments);
    };

    // Kill page timers after load
    safeSetTimeout(function () {
      const maxId = _realSetTimeout(function () {}, 0);
      let swept = 0;
      for (let i = 0; i <= maxId; i++) {
        if (!safeTimerIds.has(i)) {
          _realClearTimeout(i);
          swept++;
        }
      }
      if (swept > 0) {
        logEvent('system', '', 'SWEEPER', 'CLEAN', 'Swept and killed ' + swept + ' background timers.');
      }
    }, 600);

    // Block Popups — auto-activate shields on first window.open call (it's always hostile)
    const _realOpen = window.open;
    window.open = function (url) {
      activateShields();
      if (shieldsActive) {
        logEvent('blocked', url, 'POPUP', 'BLOCKED', 'Blocked window.open attempt.');
        return { focus: function () {}, close: function () {}, closed: true };
      }
      return _realOpen.apply(window, arguments);
    };

    // Block Alerts & Confirms — auto-activate shields on first alert/confirm
    window.alert = function (msg) {
      activateShields();
      if (shieldsActive) {
        logEvent('blocked', 'Alert silenced', 'ALERT', 'SILENCED', msg);
        return;
      }
    };
    window.confirm = function (msg) {
      activateShields();
      if (shieldsActive) {
        logEvent('blocked', 'Confirm silenced', 'CONFIRM', 'SILENCED', msg);
        return true;
      }
    };

    // EasyList CSS block
    const AD_BLOCK_CSS = 'iframe[src*="poop"], iframe[src*="ad"], iframe[src*="doubleclick"], iframe[src*="pop"], .ad-box, .banner-ad, #ad-container, .popunder, .pop-under, .cookie-banner, [class*="popunder"], [id*="popunder"], [class*="-ad-"], [id*="-ad-"], .adsbox { display: none !important; visibility: hidden !important; pointer-events: none !important; opacity: 0 !important; height: 0 !important; width: 0 !important; }';
    function injectAdCSS() {
      const style = _origCreateElement('style');
      style.textContent = AD_BLOCK_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    if (document.head) {
      injectAdCSS();
    } else {
      document.addEventListener('DOMContentLoaded', injectAdCSS);
    }

    // AddEventListener Hijacking to prevent obfuscated click/mousedown redirects
    const _origAddEventListener = EventTarget.prototype.addEventListener;
    const REDIRECT_FN_NAMES = ['s', 'io'];
    const isObfuscatedFn = function (name) {
      return /^_0x[0-9a-f]+$/i.test(name);
    };

    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      const name = fn ? fn.name : 'anonymous';
      const isRedirectType = ['click', 'mousedown', 'touchend'].includes(type);

      if (isRedirectType && shieldsActive) {
        if (isObfuscatedFn(name)) {
          logEvent('blocked', 'Obfuscated listener', type.toUpperCase(), 'NEUTRALIZED', 'Function: ' + name);
          return;
        }
        if (REDIRECT_FN_NAMES.includes(name)) {
          logEvent('blocked', 'Redirect handler', type.toUpperCase(), 'NEUTRALIZED', 'Function: ' + name);
          return;
        }
        if (type === 'mousedown' && name === 'anonymous' && this === document) {
          logEvent('blocked', 'Anonymous document mousedown', 'MOUSE', 'DROPPED', 'Prevented trap mousedown handler.');
          return;
        }
      }

      return _origAddEventListener.call(this, type, fn, opts);
    };

    // Block untrusted link navigations (only when shields are active)
    document.addEventListener('click', function (e) {
      if (!shieldsActive) return;
      const anchor = e.target.closest('a');
      if (!anchor) return;
      const href = anchor.href || '';
      const isExternal = href && !href.startsWith(location.origin) && !/^(javascript|#|data):/.test(href);
      const isBlankOrTop = ['_blank', '_top', '_parent'].includes(anchor.target);
      
      if (!e.isTrusted && (isExternal || isBlankOrTop)) {
        logEvent('blocked', href, 'CLICK-HIJACK', 'BLOCKED', 'Blocked untrusted trigger on link.');
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    // Block .click() on HTMLElement (only when shields active)
    const _origClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (shieldsActive) {
        const anchor = this.closest ? this.closest('a') : null;
        if (anchor) {
          const href = anchor.href || '';
          const isExternal = href && !href.startsWith(location.origin) && !/^(javascript|#|data):/.test(href);
          if (isExternal) {
            logEvent('blocked', href, 'HTMLElement.click()', 'BLOCKED', 'Blocked programmatic click redirection.');
            return;
          }
        }
      }
      return _origClick.call(this);
    };

    // Block Form redirects (only when shields active)
    const _origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      if (shieldsActive && ['_blank', '_top'].includes(this.target)) {
        logEvent('blocked', this.action || location.href, 'FORM-SUBMIT', 'BLOCKED', 'Blocked programmatic form submit target redirect.');
        return;
      }
      return _origSubmit.call(this);
    };

    // Meta-refresh blocker
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.tagName === 'META' && node.httpEquiv && node.httpEquiv.toLowerCase() === 'refresh') {
            logEvent('blocked', node.content, 'META-REFRESH', 'BLOCKED', 'Blocked meta-refresh tag.');
            node.remove();
          }
        });
      });
    }).observe(document.documentElement || document, { childList: true, subtree: true });

    // Embed-domain anchor mousedown block (only when shields active)
    document.addEventListener('mousedown', function (e) {
      if (!shieldsActive) return;
      const anchor = e.target.closest('a');
      if (anchor) {
        logEvent('blocked', anchor.href, 'MOUSEDOWN', 'BLOCKED', 'Blocked mousedown click-jacking on link.');
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);

    // Surgical iframe sandboxing
    const AD_IFRAME_PATTERNS = ['/ad.html', 'adcash.com', 'top-toones.com', 'onandasmilee.com', 'bonusandspins.com'];
    // Player iframes — never sandbox these regardless of host
    const PLAYER_IFRAME_PATTERNS = [
      'videasy.net', 'jwplayer', 'plyr', 'vidcloud', 'streamtape',
      'mixdrop', 'doodstream', 'filemoon', 'voe.sx', 'upstream'
    ];
    const SAFE_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation';

    function handleIframe(iframe) {
      const src = iframe.getAttribute('src') || iframe.src || '';
      if (src && PLAYER_IFRAME_PATTERNS.some(function (p) { return src.includes(p); })) return; // Let players run free

      if (src && AD_IFRAME_PATTERNS.some(function (p) { return src.includes(p); })) {
        iframe.setAttribute('sandbox', ''); // total block
        iframe.src = 'about:blank';
        logEvent('blocked', src, 'AD-IFRAME', 'BLOCKED', 'Totally blocked ad iframe.');
        return;
      }

      try {
        if (iframe.contentWindow && iframe.contentWindow.location && iframe.contentWindow.location.origin === location.origin) return;
      } catch (e) {
        // Cross-origin iframe
        const existing = iframe.getAttribute('sandbox');
        if (existing === null) {
          iframe.setAttribute('sandbox', SAFE_SANDBOX);
          logEvent('system', src, 'SANDBOX', 'APPLIED', 'Surgically sandboxed third-party iframe.');
        } else if (existing.includes('allow-top-navigation') || existing.includes('allow-popups')) {
          const cleaned = existing
            .replace(/allow-top-navigation(-by-user-activation)?/gi, '')
            .replace(/allow-popups(-to-escape-sandbox)?/gi, '')
            .trim();
          iframe.setAttribute('sandbox', cleaned);
          logEvent('system', src, 'SANDBOX', 'STRIPPED', 'Stripped dangerous navigation/popup attributes from iframe.');
        }
      }
    }

    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.tagName === 'IFRAME') handleIframe(node);
          else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(handleIframe);
        });
      });
    }).observe(document.documentElement || document, { childList: true, subtree: true });

    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('iframe').forEach(handleIframe);
    });
  } // end !isSafeHost block

  // -------------------------------------------------------------------------
  // 5. AIRPLAY CORE MODULE
  // -------------------------------------------------------------------------
  document.createElement = function () {
    const el = _origCreateElement.apply(document, arguments);
    const tag = arguments[0];
    if (typeof tag === 'string' && tag.toLowerCase() === 'video') {
      el.setAttribute('x-webkit-airplay', 'allow');
      el.setAttribute('airplay', 'allow');
    }
    return el;
  };

  if (_origAttachShadow) {
    Element.prototype.attachShadow = function (init) {
      const shadow = _origAttachShadow.call(this, init);
      if (shadow) {
        observeRoot(shadow);
        setTimeout(function () {
          findAllVideos(shadow).forEach(processVideo);
        }, 0);
      }
      return shadow;
    };
  }

  // Force allow attributes on setAttribute/removeAttribute
  Element.prototype.setAttribute = function (name, value) {
    const tagName = this.tagName ? this.tagName.toLowerCase() : '';
    if (tagName === 'video') {
      const lowerName = name.toLowerCase();
      if (lowerName === 'disableremoteplayback' || lowerName === 'x-webkit-wireless-video-playback-disabled') {
        return; // Ignore blocker
      }
      if (lowerName === 'x-webkit-airplay' || lowerName === 'airplay') {
        return _origSetAttribute.call(this, name, 'allow'); // Force allow
      }
    }
    return _origSetAttribute.call(this, name, value);
  };

  Element.prototype.removeAttribute = function (name) {
    const tagName = this.tagName ? this.tagName.toLowerCase() : '';
    if (tagName === 'video') {
      const lowerName = name.toLowerCase();
      if (lowerName === 'x-webkit-airplay' || lowerName === 'airplay') {
        return; // Lock capabilities
      }
    }
    return _origRemoveAttribute.call(this, name);
  };

  function cleanBlockedAttributes(video) {
    if (video.hasAttribute('disableremoteplayback')) video.removeAttribute('disableremoteplayback');
    if (video.hasAttribute('x-webkit-wireless-video-playback-disabled')) video.removeAttribute('x-webkit-wireless-video-playback-disabled');
    if (video.getAttribute('x-webkit-airplay') !== 'allow') video.setAttribute('x-webkit-airplay', 'allow');
    if (video.getAttribute('airplay') !== 'allow') video.setAttribute('airplay', 'allow');
  }

  function getBestSniffedURL() {
    const list = sniffedURLs.get(location.hostname);
    if (!list || list.length === 0) return null;
    const preferred = list.find(function (u) {
      return /\.m3u8/i.test(u) && /master|playlist|index/i.test(u);
    });
    return preferred || list.find(function (u) { return /\.m3u8/i.test(u); }) || list[list.length - 1];
  }

  function isMSEVideo(video) {
    return (video.src && video.src.startsWith('blob:')) ||
           (video.srcObject && typeof MediaSource !== 'undefined' && video.srcObject instanceof MediaSource);
  }

  function tryInjectHLSSource(video) {
    if (video.id === 'ap-mirror-video' || video.id === 'ap-native-video') return false;
    if (!isMSEVideo(video)) return false;
    const streamURL = getBestSniffedURL();
    if (!streamURL) return false;

    const existing = video.querySelector('source[data-ap-injected]');
    if (existing) {
      if (existing.src !== streamURL) {
        existing.src = streamURL;
        if (typeof video.load === 'function') video.load();
      }
      return true;
    }

    const source = _origCreateElement('source');
    source.setAttribute('type', 'application/x-mpegURL');
    source.setAttribute('src', streamURL);
    source.setAttribute('data-ap-injected', 'true');
    video.appendChild(source);
    
    if (typeof video.load === 'function') video.load();
    return true;
  }

  function forcePropertyFalse(proto, prop) {
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: true,
        get: function () { return false; },
        set: function () {}
      });
    } catch(e) {}
  }

  try {
    forcePropertyFalse(HTMLMediaElement.prototype, 'disableRemotePlayback');
    forcePropertyFalse(HTMLMediaElement.prototype, 'webkitWirelessVideoPlaybackDisabled');
  } catch (e) {}

  // -------------------------------------------------------------------------
  // 6. SAME-ORIGIN IFRAME SWAP / TAKEOVER
  // -------------------------------------------------------------------------
  let swapDone = false;

  function findPlayerTarget() {
    const allVideos = findAllVideos(document);
    for (let j = 0; j < allVideos.length; j++) {
      if (allVideos[j].id !== 'ap-native-video' && allVideos[j].id !== 'ap-mirror-video') {
        return allVideos[j];
      }
    }
    return null;
  }

  function performNativePlayerSwap(streamURL) {
    if (swapDone) {
      const existing = document.getElementById('ap-native-video');
      if (existing && existing.src !== streamURL) {
        existing.src = streamURL;
        if (typeof existing.load === 'function') existing.load();
        existing.play().catch(function () {});
      }
      return;
    }

    const target = findPlayerTarget();
    if (!target) return; // Keep checking on triggers

    swapDone = true;
    logEvent('takeover', streamURL, 'SWAP', 'COMPLETED', 'Native Player Swap triggered. Native video element inserted.');

    // Shut down JWPlayer if running
    try {
      if (typeof jwplayer === 'function') {
        jwplayer().stop();
        jwplayer().remove();
      }
    } catch (e) {}

    // Find parent container or container wrapper
    let container = target.parentNode;
    if (target.closest) {
      const playerWrapper = target.closest('#player') || target.closest('.jwplayer') || target.closest('[id*="player"]');
      if (playerWrapper) container = playerWrapper;
    }

    const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    const width  = target.offsetWidth  || (rect && rect.width)  || 640;
    const height = target.offsetHeight || (rect && rect.height) || 360;

    let savedTime = 0;
    if (target.tagName === 'VIDEO' && !isNaN(target.currentTime)) {
      savedTime = target.currentTime;
    }

    const nativeVideo = _origCreateElement('video');
    nativeVideo.id            = 'ap-native-video';
    nativeVideo.controls      = true;
    nativeVideo.autoplay      = true;
    nativeVideo.playsInline   = true;
    nativeVideo.src           = streamURL;
    nativeVideo.currentTime   = savedTime;
    nativeVideo.style.cssText = 'display:block; width:100%; height:100%; object-fit:contain; background:#000; outline:none; border-radius:inherit';

    _origSetAttribute.call(nativeVideo, 'x-webkit-airplay', 'allow');
    _origSetAttribute.call(nativeVideo, 'airplay', 'allow');
    _origSetAttribute.call(nativeVideo, 'webkit-playsinline', '');
    _origSetAttribute.call(nativeVideo, 'playsinline', '');
    _origSetAttribute.call(nativeVideo, 'referrerpolicy', 'no-referrer');

    // Build wrap structure
    const wrap = _origCreateElement('div');
    wrap.style.cssText = 'position:relative; width:' + (width ? width + 'px' : '100%') + '; height:' + (height ? height + 'px' : '100%') + '; background:#000; overflow:hidden';
    wrap.appendChild(nativeVideo);

    // Status label / badge
    const badge = _origCreateElement('div');
    badge.textContent = '▶ Clean Native Stream — No Ads';
    badge.style.cssText = 'position: absolute; top: 12px; left: 50%; transform: translateX(-50%); background: rgba(16, 185, 129, 0.15); color: #34d399; font: bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 4px 12px; border-radius: 20px; border: 1px solid rgba(16, 185, 129, 0.3); pointer-events: none; z-index: 10; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); transition: opacity 0.8s;';
    wrap.appendChild(badge);

    // Copy stream button
    const copyBtn = _origCreateElement('button');
    copyBtn.innerHTML = '📋';
    copyBtn.title = 'Copy raw m3u8 stream URL';
    copyBtn.style.cssText = 'position: absolute; top: 12px; right: 12px; z-index: 11; width: 32px; height: 32px; background: rgba(18, 18, 18, 0.7); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);';
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      navigator.clipboard.writeText(streamURL).then(function () {
        copyBtn.innerHTML = '✅';
        setTimeout(function () { copyBtn.innerHTML = '📋'; }, 2000);
      });
    });
    wrap.appendChild(copyBtn);

    nativeVideo.addEventListener('playing', function () {
      setTimeout(function () { badge.style.opacity = '0'; }, 3000);
    });

    nativeVideo.addEventListener('error', function (e) {
      badge.style.background = 'rgba(239, 68, 68, 0.2)';
      badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      badge.style.color = '#f87171';
      badge.textContent = '⚠️ Tap 📋 to copy URL and play in VLC / Infuse';
      badge.style.opacity = '1';
    });

    // Swap in container
    if (container !== document.body) {
      container.innerHTML = '';
      container.appendChild(wrap);
    } else {
      document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden';
      wrap.style.position = 'fixed';
      wrap.style.inset = '0';
      wrap.style.width = '100vw';
      wrap.style.height = '100vh';
      document.body.innerHTML = '';
      document.body.appendChild(wrap);
    }

    nativeVideo.play().catch(function () {});
    processedVideos.delete(nativeVideo);
    processVideo(nativeVideo);
  }

  // -------------------------------------------------------------------------
  // 7. WEBKIT LOG PANEL UI (TOP FRAME ONLY)
  // -------------------------------------------------------------------------
  let uiRedrawTimer = null;

  function triggerUIRedraw() {
    if (!isTopFrame) return;
    if (uiRedrawTimer) clearTimeout(uiRedrawTimer);
    uiRedrawTimer = setTimeout(renderLogUI, 50);
  }

  function injectLogUI() {
    if (!isTopFrame) return;

    // Avoid double injection
    if (document.getElementById('ap-log-badge')) return;

    // Inject Styles
    const style = _origCreateElement('style');
    style.textContent = `
      #ap-log-badge {
        position: fixed;
        bottom: 20px;
        left: 20px;
        z-index: 2147483647;
        background: rgba(18, 18, 18, 0.75);
        backdrop-filter: blur(12px) saturate(180%);
        -webkit-backdrop-filter: blur(12px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #ffffff;
        padding: 8px 14px;
        border-radius: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        gap: 8px;
        transition: transform 0.2s, background 0.2s;
        user-select: none;
        -webkit-user-select: none;
      }
      #ap-log-badge:active {
        transform: scale(0.95);
        background: rgba(30, 30, 30, 0.9);
      }
      #ap-log-pulse {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 8px #10b981;
      }
      @keyframes ap-pulse {
        0% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.3); opacity: 0.6; }
        100% { transform: scale(1); opacity: 1; }
      }
      .ap-pulsing {
        animation: ap-pulse 2s infinite ease-in-out;
      }

      #ap-log-panel {
        position: fixed;
        bottom: 75px;
        left: 20px;
        z-index: 2147483647;
        width: calc(100% - 40px);
        max-width: 480px;
        height: 400px;
        background: rgba(18, 18, 18, 0.85);
        backdrop-filter: blur(24px) saturate(190%);
        -webkit-backdrop-filter: blur(24px) saturate(190%);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #e5e7eb;
      }
      #ap-log-header {
        padding: 12px 16px;
        background: rgba(255, 255, 255, 0.03);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      #ap-log-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: #ffffff;
      }
      #ap-log-close {
        background: transparent;
        border: none;
        color: #9ca3af;
        font-size: 18px;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
      }
      #ap-log-controls {
        padding: 8px 16px;
        background: rgba(0, 0, 0, 0.2);
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        display: flex;
        gap: 8px;
        align-items: center;
        overflow-x: auto;
        white-space: nowrap;
        -webkit-overflow-scrolling: touch;
      }
      .ap-log-btn {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #f3f4f6;
        font-size: 11px;
        font-weight: 600;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .ap-log-btn:active {
        background: rgba(255, 255, 255, 0.15);
      }
      #ap-log-container {
        flex: 1;
        overflow-y: auto;
        padding: 12px 16px;
        -webkit-overflow-scrolling: touch;
      }
      .ap-log-row {
        font-family: ui-monospace, SFMono-Regular, SF Pro Icons, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        line-height: 1.4;
        padding: 6px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        word-break: break-all;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .ap-log-time {
        color: #6b7280;
      }
      .ap-log-badge-inline {
        display: inline-block;
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 9px;
        font-weight: bold;
        text-transform: uppercase;
        margin-right: 4px;
      }
      .ap-log-badge-hls {
        background: rgba(16, 185, 129, 0.15);
        color: #10b981;
        border: 1px solid rgba(16, 185, 129, 0.3);
      }
      .ap-log-badge-takeover {
        background: rgba(251, 191, 36, 0.15);
        color: #fbbf24;
        border: 1px solid rgba(251, 191, 36, 0.3);
      }
      .ap-log-badge-blocked {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
        border: 1px solid rgba(239, 68, 68, 0.3);
      }
      .ap-log-badge-system {
        background: rgba(6, 182, 212, 0.15);
        color: #06b6d4;
        border: 1px solid rgba(6, 182, 212, 0.3);
      }
      .ap-log-badge-xhr {
        background: rgba(255, 255, 255, 0.06);
        color: #d1d5db;
      }
      .ap-log-badge-fetch {
        background: rgba(255, 255, 255, 0.06);
        color: #d1d5db;
      }
      .ap-log-row-content {
        color: #f3f4f6;
        cursor: pointer;
      }
      .ap-log-row-url {
        color: #9ca3af;
      }
      .ap-log-row-url.hls {
        color: #34d399;
        font-weight: bold;
      }
      .ap-log-row-expanded {
        margin-top: 4px;
        padding: 6px;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        white-space: pre-wrap;
        word-break: break-all;
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    // Create Badge
    const badge = _origCreateElement('div');
    badge.id = 'ap-log-badge';
    badge.innerHTML = '<div id="ap-log-pulse" class="ap-pulsing"></div><span>WebKit Log</span>';
    badge.addEventListener('click', toggleLogPanel);
    document.body.appendChild(badge);

    // Create Panel
    const panel = _origCreateElement('div');
    panel.id = 'ap-log-panel';
    panel.innerHTML = `
      <div id="ap-log-header">
        <span id="ap-log-title">📡 WebKit Network Monitor</span>
        <button id="ap-log-close">✕</button>
      </div>
      <div id="ap-log-controls">
        <button class="ap-log-btn" id="ap-log-btn-airplay" style="background:rgba(16,185,129,0.15);border-color:rgba(16,185,129,0.4);color:#10b981;">📺 Inject AirPlay</button>
        <button class="ap-log-btn" id="ap-log-btn-swap" style="background:rgba(251,191,36,0.12);border-color:rgba(251,191,36,0.35);color:#fbbf24;">🎯 Force Swap</button>
        <button class="ap-log-btn" id="ap-log-btn-har">📤 Download HAR</button>
        <button class="ap-log-btn" id="ap-log-btn-copy">📋 Copy</button>
        <button class="ap-log-btn" id="ap-log-btn-clear">🗑️ Clear</button>
        <label style="font-size: 11px; display: flex; align-items: center; gap: 4px; color: #9ca3af; margin-left: auto;">
          <input type="checkbox" id="ap-log-autoscroll" checked> Auto-scroll
        </label>
      </div>
      <div id="ap-log-container"></div>
    `;
    
    document.body.appendChild(panel);

    panel.querySelector('#ap-log-close').addEventListener('click', toggleLogPanel);
    panel.querySelector('#ap-log-btn-copy').addEventListener('click', copyLogsToClipboard);
    panel.querySelector('#ap-log-btn-har').addEventListener('click', downloadLogsHAR);
    panel.querySelector('#ap-log-btn-clear').addEventListener('click', clearLogsStorage);

    panel.querySelector('#ap-log-btn-airplay').addEventListener('click', function () {
      var vids = findAllVideos(document);
      vids.forEach(function (v) { cleanBlockedAttributes(v); });
      var count = vids.length;
      logEvent('system', location.href, 'AIRPLAY-INJECT', count > 0 ? 'OK' : 'NO-VIDEOS', 'Injected AirPlay attrs on ' + count + ' video element(s)');
      var btn = document.getElementById('ap-log-btn-airplay');
      if (btn) { btn.textContent = '✅ Done (' + count + ')'; setTimeout(function(){ btn.textContent = '📺 Inject AirPlay'; }, 2000); }
    });

    panel.querySelector('#ap-log-btn-swap').addEventListener('click', function () {
      var url = getBestSniffedURL();
      if (!url) {
        logEvent('system', '', 'SWAP', 'NO-URL', 'No stream URL sniffed yet. Play a video first.');
        var btn = document.getElementById('ap-log-btn-swap');
        if (btn) { btn.textContent = '⚠️ No URL yet'; setTimeout(function(){ btn.textContent = '🎯 Force Swap'; }, 2000); }
        return;
      }
      logEvent('system', url, 'SWAP', 'MANUAL', 'Manual Force Swap triggered by user.');
      performNativePlayerSwap(url);
      var btn = document.getElementById('ap-log-btn-swap');
      if (btn) { btn.textContent = '✅ Swapped!'; setTimeout(function(){ btn.textContent = '🎯 Force Swap'; }, 2000); }
    });

    renderLogUI();
  }

  function toggleLogPanel() {
    const panel = document.getElementById('ap-log-panel');
    if (!panel) return;
    const isVisible = panel.style.display === 'flex';
    panel.style.display = isVisible ? 'none' : 'flex';
    if (!isVisible) renderLogUI();
  }

  function copyLogsToClipboard() {
    const btn = document.getElementById('ap-log-btn-copy');
    const logs = getLocalLogs();
    const formatted = logs.map(function (l) {
      return '[' + l.relativeTime + ' - ' + l.origin + '] [' + l.type.toUpperCase() + ' ' + l.status + '] ' + l.method + ' ' + l.url + '\n' + (l.details ? 'Details: ' + l.details : '');
    }).join('\n\n--------------------\n\n');

    navigator.clipboard.writeText(formatted).then(function () {
      if (btn) {
        btn.textContent = '✅ Copied!';
        setTimeout(function () { btn.textContent = '📋 Copy Logs'; }, 2000);
      }
    });
  }

  function downloadLogsHAR() {
    var btn = document.getElementById('ap-log-btn-har');
    var logs = getLocalLogs();
    var networkEntries = [];
    var consoleLogs = [];

    logs.forEach(function (l) {
      if (l.type === 'console' || l.type === 'error') {
        consoleLogs.push({
          timestamp: new Date(l.timestamp).toISOString(),
          level: l.method || l.type,
          message: l.url + (l.details ? ' | ' + l.details : '')
        });
        return;
      }
      if (l.type !== 'xhr' && l.type !== 'fetch' && l.type !== 'hls') return;

      // Parse status
      var status = parseInt(l.status, 10);
      if (isNaN(status)) status = 0;

      networkEntries.push({
        startedDateTime: new Date(l.timestamp).toISOString(),
        time: -1,
        request: {
          method: l.method || 'GET',
          url: l.url,
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: status,
          statusText: String(l.status),
          httpVersion: 'HTTP/1.1',
          headers: [],
          cookies: [],
          content: {
            size: -1,
            mimeType: isStreamURL(l.url) ? 'application/x-mpegURL' : 'application/octet-stream',
            text: l.details || ''
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1
        },
        cache: {},
        timings: { send: 0, wait: -1, receive: -1 }
      });
    });

    var har = {
      log: {
        version: '1.2',
        creator: { name: 'AP WebKit Logger', version: '3.1', comment: 'Captured on ' + location.hostname },
        pages: [{
          startedDateTime: logs.length > 0 ? new Date(logs[0].timestamp).toISOString() : new Date().toISOString(),
          id: 'page_1',
          title: document.title || location.href,
          pageTimings: {}
        }],
        entries: networkEntries,
        _consoleLogs: consoleLogs,
        _capturedAt: new Date().toISOString(),
        _pageUrl: location.href
      }
    };

    var blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = _origCreateElement('a');
    a.href = url;
    a.download = 'webkit-capture-' + Date.now() + '.har';
    a.click();
    URL.revokeObjectURL(url);

    if (btn) {
      btn.textContent = '✅ Downloaded';
      setTimeout(function () { btn.textContent = '📤 Download HAR'; }, 2000);
    }
  }

  function clearLogsStorage() {
    setLocalLogs([]);
    renderLogUI();
  }

  const expandedLogs = new Set();

  function renderLogUI() {
    const container = document.getElementById('ap-log-container');
    if (!container) return;

    const logs = getLocalLogs();
    container.innerHTML = '';

    if (logs.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: #6b7280; font-size: 12px; margin-top: 50px;">No logs recorded yet.</div>';
      return;
    }

    logs.forEach(function (log) {
      const row = _origCreateElement('div');
      row.className = 'ap-log-row';

      const isHLS = isStreamURL(log.url) || log.type === 'takeover';
      const isBlocked = log.type === 'blocked';

      let typeBadge = log.type;
      let badgeClass = 'ap-log-badge-' + log.type;
      if (isHLS) {
        typeBadge = 'HLS';
        badgeClass = 'ap-log-badge-hls';
      } else if (log.type === 'takeover') {
        typeBadge = 'Takeover';
        badgeClass = 'ap-log-badge-takeover';
      }

      const headerDiv = _origCreateElement('div');
      headerDiv.style.cssText = 'display: flex; align-items: center; gap: 4px; cursor: pointer;';
      headerDiv.className = 'ap-log-row-content';
      
      const timeSpan = _origCreateElement('span');
      timeSpan.className = 'ap-log-time';
      timeSpan.textContent = '[' + log.relativeTime + ']';

      const originSpan = _origCreateElement('span');
      originSpan.style.cssText = 'color: #9ca3af; font-weight: bold; margin-right: 4px;';
      originSpan.textContent = '[' + log.origin.replace('www.', '') + ']';

      const badgeSpan = _origCreateElement('span');
      badgeSpan.className = 'ap-log-badge-inline ' + badgeClass;
      badgeSpan.textContent = typeBadge;

      const methodSpan = _origCreateElement('span');
      methodSpan.style.fontWeight = 'bold';
      methodSpan.textContent = log.method ? log.method + ' ' : '';

      const statusSpan = _origCreateElement('span');
      statusSpan.style.color = log.status === 'pending' ? '#fbbf24' : (log.status === 'failed' || log.status >= 400 || isBlocked ? '#f87171' : '#34d399');
      statusSpan.textContent = '[' + log.status + '] ';

      const urlSpan = _origCreateElement('span');
      urlSpan.className = 'ap-log-row-url' + (isHLS ? ' hls' : '');
      urlSpan.textContent = log.url ? log.url.split('?')[0] : '(no url)';

      headerDiv.appendChild(timeSpan);
      headerDiv.appendChild(originSpan);
      headerDiv.appendChild(badgeSpan);
      if (log.method) headerDiv.appendChild(methodSpan);
      headerDiv.appendChild(statusSpan);
      headerDiv.appendChild(urlSpan);
      row.appendChild(headerDiv);

      const isExpanded = expandedLogs.has(log.id);

      if (isExpanded) {
        const detailsDiv = _origCreateElement('div');
        detailsDiv.className = 'ap-log-row-expanded';
        
        let detailsText = 'URL: ' + log.url + '\nOrigin: ' + log.origin + '\nTimestamp: ' + new Date(log.timestamp).toLocaleTimeString();
        if (log.details) {
          detailsText += '\n\n' + log.details;
        }

        // Add copy button inside details
        const copyRaw = _origCreateElement('button');
        copyRaw.className = 'ap-log-btn';
        copyRaw.style.cssText = 'margin-top: 8px; display: block;';
        copyRaw.textContent = 'Copy URL';
        copyRaw.addEventListener('click', function (e) {
          e.stopPropagation();
          navigator.clipboard.writeText(log.url).then(function () {
            copyRaw.textContent = '✅ Copied!';
            setTimeout(function () { copyRaw.textContent = 'Copy URL'; }, 2000);
          });
        });

        detailsDiv.textContent = detailsText;
        detailsDiv.appendChild(copyRaw);
        row.appendChild(detailsDiv);
      }

      headerDiv.addEventListener('click', function () {
        if (isExpanded) {
          expandedLogs.delete(log.id);
        } else {
          expandedLogs.add(log.id);
        }
        renderLogUI();
      });

      container.appendChild(row);
    });

    const autoscroll = document.getElementById('ap-log-autoscroll');
    if (autoscroll && autoscroll.checked) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // -------------------------------------------------------------------------
  // 8. DOM WATCHER & INIT ROUTING
  // -------------------------------------------------------------------------
  function findAllVideos(root) {
    const list = [];
    if (!root) return list;
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('video').forEach(function (v) {
        if (v.id !== 'ap-mirror-video') list.push(v);
      });
    }
    const walker = document.createTreeWalker(
      root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root : (root.shadowRoot || root),
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );
    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) {
        findAllVideos(node.shadowRoot).forEach(function (v) {
          if (v.id !== 'ap-mirror-video') list.push(v);
        });
      }
      node = walker.nextNode();
    }
    return list;
  }

  function processVideo(video) {
    if (video.id === 'ap-mirror-video') return;
    if (processedVideos.has(video)) return;
    processedVideos.add(video);

    cleanBlockedAttributes(video);

    if (isMSEVideo(video)) {
      if (!tryInjectHLSSource(video)) {
        setTimeout(function () { tryInjectHLSSource(video); }, 800);
        setTimeout(function () { tryInjectHLSSource(video); }, 2500);
        setTimeout(function () { tryInjectHLSSource(video); }, 5000);
      }
    } else {
      video.setAttribute('x-webkit-airplay', 'allow');
      video.setAttribute('airplay', 'allow');
    }
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(function (node) {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.tagName === 'VIDEO') {
              processVideo(node);
            } else {
              findAllVideos(node).forEach(processVideo);
            }
          });
        } else if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target && target.tagName === 'VIDEO') {
            if (mutation.attributeName === 'src') {
              if (isMSEVideo(target)) {
                tryInjectHLSSource(target);
              }
            } else if (
              mutation.attributeName === 'disableremoteplayback' ||
              mutation.attributeName === 'x-webkit-wireless-video-playback-disabled' ||
              mutation.attributeName === 'x-webkit-airplay' ||
              mutation.attributeName === 'airplay'
            ) {
              cleanBlockedAttributes(target);
            }
          }
        }
      });
    });

    observer.observe(root, {
      childList: true,
      subtree:   true,
      attributes: true,
      attributeFilter: ['src', 'disableremoteplayback', 'x-webkit-wireless-video-playback-disabled', 'x-webkit-airplay', 'airplay']
    });
  }

  function init() {
    observeRoot(document.documentElement);
    findAllVideos(document).forEach(processVideo);
    
    if (isTopFrame) {
      injectLogUI();
      // Schedule backup UI injector in case body wasn't fully loaded
      setTimeout(injectLogUI, 1000);
      setTimeout(injectLogUI, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();