// ==UserScript==
// @name         Orion Stream Sniper
// @namespace    orion-stack
// @description  Sniffs the raw HLS m3u8 URL from embed players and offers a clean native player
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function() {

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  // Hosts where we want to sniff and replace the player
  const SNIPE_HOSTS = [
    'pooembed.eu',
    'embedsports.top',
    'embedhd.org',
    'exposestrat.com',
  ];

  const onSnipeHost = SNIPE_HOSTS.some(h => location.hostname.includes(h));
  if (!onSnipeHost) return; // Only run on embed hosts
  // ──────────────────────────────────────────────────────────────────────────


  // ─── STATE ────────────────────────────────────────────────────────────────
  let capturedM3u8   = null;  // The raw stream URL
  let capturedM3u8s  = [];    // All sniffed URLs (some pages have multiple qualities)
  let playerInjected = false;
  // ──────────────────────────────────────────────────────────────────────────


  // ─── NETWORK SNIFFERS ─────────────────────────────────────────────────────
  // Hook XMLHttpRequest — JWPlayer uses XHR to fetch the m3u8 playlist
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.match(/\.m3u8/i)) {
      onM3u8Detected(url);
    }
    return origOpen.apply(this, arguments);
  };

  // Hook fetch — some players use fetch instead of XHR
  const origFetch = window.fetch;
  window.fetch = function(url, ...args) {
    const urlStr = typeof url === 'string' ? url : (url?.url || '');
    if (urlStr.match(/\.m3u8/i)) {
      onM3u8Detected(urlStr);
    }
    return origFetch.apply(this, arguments);
  };

  // Hook the src setter on HTMLVideoElement — catches when JWPlayer sets src directly
  const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
  if (origSrcDesc?.set) {
    Object.defineProperty(HTMLVideoElement.prototype, 'src', {
      set(val) {
        if (typeof val === 'string' && val.match(/\.m3u8/i)) {
          onM3u8Detected(val);
        }
        return origSrcDesc.set.call(this, val);
      },
      get: origSrcDesc.get,
      configurable: true
    });
  }

  // Also hook MediaSource and the source element for completeness
  const origSrcElDesc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
  if (origSrcElDesc?.set) {
    Object.defineProperty(HTMLSourceElement.prototype, 'src', {
      set(val) {
        if (typeof val === 'string' && val.match(/\.m3u8/i)) {
          onM3u8Detected(val);
        }
        return origSrcElDesc.set.call(this, val);
      },
      get: origSrcElDesc.get,
      configurable: true
    });
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── M3U8 DETECTION HANDLER ───────────────────────────────────────────────
  function onM3u8Detected(url) {
    // Ignore segment playlists (sub-playlists) — we want the master
    // Master playlists typically don't have 'index' or segment patterns
    const isMaster = !url.match(/\/index\.m3u8|\/chunklist|\/media_\d|\/seg\d/i);
    const isNew    = !capturedM3u8s.includes(url);

    if (isNew) {
      capturedM3u8s.push(url);
      console.log('[SNIPER] m3u8 detected:', url, isMaster ? '(master)' : '(segment)');
    }

    // Prefer master playlists — they contain quality variants
    if (!capturedM3u8 || isMaster) {
      capturedM3u8 = url;
      // Update the UI button if it's already showing
      updateSniperButton();
    }
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── NATIVE PLAYER INJECTION ──────────────────────────────────────────────
  function injectNativePlayer(m3u8url) {
    if (playerInjected) return;
    playerInjected = true;

    // Create a fullscreen overlay with a native <video> element
    // iOS WebKit natively supports HLS (.m3u8) — no library needed
    const overlay = document.createElement('div');
    overlay.id = 'sniper-player-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: #000;
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    `;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Close';
    closeBtn.style.cssText = `
      position: absolute;
      top: 12px;
      left: 12px;
      background: rgba(255,255,255,0.15);
      color: #fff;
      border: none;
      padding: 8px 16px;
      font: 14px monospace;
      border-radius: 6px;
      cursor: pointer;
      z-index: 1;
    `;
    closeBtn.addEventListener('click', () => {
      overlay.remove();
      playerInjected = false;
    });

    // Quality selector (if we have multiple m3u8s)
    let qualitySelector = null;
    if (capturedM3u8s.length > 1) {
      qualitySelector = document.createElement('select');
      qualitySelector.style.cssText = `
        position: absolute;
        top: 12px;
        right: 12px;
        background: rgba(255,255,255,0.15);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.3);
        padding: 6px 10px;
        font: 13px monospace;
        border-radius: 6px;
        z-index: 1;
      `;
      capturedM3u8s.forEach((url, i) => {
        const opt = document.createElement('option');
        opt.value = url;
        const label = url.split('/').pop() || 'Stream ' + (i + 1);
        opt.textContent = label;
        if (url === m3u8url) opt.selected = true;
        qualitySelector.appendChild(opt);
      });
    }

    // The video element — this is the clean player
    const video = document.createElement('video');
    video.src             = m3u8url;
    video.controls        = true;
    video.autoplay        = true;
    video.playsInline     = true;   // Crucial for iOS — prevents forced fullscreen
    video.style.cssText   = `
      width: 100%;
      height: 100%;
      object-fit: contain;
    `;

    // Stream URL display + copy button
    const urlBar = document.createElement('div');
    urlBar.style.cssText = `
      position: absolute;
      bottom: 12px;
      left: 12px;
      right: 12px;
      display: flex;
      gap: 8px;
      align-items: center;
    `;
    const urlDisplay = document.createElement('span');
    urlDisplay.style.cssText = `
      color: rgba(255,255,255,0.5);
      font: 10px monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    `;
    urlDisplay.textContent = m3u8url;

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Copy URL';
    copyBtn.style.cssText = closeBtn.style.cssText + 'position:static;';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(m3u8url).then(() => {
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => copyBtn.textContent = '📋 Copy URL', 2000);
      });
    });

    urlBar.append(urlDisplay, copyBtn);

    overlay.appendChild(closeBtn);
    if (qualitySelector) {
      overlay.appendChild(qualitySelector);
      qualitySelector.addEventListener('change', e => {
        video.src = e.target.value;
        urlDisplay.textContent = e.target.value;
        video.play();
      });
    }
    overlay.appendChild(video);
    overlay.appendChild(urlBar);

    document.body.appendChild(overlay);

    // iOS: request native fullscreen
    setTimeout(() => {
      if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    }, 500);
  }
  // ──────────────────────────────────────────────────────────────────────────


  // ─── FLOATING SNIPER BUTTON ───────────────────────────────────────────────
  // Only on top frame — the embed pages are iframes inside streamed.pk
  // But we still want the button on the embed page itself if opened directly
  let sniperBtn = null;

  function createSniperButton() {
    if (sniperBtn) return;

    sniperBtn = document.createElement('button');
    sniperBtn.id = 'sniper-btn';
    sniperBtn.textContent = '🎯 Waiting for stream...';
    sniperBtn.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #111;
      color: #888;
      border: 1px solid #444;
      padding: 10px 20px;
      font: 14px monospace;
      border-radius: 8px;
      cursor: default;
      white-space: nowrap;
      transition: all 0.2s;
      pointer-events: none;
    `;

    document.body.appendChild(sniperBtn);
  }

  function updateSniperButton() {
    if (!sniperBtn) return;

    if (capturedM3u8) {
      const short = capturedM3u8.split('/').slice(-2).join('/');
      sniperBtn.textContent = '▶ Play Clean: ' + short;
      sniperBtn.style.background = '#0a2a0a';
      sniperBtn.style.color = '#00ff88';
      sniperBtn.style.borderColor = '#00ff88';
      sniperBtn.style.cursor = 'pointer';
      sniperBtn.style.pointerEvents = 'auto';
      sniperBtn.onclick = () => injectNativePlayer(capturedM3u8);
    }
  }

  // Create the button once the DOM is ready
  window.addEventListener('DOMContentLoaded', createSniperButton);
  window.addEventListener('load', () => {
    if (!sniperBtn) createSniperButton();
    updateSniperButton();
  });

  // Also expose to parent frame via postMessage so streamed.pk can show a button too
  window.addEventListener('message', e => {
    if (e.data === 'sniper:request_url' && capturedM3u8) {
      e.source.postMessage({ type: 'sniper:url', url: capturedM3u8 }, '*');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────

  console.log('[SNIPER] Stream Sniper active on', location.hostname);

})();
