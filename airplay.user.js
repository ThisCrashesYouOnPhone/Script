// ==UserScript==
// @name         Universal AirPlay Enabler
// @description  Enables full AirPlay video (not just audio) on all websites.
//               Sniffs HLS/m3u8 URLs from MSE players, injects them as a
//               secondary source so WebKit can hand them to AirPlay, handles
//               the clone-reinsert trick for post-render attribute injection,
//               and overlays a dedicated AirPlay button on every video.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @version      1.3
// @updateURL    https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/script.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────

  // Stores every m3u8/mpd URL the page requests, keyed by hostname
  const sniffedURLs = new Map();

  // Tracks videos we've already processed so we don't double-handle
  const processedVideos = new WeakSet();

  // Keep track of observed roots (document and shadow roots) to avoid double-observing
  const observedRoots = new WeakSet();

  // Keep originals before we proxy them
  const _origCreateElement = document.createElement.bind(document);
  const _origFetch         = window.fetch ? window.fetch.bind(window) : null;
  const _origXHROpen       = XMLHttpRequest.prototype.open;
  const _origAttachShadow  = Element.prototype.attachShadow;
  const _origSetAttribute  = Element.prototype.setAttribute;
  const _origRemoveAttribute = Element.prototype.removeAttribute;

  // ─────────────────────────────────────────────────────────────────────────
  // MODULE 1 — NETWORK INTERCEPTOR
  // Proxy XHR + fetch at document-start to sniff .m3u8 / .mpd stream URLs
  // ─────────────────────────────────────────────────────────────────────────

  function isStreamURL(url) {
    if (!url) return false;
    try {
      const decoded = decodeURIComponent(url);
      const path = new URL(decoded, location.href).pathname;
      return /\.(m3u8|mpd)$/i.test(path) || /\.(m3u8|mpd)(?:\?|$)/i.test(decoded);
    } catch {
      return /\.(m3u8|mpd)(?:\?|$)/i.test(url);
    }
  }

  function storeStreamURL(url) {
    if (!isStreamURL(url)) return;
    const host = location.hostname;
    if (!sniffedURLs.has(host)) sniffedURLs.set(host, []);
    const list = sniffedURLs.get(host);
    if (!list.includes(url)) list.push(url);
    
    // Immediately try to inject HLS source into any processed MSE videos
    findAllVideos(document).forEach(tryInjectHLSSource);
  }

  // Proxy XMLHttpRequest
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (url) storeStreamURL(String(url));
    return _origXHROpen.call(this, method, url, ...rest);
  };

  // Proxy fetch
  if (_origFetch) {
    window.fetch = function (resource, ...args) {
      const url = resource instanceof Request ? resource.url : String(resource);
      storeStreamURL(url);
      return _origFetch(resource, ...args);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MODULE 2 — DOM CREATION & SHADOW DOM INTERCEPTORS
  // Hooks createElement, attachShadow, setAttribute, and removeAttribute.
  // ─────────────────────────────────────────────────────────────────────────

  document.createElement = function (tag, ...args) {
    const el = _origCreateElement(tag, ...args);
    if (typeof tag === 'string' && tag.toLowerCase() === 'video') {
      el.setAttribute('x-webkit-airplay', 'allow');
      el.setAttribute('airplay', 'allow');
    }
    return el;
  };

  // Intercept attachShadow so we can observe dynamic elements inside closed or open shadow roots
  if (_origAttachShadow) {
    Element.prototype.attachShadow = function (init) {
      const shadow = _origAttachShadow.call(this, init);
      if (shadow) {
        observeRoot(shadow);
        // Process any videos that might immediately be placed in the shadow root
        setTimeout(() => {
          findAllVideos(shadow).forEach(processVideo);
        }, 0);
      }
      return shadow;
    };
  }

  // Hook setAttribute on elements to block websites disabling AirPlay/RemotePlayback
  Element.prototype.setAttribute = function (name, value) {
    const tagName = this.tagName ? this.tagName.toLowerCase() : '';
    if (tagName === 'video') {
      const lowerName = name.toLowerCase();
      if (lowerName === 'disableremoteplayback' || lowerName === 'x-webkit-wireless-video-playback-disabled') {
        // Ignore attempts to disable remote playback or AirPlay video
        return;
      }
      if (lowerName === 'x-webkit-airplay' || lowerName === 'airplay') {
        // Websites might set airplay="deny". We force it to "allow"
        return _origSetAttribute.call(this, name, 'allow');
      }
    }
    return _origSetAttribute.call(this, name, value);
  };

  // Hook removeAttribute to block websites from deleting AirPlay-enabling attributes
  Element.prototype.removeAttribute = function (name) {
    const tagName = this.tagName ? this.tagName.toLowerCase() : '';
    if (tagName === 'video') {
      const lowerName = name.toLowerCase();
      if (lowerName === 'x-webkit-airplay' || lowerName === 'airplay') {
        // Prevent removal of AirPlay capabilities
        return;
      }
    }
    return _origRemoveAttribute.call(this, name);
  };

  // Helper to sweep and clean any pre-existing anti-AirPlay attributes on a video
  function cleanBlockedAttributes(video) {
    if (video.hasAttribute('disableremoteplayback')) {
      video.removeAttribute('disableremoteplayback');
    }
    if (video.hasAttribute('x-webkit-wireless-video-playback-disabled')) {
      video.removeAttribute('x-webkit-wireless-video-playback-disabled');
    }
    // Ensure AirPlay enabling attributes exist and are set to allow
    if (video.getAttribute('x-webkit-airplay') !== 'allow') {
      video.setAttribute('x-webkit-airplay', 'allow');
    }
    if (video.getAttribute('airplay') !== 'allow') {
      video.setAttribute('airplay', 'allow');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MODULE 3 — HLS SOURCE INJECTION (fixes MSE / audio-only problem)
  // ─────────────────────────────────────────────────────────────────────────

  function getBestSniffedURL() {
    const list = sniffedURLs.get(location.hostname);
    if (!list || list.length === 0) return null;
    // Prefer master/playlist files over segments
    const preferred = list.find(u =>
      /master|playlist|index/i.test(u) && !u.includes('/seg') && !u.includes('.ts')
    );
    return preferred || list[list.length - 1];
  }

  function isMSEVideo(video) {
    return (video.src && video.src.startsWith('blob:')) ||
           (video.srcObject && typeof MediaSource !== 'undefined' && video.srcObject instanceof MediaSource);
  }

  function tryInjectHLSSource(video) {
    if (!isMSEVideo(video)) return false;
    const streamURL = getBestSniffedURL();
    if (!streamURL) return false;

    const existing = video.querySelector('source[data-ap-injected]');
    if (existing) {
      if (existing.src !== streamURL) {
        existing.src = streamURL;
        // Reload source if changed
        if (typeof video.load === 'function') video.load();
      }
      return true;
    }

    const source = _origCreateElement('source');
    source.setAttribute('type', 'application/x-mpegURL');
    source.setAttribute('src', streamURL);
    source.setAttribute('data-ap-injected', 'true');
    video.appendChild(source);
    
    // Force the element to load the new source list
    if (typeof video.load === 'function') video.load();
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MODULE 4 — CLONE + REINSERT (fixes post-render attribute problem)
  // ─────────────────────────────────────────────────────────────────────────

  function cloneAndReinsert(video) {
    if (!video.parentNode) return video;

    const currentTime = video.currentTime;
    const wasPaused   = video.paused;
    const muted       = video.muted;
    const volume      = video.volume;
    const playbackRate = video.playbackRate;

    const clone = video.cloneNode(true);
    // Guarantee attributes are correct on clone
    clone.setAttribute('x-webkit-airplay', 'allow');
    clone.setAttribute('airplay', 'allow');
    if (clone.hasAttribute('disableremoteplayback')) clone.removeAttribute('disableremoteplayback');
    if (clone.hasAttribute('x-webkit-wireless-video-playback-disabled')) clone.removeAttribute('x-webkit-wireless-video-playback-disabled');

    video.parentNode.replaceChild(clone, video);

    clone.currentTime  = currentTime;
    clone.muted        = muted;
    clone.volume       = volume;
    clone.playbackRate = playbackRate;
    if (!wasPaused) {
      clone.play().catch(() => {});
    }

    return clone;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MODULE 5 — AIRPLAY BUTTON OVERLAY (Premium Glassmorphism Style)
  // ─────────────────────────────────────────────────────────────────────────

  function injectAirPlayButton(video) {
    if (typeof video.webkitShowPlaybackTargetPicker !== 'function') return;

    const wrapper = video.parentNode;
    if (!wrapper) return;
    if (wrapper.querySelector('.ap-btn-injected')) return;

    // Position wrapper if static so absolute works
    const wrapStyle = window.getComputedStyle(wrapper).position;
    if (wrapStyle === 'static') wrapper.style.position = 'relative';

    const btn = _origCreateElement('button');
    btn.className = 'ap-btn-injected';
    btn.title     = 'AirPlay video';
    btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
           stroke-linejoin="round">
        <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/>
        <polygon points="12 15 17 21 7 21 12 15"/>
      </svg>
    `;
    
    // Premium round glassmorphic design with active scaling transition
    btn.style.cssText = `
      position: absolute;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      width: 38px;
      height: 38px;
      background: rgba(18, 18, 18, 0.65);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 50%;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      line-height: 0;
      outline: none;
      pointer-events: auto !important;
    `;

    // Visual feedback micro-animations
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.08)';
      btn.style.background = 'rgba(30, 30, 30, 0.8)';
      btn.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.background = 'rgba(18, 18, 18, 0.65)';
      btn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    });
    btn.addEventListener('mousedown', () => {
      btn.style.transform = 'scale(0.95)';
    });
    btn.addEventListener('mouseup', () => {
      btn.style.transform = 'scale(1.08)';
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      video.webkitShowPlaybackTargetPicker();
    });

    const show = () => (btn.style.display = 'flex');
    const hide = () => (btn.style.display = 'none');

    video.addEventListener('mouseenter', show);
    video.addEventListener('mouseleave', hide);
    video.addEventListener('touchstart', () => {
      show();
      setTimeout(hide, 3500);
    }, { passive: true });

    video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      if (e.availability === 'available') {
        show();
      } else {
        hide();
      }
    });

    wrapper.appendChild(btn);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MODULE 6 — DYNAMIC PROPERTY DESCRIPTOR HIJACKING
  // Detects src or srcObject reassignment (important for playlist sites) AND
  // forces disableRemotePlayback/webkitWirelessVideoPlaybackDisabled to false.
  // ─────────────────────────────────────────────────────────────────────────

  function hijackProperty(proto, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (!descriptor) return;
    const originalSet = descriptor.set;
    if (typeof originalSet !== 'function') return;

    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: true,
      get: descriptor.get,
      set: function (val) {
        originalSet.call(this, val);
        const video = this;
        setTimeout(() => {
          if (video && isMSEVideo(video)) {
            tryInjectHLSSource(video);
          }
        }, 100);
      }
    });
  }

  function forcePropertyFalse(proto, prop) {
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: true,
      get: function () {
        return false;
      },
      set: function (val) {
        // Ignore attempts by the site to set this to true
      }
    });
  }

  // Hijack src and srcObject property descriptors on HTMLMediaElement prototype
  try {
    hijackProperty(HTMLMediaElement.prototype, 'src');
    hijackProperty(HTMLMediaElement.prototype, 'srcObject');
    
    // Lock down properties used by players to restrict/disable AirPlay video
    forcePropertyFalse(HTMLMediaElement.prototype, 'disableRemotePlayback');
    forcePropertyFalse(HTMLMediaElement.prototype, 'webkitWirelessVideoPlaybackDisabled');
  } catch (e) {
    console.error('Failed to hijack MediaElement source descriptors:', e);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RECURSIVE DOM & SHADOW DOM WALKERS
  // ─────────────────────────────────────────────────────────────────────────

  function findAllVideos(root) {
    const list = [];
    if (!root) return list;

    // Statically query standard DOM elements
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('video').forEach(v => list.push(v));
    }

    // Traverse recursively to find shadowRoots
    const walker = document.createTreeWalker(
      root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root : (root.shadowRoot || root),
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );

    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) {
        findAllVideos(node.shadowRoot).forEach(v => list.push(v));
      }
      node = walker.nextNode();
    }
    return list;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN PROCESSOR
  // ─────────────────────────────────────────────────────────────────────────

  function processVideo(video) {
    if (processedVideos.has(video)) return;
    processedVideos.add(video);

    // Strip static blockages and enforce correct airplay attributes
    cleanBlockedAttributes(video);

    if (isMSEVideo(video)) {
      // MSE Path
      if (!tryInjectHLSSource(video)) {
        setTimeout(() => tryInjectHLSSource(video), 800);
        setTimeout(() => tryInjectHLSSource(video), 2500);
        setTimeout(() => tryInjectHLSSource(video), 5000);
      }
    } else {
      // Plain Video Path
      const currentAttr = video.getAttribute('x-webkit-airplay');
      if (currentAttr === 'allow') {
        // Already allowed
      } else if (video.isConnected && video.readyState > 0) {
        // Active in DOM - needs clone and reinsert trick
        const newVideo = cloneAndReinsert(video);
        processedVideos.add(newVideo);
        injectAirPlayButton(newVideo);
        return;
      } else {
        video.setAttribute('x-webkit-airplay', 'allow');
        video.setAttribute('airplay', 'allow');
      }
    }

    injectAirPlayButton(video);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MUTATION OBSERVERS FOR ROOT ELEMENTS
  // ─────────────────────────────────────────────────────────────────────────

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.tagName === 'VIDEO') {
              processVideo(node);
            } else {
              findAllVideos(node).forEach(processVideo);
            }
          }
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
              // Website dynamically changed anti-AirPlay attributes, clean them!
              cleanBlockedAttributes(target);
            }
          }
        }
      }
    });

    observer.observe(root, {
      childList: true,
      subtree:   true,
      attributes: true,
      attributeFilter: ['src', 'disableremoteplayback', 'x-webkit-wireless-video-playback-disabled', 'x-webkit-airplay', 'airplay']
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────

  function init() {
    // Observe main document
    observeRoot(document.documentElement);

    // Initial scan
    findAllVideos(document).forEach(processVideo);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();