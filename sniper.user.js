// ==UserScript==
// @name         Orion Stream Sniper
// @namespace    orion-stack
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function() {

  // Only run on embed hosts that carry the actual video player
  const SNIPE_HOSTS = [
    'pooembed.eu',
    'embedsports.top',
    'embedhd.org',
    'exposestrat.com',
  ];

  if (!SNIPE_HOSTS.some(h => location.hostname.includes(h))) return;

  // ─── STATE ────────────────────────────────────────────────────────────────
  let capturedM3u8   = null;
  let takenOver      = false;
  let takeoverTimer  = null;
  // ──────────────────────────────────────────────────────────────────────────


  // ─── NETWORK LOGGER ───────────────────────────────────────────────────────
  // Captures timing, status, and m3u8 playlist content from all XHR/fetch
  // This is what the iOS network tab can't show us
  const NET_KEY  = 'orion_net_log';
  const t0_page  = Date.now();
  const netLog   = [];

  function saveNetEntry(entry) {
    entry.ms_since_load = Date.now() - t0_page;
    entry.page          = location.href;
    netLog.push(entry);
    // Persist only interesting entries
    if (entry.flag) {
      GM_getValue(NET_KEY, '[]').then(raw => {
        try {
          const logs = JSON.parse(raw);
          logs.push(entry);
          if (logs.length > 100) logs.splice(0, logs.length - 100);
          GM_setValue(NET_KEY, JSON.stringify(logs));
        } catch(e) {}
      }).catch(() => {});
    }
  }

  function isNetInteresting(url) {
    return /\.m3u8|\.mpd|stream|token|key|auth|ad|pop|redirect|click|track/i.test(url);
  }

  // Expose net log helpers to console
  window.__netLog     = () => netLog;
  window.__netSummary = async () => {
    const saved = JSON.parse(await GM_getValue(NET_KEY, '[]'));
    console.table(saved.map(e => ({
      ms:     e.ms_since_load,
      type:   e.type,
      status: e.status,
      url:    e.url?.slice(0, 80)
    })));
  };
  window.__copyNet = async () => {
    const saved = JSON.parse(await GM_getValue(NET_KEY, '[]'));
    await navigator.clipboard.writeText(JSON.stringify(saved, null, 2));
    console.log('Network log copied — ' + saved.length + ' entries');
  };
  window.__clearNet = () => GM_setValue(NET_KEY, '[]').then(() => console.log('Net log cleared'));
  // ──────────────────────────────────────────────────────────────────────────


  // ─── NETWORK SNIFFERS (run at document-start, before any page JS) ─────────

  // Hook XMLHttpRequest — captures timing + response for m3u8 files
  const origOpen       = XMLHttpRequest.prototype.open;
  const origSend       = XMLHttpRequest.prototype.send;
  const origSetHeader  = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._sUrl     = String(url || '');
    this._sMethod  = method;
    this._sHeaders = {};
    this._sT0      = Date.now();
    if (/\.m3u8/i.test(this._sUrl)) onM3u8(this._sUrl);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, val) {
    if (this._sHeaders) this._sHeaders[name] = val;
    return origSetHeader.call(this, name, val);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const url     = this._sUrl || '';
    const method  = this._sMethod || 'GET';
    const headers = this._sHeaders || {};
    const t0      = this._sT0 || Date.now();

    this.addEventListener('loadend', () => {
      const entry = {
        type:     'xhr',
        method,
        url,
        status:   this.status,
        duration: Date.now() - t0,
        headers,
        flag:     isNetInteresting(url)
      };
      // For m3u8 responses, capture the playlist content — reveals CDN structure
      if (/\.m3u8/i.test(url) && this.responseText) {
        entry.m3u8_content = this.responseText.slice(0, 2000); // first 2kb is enough
      }
      saveNetEntry(entry);
    });

    return origSend.call(this, body);
  };

  // Hook fetch — with timing and interesting-request flagging
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url    = typeof input === 'string' ? input : (input?.url || '');
    const method = init?.method || 'GET';
    const t0     = Date.now();

    if (/\.m3u8/i.test(url)) onM3u8(url);

    return origFetch.call(this, input, init).then(res => {
      const entry = {
        type:     'fetch',
        method,
        url,
        status:   res.status,
        duration: Date.now() - t0,
        flag:     isNetInteresting(url)
      };
      // Clone and read m3u8 response bodies
      if (/\.m3u8/i.test(url)) {
        res.clone().text().then(text => {
          entry.m3u8_content = text.slice(0, 2000);
          saveNetEntry(entry);
        }).catch(() => saveNetEntry(entry));
      } else {
        saveNetEntry(entry);
      }
      return res;
    }).catch(err => {
      saveNetEntry({ type: 'fetch-error', method, url, error: String(err), duration: Date.now() - t0, flag: isNetInteresting(url) });
      throw err;
    });
  };

  // Hook video element src setter — catches when JWPlayer sets src directly
  try {
    const origDesc = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
    if (origDesc?.set) {
      Object.defineProperty(HTMLVideoElement.prototype, 'src', {
        set(val) {
          if (typeof val === 'string' && /\.m3u8/i.test(val)) onM3u8(val);
          return origDesc.set.call(this, val);
        },
        get: origDesc.get,
        configurable: true
      });
    }
  } catch(e) {}

  // Hook video.load() and src attribute to catch all paths
  const origLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function() {
    if (this.src && /\.m3u8/i.test(this.src)) onM3u8(this.src);
    return origLoad.call(this);
  };
  // ──────────────────────────────────────────────────────────────────────────


  // ─── M3U8 DETECTED ────────────────────────────────────────────────────────
  function onM3u8(url) {
    if (takenOver) return;

    // Prefer master playlists — first detection wins unless we can upgrade to master
    const isMaster = !/(index|chunklist|seg|media_\d)/i.test(url.split('/').pop());
    if (!capturedM3u8 || isMaster) {
      capturedM3u8 = url;

      // Tell the parent frame immediately
      try {
        window.parent.postMessage({ type: 'sniper:url', url: capturedM3u8, host: location.hostname }, '*');
        window.top.postMessage({ type: 'sniper:url', url: capturedM3u8, host: location.hostname }, '*');
      } catch(e) {}

      // Schedule the takeover — give JWPlayer 800ms to fully establish the stream
      // then nuke everything so no ad timers can fire
      clearTimeout(takeoverTimer);
      takeoverTimer = setTimeout(() => takeover(capturedM3u8), 800);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── TAKEOVER — the nuclear option ────────────────────────────────────────
  // This runs INSIDE the embed iframe.
  // It kills JWPlayer, all ad timers, and replaces the page with a clean video.
  function takeover(m3u8url) {
    if (takenOver) return;
    takenOver = true;

    // 1. Kill ALL pending timeouts and intervals
    //    We create a high-numbered timer to find the current max ID, then clear all
    const maxTimerId = setTimeout(() => {}, 99999);
    for (let i = 0; i <= maxTimerId; i++) {
      clearTimeout(i);
      clearInterval(i);
    }

    // 2. Nuke JWPlayer specifically if present
    try {
      if (typeof jwplayer === 'function') {
        jwplayer().stop();
        jwplayer().remove();
      }
    } catch(e) {}

    // 3. Build the clean player HTML — minimal, no JS, no event handlers
    const videoHTML = `
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        html, body { width:100%; height:100%; background:#000; overflow:hidden; }
        video {
          width:100%;
          height:100%;
          object-fit:contain;
          display:block;
          background:#000;
        }
        #status {
          position:fixed;
          top:8px;
          left:50%;
          transform:translateX(-50%);
          background:rgba(0,255,136,0.15);
          color:#00ff88;
          font:11px monospace;
          padding:4px 10px;
          border-radius:4px;
          border:1px solid rgba(0,255,136,0.3);
          pointer-events:none;
          z-index:999;
          white-space:nowrap;
        }
      </style>
      <div id="status">▶ Clean stream — no ads</div>
      <video
        src="${m3u8url}"
        controls
        autoplay
        playsinline
        webkit-playsinline
        preload="auto"
      ></video>
    `;

    // 4. Replace the entire body
    //    This removes ALL existing DOM event listeners in one shot
    document.open();
    document.write('<!DOCTYPE html><html><head></head><body>' + videoHTML + '</body></html>');
    document.close();

    // 5. Wire up the video after takeover
    const video = document.querySelector('video');
    if (video) {
      video.addEventListener('error', (e) => {
        // If native HLS fails (e.g. needs auth headers), show fallback message
        const status = document.getElementById('status');
        if (status) {
          status.style.background = 'rgba(255,50,50,0.2)';
          status.style.color = '#ff6666';
          status.style.borderColor = 'rgba(255,50,50,0.3)';
          status.textContent = '⚠ Stream requires auth — use Copy URL button on main page';
        }
      });

      // iOS: enter native fullscreen
      video.addEventListener('loadedmetadata', () => {
        const status = document.getElementById('status');
        if (status) setTimeout(() => status.style.display = 'none', 3000);
      });
    }

    // 6. Hook any future timers to be no-ops (prevent re-injection of ad code)
    window.setTimeout  = (fn, delay, ...args) => 0;
    window.setInterval = (fn, delay, ...args) => 0;

    console.log('[SNIPER] Takeover complete. Stream:', m3u8url);
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── RESPOND TO PARENT REQUESTS ───────────────────────────────────────────
  window.addEventListener('message', e => {
    if (e.data === 'sniper:request_url' && capturedM3u8) {
      try {
        e.source.postMessage({ type: 'sniper:url', url: capturedM3u8, host: location.hostname }, '*');
      } catch(e) {}
    }
  });
  // ──────────────────────────────────────────────────────────────────────────

})();
