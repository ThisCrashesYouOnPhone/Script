// ==UserScript==
// @name         Universal AirPlay Enabler
// @description  Enables full AirPlay video (not just audio) on all websites.
//               Sniffs HLS/m3u8 URLs from MSE players, then performs a full
//               Native Player Swap: replaces the site's custom player iframe
//               with a top-level native <video> element so WebKit's AirPlay
//               works fully (video + audio) rather than audio-only.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/ThisCrashesYouOnPhone/Script/main/script.user.js
// ==/UserScript==

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // STATE
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // MODULE 1 - NETWORK INTERCEPTOR
  // Proxy XHR + fetch at document-start to sniff .m3u8 / .mpd stream URLs
  // -------------------------------------------------------------------------

  function isStreamURL(url) {
    if (!url) return false;
    try {
      const decoded = decodeURIComponent(url);
      
      // Aggressive segment filtering to prevent polluting sniffedURLs with chunk paths
      if (/(seg|chunk|ts|m4s|key|license|drm)/i.test(decoded)) return false;
      
      const path = new URL(decoded, location.href).pathname;
      return /\.(m3u8|mpd)$/i.test(path) || /\.(m3u8|mpd)(?:\?|$)/i.test(decoded);
    } catch (e) {
      return /\.(m3u8|mpd)(?:\?|$)/i.test(url);
    }
  }

  function storeStreamURL(url) {
    if (!isStreamURL(url)) return;
    const host = location.hostname;
    if (!sniffedURLs.has(host)) sniffedURLs.set(host, []);
    const list = sniffedURLs.get(host);
    if (!list.includes(url)) list.push(url);

    // Broadcast across frames via postMessage to mesh all iframe sniffers together
    try {
      const msg = { type: 'ap-sniffed-url', url: url };
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
      }
      if (window.top && window.top !== window) {
        window.top.postMessage(msg, '*');
      }
      for (let i = 0; i < window.frames.length; i++) {
        window.frames[i].postMessage(msg, '*');
      }
    } catch (e) {}
    
    // Immediately try to inject HLS source into any processed MSE videos
    findAllVideos(document).forEach(tryInjectHLSSource);

    // If we are the top-level parent window, perform the native player swap
    if (window === window.top) {
      performNativePlayerSwap(url);
    }
  }

  // Proxy XMLHttpRequest - ES5 compliant apply logic
  XMLHttpRequest.prototype.open = function () {
    if (arguments[1]) storeStreamURL(String(arguments[1]));
    return _origXHROpen.apply(this, arguments);
  };

  // Proxy fetch - ES5 compliant apply logic
  if (_origFetch) {
    window.fetch = function () {
      const resource = arguments[0];
      const url = resource instanceof Request ? resource.url : String(resource);
      storeStreamURL(url);
      return _origFetch.apply(this, arguments);
    };
  }

  // -------------------------------------------------------------------------
  // MODULE 2 - DOM CREATION & SHADOW DOM INTERCEPTORS
  // Hooks createElement, attachShadow, setAttribute, and removeAttribute.
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

  // Intercept attachShadow so we can observe dynamic elements inside closed or open shadow roots
  if (_origAttachShadow) {
    Element.prototype.attachShadow = function (init) {
      const shadow = _origAttachShadow.call(this, init);
      if (shadow) {
        observeRoot(shadow);
        // Process any videos that might immediately be placed in the shadow root
        setTimeout(function () {
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

  // -------------------------------------------------------------------------
  // MODULE 3 - HLS SOURCE INJECTION (fixes MSE / audio-only problem)
  // -------------------------------------------------------------------------

  function getBestSniffedURL() {
    const list = sniffedURLs.get(location.hostname);
    if (!list || list.length === 0) return null;
    
    // Strictly prefer master/playlist files over segments and mpd if both sniffed
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
    if (video.id === 'ap-mirror-video') return false; // Skip mirror video
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

  // -------------------------------------------------------------------------
  // MODULE 4 - CLONE + REINSERT (fixes post-render attribute problem)
  // -------------------------------------------------------------------------

  function cloneAndReinsert(video) {
    if (!video.parentNode) return video;

    const currentTime = video.currentTime;
    const wasPaused   = video.paused;
    const muted       = video.muted;
    const volume      = video.volume;
    const playbackRate = video.playbackRate;

    const clone = video.cloneNode(true);
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
      clone.play().catch(function () {});
    }

    return clone;
  }

  // -------------------------------------------------------------------------
  // MODULE 5 - AIRPLAY BUTTON OVERLAY (Premium Glassmorphism Style)
  // -------------------------------------------------------------------------

  function injectAirPlayButton(video) {
    if (typeof video.webkitShowPlaybackTargetPicker !== 'function') return;
    if (video.id === 'ap-mirror-video') return; // Skip mirror video

    const wrapper = video.parentNode;
    if (!wrapper) return;
    if (wrapper.querySelector('.ap-btn-injected')) return;

    const wrapStyle = window.getComputedStyle(wrapper).position;
    if (wrapStyle === 'static') wrapper.style.position = 'relative';

    const btn = _origCreateElement('button');
    btn.className = 'ap-btn-injected';
    btn.title     = 'AirPlay video';
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/><polygon points="12 15 17 21 7 21 12 15"/></svg>';
    
    btn.style.cssText = 'position: absolute; bottom: 16px; right: 16px; z-index: 2147483647; width: 38px; height: 38px; background: rgba(18, 18, 18, 0.65); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 50%; cursor: pointer; display: none; align-items: center; justify-content: center; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); line-height: 0; outline: none; pointer-events: auto !important;';

    btn.addEventListener('mouseenter', function () {
      btn.style.transform = 'scale(1.08)';
      btn.style.background = 'rgba(30, 30, 30, 0.8)';
      btn.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.transform = 'scale(1)';
      btn.style.background = 'rgba(18, 18, 18, 0.65)';
      btn.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    });
    btn.addEventListener('mousedown', function () {
      btn.style.transform = 'scale(0.95)';
    });
    btn.addEventListener('mouseup', function () {
      btn.style.transform = 'scale(1.08)';
    });

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      video.webkitShowPlaybackTargetPicker();
    });

    const show = function () { btn.style.display = 'flex'; };
    const hide = function () { btn.style.display = 'none'; };

    video.addEventListener('mouseenter', show);
    video.addEventListener('mouseleave', hide);
    video.addEventListener('touchstart', function () {
      show();
      setTimeout(hide, 3500);
    }, { passive: true });

    video.addEventListener('webkitplaybacktargetavailabilitychanged', function (e) {
      if (e.availability === 'available') {
        show();
      } else {
        hide();
      }
    });

    wrapper.appendChild(btn);
  }

  // -------------------------------------------------------------------------
  // MODULE 6 - DYNAMIC PROPERTY DESCRIPTOR HIJACKING & TOP-LEVEL MIRRORING
  // -------------------------------------------------------------------------

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
        setTimeout(function () {
          if (video && isMSEVideo(video)) {
            tryInjectHLSSource(video);
          }
        }, 100);
      }
    });
  }

  // Forces properties to always be false to neutralize video blocker overlays
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

  try {
    hijackProperty(HTMLMediaElement.prototype, 'src');
    hijackProperty(HTMLMediaElement.prototype, 'srcObject');
    forcePropertyFalse(HTMLMediaElement.prototype, 'disableRemotePlayback');
    forcePropertyFalse(HTMLMediaElement.prototype, 'webkitWirelessVideoPlaybackDisabled');
  } catch (e) {
    console.error('Failed to hijack MediaElement source descriptors:', e);
  }

  // -------------------------------------------------------------------------
  // 7. CROSS-FRAME MESSAGE LISTENER & NATIVE PLAYER SWAP
  //
  // When a stream URL is sniffed (either in the top frame or relayed from
  // a child iframe), we perform a "Native Player Swap":
  //   1. Find the player container or iframe in the top-level DOM
  //   2. Record its dimensions + position so we can replace it perfectly
  //   3. Destroy the iframe / custom player element
  //   4. Insert a fully-visible native <video> element with AirPlay enabled
  //
  // This gives WebKit a top-level, same-origin <video> element it can hand
  // off to AirPlay with full video+audio — no more audio-only casting.
  // -------------------------------------------------------------------------

  // Guard: only swap once per page load
  var _swapDone = false;

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ap-sniffed-url' && e.data.url) {
      var url = e.data.url;
      var host = location.hostname;
      if (!sniffedURLs.has(host)) sniffedURLs.set(host, []);
      var list = sniffedURLs.get(host);
      if (!list.includes(url)) {
        list.push(url);
      }
      if (window === window.top) {
        performNativePlayerSwap(url);
      } else {
        findAllVideos(document).forEach(tryInjectHLSSource);
      }
    }
  });

  // Also trigger swap when we sniff a URL in the top frame directly
  var _origStoreStreamURL = storeStreamURL;
  function storeStreamURLAndMaybeSwap(url) {
    _origStoreStreamURL(url);
    if (window === window.top && isStreamURL(url)) {
      performNativePlayerSwap(url);
    }
  }

  function findPlayerTarget() {
    // Prioritize known player containers
    var selectors = [
      'iframe[src*="embed"]',
      'iframe[src*="player"]',
      'iframe[src*="video"]',
      '#player-container iframe',
      '.player-container iframe',
      '.video-player iframe',
      '#player iframe',
      'iframe'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    // Fallback: find an MSE blob video
    var allVideos = findAllVideos(document);
    for (var j = 0; j < allVideos.length; j++) {
      if (isMSEVideo(allVideos[j]) && allVideos[j].id !== 'ap-native-video') {
        return allVideos[j];
      }
    }
    return null;
  }

  function performNativePlayerSwap(streamURL) {
    if (_swapDone) {
      // Already swapped — just update the src if URL changed
      var existing = document.getElementById('ap-native-video');
      if (existing && existing.src !== streamURL) {
        existing.src = streamURL;
        if (typeof existing.load === 'function') existing.load();
        existing.play().catch(function () {});
      }
      return;
    }

    var target = findPlayerTarget();
    if (!target) {
      // No player found yet — wait and retry
      setTimeout(function () { performNativePlayerSwap(streamURL); }, 500);
      return;
    }

    _swapDone = true;

    // Capture dimensions from the target element or its container
    var container = target.parentNode;
    if (!container) return;

    var rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    var width  = target.offsetWidth  || (rect && rect.width)  || 640;
    var height = target.offsetHeight || (rect && rect.height) || 360;

    // Remember playback time if it's a video (not an iframe)
    var savedTime = 0;
    if (target.tagName === 'VIDEO' && !isNaN(target.currentTime)) {
      savedTime = target.currentTime;
    }

    // Build native video element
    var nativeVideo = _origCreateElement('video');
    nativeVideo.id            = 'ap-native-video';
    nativeVideo.controls      = true;
    nativeVideo.autoplay      = true;
    nativeVideo.playsInline   = true;
    nativeVideo.src           = streamURL;
    nativeVideo.currentTime   = savedTime;
    nativeVideo.style.cssText = [
      'display: block',
      'width: ' + (width  ? width  + 'px' : '100%'),
      'height: ' + (height ? height + 'px' : '100%'),
      'max-width: 100%',
      'background: #000',
      'border-radius: inherit',
      'outline: none'
    ].join(';');

    _origSetAttribute.call(nativeVideo, 'x-webkit-airplay', 'allow');
    _origSetAttribute.call(nativeVideo, 'airplay', 'allow');
    _origSetAttribute.call(nativeVideo, 'webkit-playsinline', '');
    _origSetAttribute.call(nativeVideo, 'playsinline', '');

    // Swap: replace the target element with our native video
    try {
      container.replaceChild(nativeVideo, target);
    } catch (replaceErr) {
      // Fallback: append after
      target.style.display = 'none';
      container.appendChild(nativeVideo);
    }

    nativeVideo.play().catch(function () {});

    // Inject AirPlay button onto the native video
    processedVideos.delete(nativeVideo); // ensure it gets processed fresh
    processVideo(nativeVideo);

    console.log('[AirPlay Enabler] Native player swap complete. Stream:', streamURL);
  }

  // -------------------------------------------------------------------------
  // RECURSIVE DOM & SHADOW DOM WALKERS
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

  // -------------------------------------------------------------------------
  // MAIN PROCESSOR
  // -------------------------------------------------------------------------

  function processVideo(video) {
    if (video.id === 'ap-mirror-video') return; // Skip mirror video
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
      const currentAttr = video.getAttribute('x-webkit-airplay');
      if (currentAttr === 'allow') {
        // Already allowed
      } else if (video.isConnected && video.readyState > 0) {
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

  // -------------------------------------------------------------------------
  // MUTATION OBSERVERS FOR ROOT ELEMENTS
  // -------------------------------------------------------------------------

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    const observer = new MutationObserver(function (mutations) {
      for (let mIdx = 0; mIdx < mutations.length; mIdx++) {
        const mutation = mutations[mIdx];
        if (mutation.type === 'childList') {
          for (let nIdx = 0; nIdx < mutation.addedNodes.length; nIdx++) {
            const node = mutation.addedNodes[nIdx];
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

  // -------------------------------------------------------------------------
  // INIT
  // -------------------------------------------------------------------------

  function init() {
    observeRoot(document.documentElement);
    findAllVideos(document).forEach(processVideo);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();