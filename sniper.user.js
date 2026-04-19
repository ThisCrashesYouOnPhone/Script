// ==UserScript==
// @name         Orion Stream Sniper
// @namespace    orion-stack
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function() {

  const SNIPE_HOSTS = [
    'pooembed.eu',
    'embedsports.top',
    'embedhd.org',
    'exposestrat.com',
  ];

  if (!SNIPE_HOSTS.some(h => location.hostname.includes(h))) return;

  // ─── STATE ────────────────────────────────────────────────────────────────
  let capturedM3u8  = null;
  let capturedRef   = document.referrer || location.href; // Referer to use
  let takenOver     = false;
  let takeoverTimer = null;
  // ──────────────────────────────────────────────────────────────────────────


  // ─── NETWORK LOGGER ───────────────────────────────────────────────────────
  const NET_KEY = 'orion_net_log';
  const t0_page = Date.now();
  const netLog  = [];

  function saveNetEntry(entry) {
    entry.ms_since_load = Date.now() - t0_page;
    entry.page = location.href;
    netLog.push(entry);
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

  window.__netSummary = async () => {
    const saved = JSON.parse(await GM_getValue(NET_KEY, '[]'));
    console.table(saved.map(e => ({ ms: e.ms_since_load, type: e.type, status: e.status, url: e.url?.slice(0, 80) })));
  };
  window.__copyNet = async () => {
    const saved = JSON.parse(await GM_getValue(NET_KEY, '[]'));
    await navigator.clipboard.writeText(JSON.stringify(saved, null, 2));
    console.log('Net log copied — ' + saved.length + ' entries');
  };
  window.__clearNet = () => GM_setValue(NET_KEY, '[]').then(() => console.log('cleared'));
  // ──────────────────────────────────────────────────────────────────────────


  // ─── NETWORK SNIFFERS ─────────────────────────────────────────────────────
  const origOpen      = XMLHttpRequest.prototype.open;
  const origSend      = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._sUrl    = String(url || '');
    this._sMethod = method;
    this._sT0     = Date.now();
    this._sHeaders = {};
    if (/\.m3u8/i.test(this._sUrl)) onM3u8(this._sUrl);
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, val) {
    if (this._sHeaders) this._sHeaders[name] = val;
    return origSetHeader.call(this, name, val);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const url = this._sUrl || '', t0 = this._sT0 || Date.now();
    this.addEventListener('loadend', () => {
      const entry = { type: 'xhr', method: this._sMethod, url, status: this.status, duration: Date.now() - t0, headers: this._sHeaders, flag: isNetInteresting(url) };
      if (/\.m3u8/i.test(url) && this.responseText) entry.m3u8_content = this.responseText.slice(0, 2000);
      saveNetEntry(entry);
    });
    return origSend.call(this, body);
  };

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const t0 = Date.now();
    if (/\.m3u8/i.test(url)) onM3u8(url);
    return origFetch.call(this, input, init).then(res => {
      const entry = { type: 'fetch', url, status: res.status, duration: Date.now() - t0, flag: isNetInteresting(url) };
      if (/\.m3u8/i.test(url)) {
        res.clone().text().then(text => { entry.m3u8_content = text.slice(0, 2000); saveNetEntry(entry); }).catch(() => saveNetEntry(entry));
      } else { saveNetEntry(entry); }
      return res;
    }).catch(err => { saveNetEntry({ type: 'fetch-error', url, error: String(err), duration: Date.now() - t0, flag: isNetInteresting(url) }); throw err; });
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
  // ──────────────────────────────────────────────────────────────────────────


  // ─── M3U8 DETECTED ────────────────────────────────────────────────────────
  function onM3u8(url) {
    if (takenOver) return;
    const isMaster = !/(index|chunklist|seg|media_\d)/i.test(url.split('/').pop());
    if (!capturedM3u8 || isMaster) {
      capturedM3u8 = url;
      try {
        window.parent.postMessage({ type: 'sniper:url', url, host: location.hostname, ref: location.href }, '*');
        window.top.postMessage({ type: 'sniper:url', url, host: location.hostname, ref: location.href }, '*');
      } catch(e) {}
      clearTimeout(takeoverTimer);
      takeoverTimer = setTimeout(() => takeover(capturedM3u8), 800);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── PROXY FETCH — the auth fix ───────────────────────────────────────────
  // The stream requires a Referer header. We fetch the m3u8 ourselves with
  // the correct Referer, rewrite all segment URLs to absolute paths,
  // then serve the modified playlist as a Blob URL to the video element.
  // The video element loads from blob: so CORS/Referer restrictions don't apply.
  async function fetchM3u8WithAuth(m3u8url, referer) {
    const res = await origFetch(m3u8url, {
      headers: {
        'Referer':        referer,
        'Origin':         new URL(referer).origin,
        'User-Agent':     navigator.userAgent,
      },
      mode: 'cors',
      credentials: 'include',
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);

    const text = await res.text();

    // Rewrite relative segment URLs to absolute so the video element can
    // fetch them directly (it will use the blob: origin, not our proxy)
    const base = m3u8url.substring(0, m3u8url.lastIndexOf('/') + 1);
    const rewritten = text.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      // Already absolute
      if (trimmed.startsWith('http')) return line;
      // Make absolute
      return base + trimmed;
    }).join('\n');

    const blob = new Blob([rewritten], { type: 'application/vnd.apple.mpegurl' });
    return URL.createObjectURL(blob);
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── SEAMLESS TAKEOVER ────────────────────────────────────────────────────
  async function takeover(m3u8url) {
    if (takenOver) return;
    takenOver = true;

    // Kill ALL pending timers
    const maxId = setTimeout(() => {}, 99999);
    for (let i = 0; i <= maxId; i++) { clearTimeout(i); clearInterval(i); }

    // Stop JWPlayer if present
    try { if (typeof jwplayer === 'function') { jwplayer().stop(); jwplayer().remove(); } } catch(e) {}

    // Find the original video container to match its dimensions
    const origVideo    = document.querySelector('video');
    const origContainer = origVideo?.parentElement || document.body;
    const containerRect = origContainer.getBoundingClientRect();

    // Fetch the playlist with auth headers, get a blob URL
    let playUrl = m3u8url;
    try {
      const ref = document.referrer || capturedRef || location.href;
      playUrl = await fetchM3u8WithAuth(m3u8url, ref);
    } catch(err) {
      console.warn('[SNIPER] Proxy fetch failed, trying direct:', err.message);
      // Fall through — try direct URL anyway, might still work
    }

    // Build a seamless replacement that matches the page's player container
    // We don't rewrite the whole page — we surgically replace the player element
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      position: absolute;
      inset: 0;
      background: #000;
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const video = document.createElement('video');
    video.src         = playUrl;
    video.controls    = true;
    video.autoplay    = true;
    video.playsInline = true;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('playsinline', '');
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';

    // Status badge — fades out once playing
    const badge = document.createElement('div');
    badge.textContent = '▶ Clean stream';
    badge.style.cssText = `
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,255,136,0.15);
      color: #00ff88;
      font: 11px monospace;
      padding: 3px 10px;
      border-radius: 4px;
      border: 1px solid rgba(0,255,136,0.3);
      pointer-events: none;
      z-index: 1;
      transition: opacity 0.5s;
    `;

    video.addEventListener('playing', () => {
      setTimeout(() => badge.style.opacity = '0', 2000);
    });

    video.addEventListener('error', async () => {
      // Blob URL failed — the segments still need auth headers
      // Try direct URL as fallback
      if (playUrl !== m3u8url) {
        console.warn('[SNIPER] Blob playback failed, trying direct URL');
        video.src = m3u8url;
        video.load();
        video.play().catch(() => {});
      } else {
        badge.style.background = 'rgba(255,80,80,0.2)';
        badge.style.color = '#ff6666';
        badge.style.borderColor = 'rgba(255,80,80,0.3)';
        badge.textContent = '⚠ Auth required — copy URL below';
        badge.style.opacity = '1';
      }
    });

    // Copy URL button — always available as fallback
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy stream URL';
    copyBtn.style.cssText = `
      position: absolute;
      bottom: 8px;
      right: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 6px;
      font: 14px sans-serif;
      cursor: pointer;
      z-index: 1;
      opacity: 0.4;
      transition: opacity 0.2s;
    `;
    copyBtn.addEventListener('mouseenter', () => copyBtn.style.opacity = '1');
    copyBtn.addEventListener('mouseleave', () => copyBtn.style.opacity = '0.4');
    copyBtn.addEventListener('touchstart', () => copyBtn.style.opacity = '1');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(m3u8url).then(() => {
        copyBtn.textContent = '✅';
        setTimeout(() => copyBtn.textContent = '📋', 2000);
      });
    });

    wrapper.appendChild(video);
    wrapper.appendChild(badge);
    wrapper.appendChild(copyBtn);

    // Replace the player container content
    // Make container relative so our absolute wrapper fills it
    if (origContainer !== document.body) {
      origContainer.style.position = 'relative';
      origContainer.style.overflow = 'hidden';
      origContainer.innerHTML = '';
      origContainer.appendChild(wrapper);
    } else {
      // Fallback: full page replacement
      document.body.innerHTML = '';
      document.body.style.cssText = 'margin:0;padding:0;background:#000;width:100%;height:100%;overflow:hidden';
      wrapper.style.position = 'fixed';
      document.body.appendChild(wrapper);
    }

    // Lock timers — prevent ad code re-injection
    window.setTimeout  = () => 0;
    window.setInterval = () => 0;

    console.log('[SNIPER] Takeover complete:', m3u8url);
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── PARENT COMMUNICATION ─────────────────────────────────────────────────
  window.addEventListener('message', e => {
    if (e.data === 'sniper:request_url' && capturedM3u8) {
      try { e.source.postMessage({ type: 'sniper:url', url: capturedM3u8, host: location.hostname, ref: location.href }, '*'); } catch(e) {}
    }
  });
  // ──────────────────────────────────────────────────────────────────────────

})();
