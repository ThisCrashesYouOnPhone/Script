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
// @version      1.0
// ==/UserScript==

(function () {
‘use strict’;

// ─────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────

// Stores every m3u8/mpd URL the page requests, keyed by hostname
const sniffedURLs = new Map();

// Tracks videos we’ve already processed so we don’t double-handle
const processedVideos = new WeakSet();

// Keep originals before we proxy them
const _origCreateElement = document.createElement.bind(document);
const _origFetch         = window.fetch ? window.fetch.bind(window) : null;
const _origXHROpen       = XMLHttpRequest.prototype.open;

// ─────────────────────────────────────────────────────────────────────────
// MODULE 1 — NETWORK INTERCEPTOR
// Proxy XHR + fetch at document-start to sniff .m3u8 / .mpd stream URLs
// before the page’s own JS has a chance to load them.
// This is the Streamlink approach: find the real stream URL underneath
// the player’s MSE layer.
// ─────────────────────────────────────────────────────────────────────────

function isStreamURL(url) {
if (!url) return false;
try {
const path = new URL(url, location.href).pathname;
return /.(m3u8|mpd)$/i.test(path);
} catch {
return /.(m3u8|mpd)(?|$)/i.test(url);
}
}

function storeStreamURL(url) {
if (!isStreamURL(url)) return;
const host = location.hostname;
if (!sniffedURLs.has(host)) sniffedURLs.set(host, []);
const list = sniffedURLs.get(host);
if (!list.includes(url)) list.push(url);
// Immediately try to inject into any already-processed MSE video
document.querySelectorAll(‘video’).forEach(tryInjectHLSSource);
}

// Proxy XMLHttpRequest
XMLHttpRequest.prototype.open = function (method, url, …rest) {
if (url) storeStreamURL(String(url));
return _origXHROpen.call(this, method, url, …rest);
};

// Proxy fetch
if (_origFetch) {
window.fetch = function (resource, …args) {
const url = resource instanceof Request ? resource.url : String(resource);
storeStreamURL(url);
return _origFetch(resource, …args);
};
}

// ─────────────────────────────────────────────────────────────────────────
// MODULE 2 — createElement OVERRIDE
// Set x-webkit-airplay=“allow” at the moment a <video> element is born,
// before it ever touches the DOM. This avoids the clone-reinsert entirely
// for videos created after our script runs.
// ─────────────────────────────────────────────────────────────────────────

document.createElement = function (tag, …args) {
const el = _origCreateElement(tag, …args);
if (typeof tag === ‘string’ && tag.toLowerCase() === ‘video’) {
el.setAttribute(‘x-webkit-airplay’, ‘allow’);
el.setAttribute(‘airplay’, ‘allow’);
}
return el;
};

// ─────────────────────────────────────────────────────────────────────────
// MODULE 3 — HLS SOURCE INJECTION (fixes MSE / audio-only problem)
//
// Root cause: MSE plays video from a blob: URL. AirPlay can’t use that —
// it needs a real HTTP URL. Audio still works because it decodes separately,
// which is why you get audio-only AirPlay from MSE sites.
//
// Fix: WebKit will show the AirPlay button and stream video IF a real
// m3u8 <source> exists alongside the blob. When AirPlay is selected,
// WebKit switches to the m3u8 and sends it over AirPlay properly.
// (See: https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/)
// ─────────────────────────────────────────────────────────────────────────

function getBestSniffedURL() {
const list = sniffedURLs.get(location.hostname);
if (!list || list.length === 0) return null;
// Prefer master/playlist files over segment files
const preferred = list.find(u =>
/master|playlist|index/i.test(u) && !u.includes(’/seg’) && !u.includes(’.ts’)
);
return preferred || list[list.length - 1];
}

function isMSEVideo(video) {
// MSE videos have a blob: src OR no src with a MediaSource srcObject
return (video.src && video.src.startsWith(‘blob:’)) ||
(video.srcObject && video.srcObject instanceof MediaSource);
}

function tryInjectHLSSource(video) {
if (!isMSEVideo(video)) return false;
const streamURL = getBestSniffedURL();
if (!streamURL) return false;

```
// Check if we already injected one
const existing = video.querySelector('source[data-ap-injected]');
if (existing) {
  // Update URL if it changed (live stream token rotation etc.)
  if (existing.src !== streamURL) existing.src = streamURL;
  return true;
}

const source = _origCreateElement('source');
source.setAttribute('type', 'application/x-mpegURL');
source.setAttribute('src', streamURL);
source.setAttribute('data-ap-injected', 'true');
// Append AFTER the blob source — WebKit uses the first playable source
// for local playback and the m3u8 source for AirPlay
video.appendChild(source);
return true;
```

}

// ─────────────────────────────────────────────────────────────────────────
// MODULE 4 — CLONE + REINSERT (fixes post-render attribute problem)
//
// Root cause: if x-webkit-airplay is set on a <video> AFTER it’s already
// been added to the DOM and started loading, WebKit ignores it for video
// streaming — you still get audio-only. Setting the attribute only takes
// full effect at parse/load time.
//
// Fix: clone the element (with the attribute already set), swap it back
// into the DOM, and restore playback state.
// ─────────────────────────────────────────────────────────────────────────

function cloneAndReinsert(video) {
if (!video.parentNode) return video;

```
// Snapshot playback state before cloning
const currentTime = video.currentTime;
const wasPaused   = video.paused;
const muted       = video.muted;
const volume      = video.volume;
const playbackRate = video.playbackRate;

const clone = video.cloneNode(true);
clone.setAttribute('x-webkit-airplay', 'allow');
clone.setAttribute('airplay', 'allow');

video.parentNode.replaceChild(clone, video);

// Restore state on the clone
clone.currentTime  = currentTime;
clone.muted        = muted;
clone.volume       = volume;
clone.playbackRate = playbackRate;
if (!wasPaused) {
  clone.play().catch(() => {});
}

return clone;
```

}

// ─────────────────────────────────────────────────────────────────────────
// MODULE 5 — AIRPLAY BUTTON OVERLAY
//
// Injects a small ⊞ AirPlay button over each video that calls
// webkitShowPlaybackTargetPicker() on tap.
//
// Why: many sites hide the native video controls entirely, so the built-in
// AirPlay button in the control bar never appears. This bypasses that.
// Also fixes the iOS 10+ confusion between “Audio Playback” and “AirPlay
// video” — this button only targets video-capable AirPlay devices.
// ─────────────────────────────────────────────────────────────────────────

function injectAirPlayButton(video) {
if (typeof video.webkitShowPlaybackTargetPicker !== ‘function’) return;

```
const wrapper = video.parentNode;
if (!wrapper) return;
if (wrapper.querySelector('.ap-btn-injected')) return;

// Make sure wrapper is positioned so our absolute button works
const wrapStyle = window.getComputedStyle(wrapper).position;
if (wrapStyle === 'static') wrapper.style.position = 'relative';

const btn = _origCreateElement('button');
btn.className = 'ap-btn-injected';
btn.title     = 'AirPlay video';
btn.innerHTML = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round">
    <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/>
    <polygon points="12 15 17 21 7 21 12 15"/>
  </svg>
`;
btn.style.cssText = `
  position: absolute;
  bottom: 10px;
  right: 10px;
  z-index: 2147483647;
  background: rgba(0, 0, 0, 0.60);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 7px 9px;
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: opacity 0.2s;
  line-height: 0;
`;

btn.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  video.webkitShowPlaybackTargetPicker();
});

// Show on hover (desktop) and briefly on tap (mobile)
const show = () => (btn.style.display = 'flex');
const hide = () => (btn.style.display = 'none');

video.addEventListener('mouseenter', show);
video.addEventListener('mouseleave', hide);
video.addEventListener('touchstart', () => {
  show();
  setTimeout(hide, 3500);
}, { passive: true });

// Only show if an AirPlay device is actually available
video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
  if (e.availability === 'available') {
    show();
  } else {
    hide();
  }
});

wrapper.appendChild(btn);
```

}

// ─────────────────────────────────────────────────────────────────────────
// MAIN PROCESSOR — runs on each video element
// ─────────────────────────────────────────────────────────────────────────

function processVideo(video) {
if (processedVideos.has(video)) return;
processedVideos.add(video);

```
if (isMSEVideo(video)) {
  // ── MSE path ──
  // Don't clone — it would destroy the MediaSource attachment.
  // Instead, inject an m3u8 secondary source so WebKit can hand
  // the real URL to AirPlay. Retry with backoff because the m3u8
  // URL might not have been sniffed yet when the video first loads.
  if (!tryInjectHLSSource(video)) {
    setTimeout(() => tryInjectHLSSource(video), 800);
    setTimeout(() => tryInjectHLSSource(video), 2500);
    setTimeout(() => tryInjectHLSSource(video), 5000);
  }
} else {
  // ── Plain video path ──
  const currentAttr = video.getAttribute('x-webkit-airplay');
  if (currentAttr === 'allow') {
    // Already correct — nothing to do
  } else if (video.isConnected && video.readyState > 0) {
    // Video already loaded into DOM — need clone/reinsert trick
    // to make the attribute take effect for VIDEO (not just audio)
    const newVideo = cloneAndReinsert(video);
    // Re-add to processedVideos with the clone reference
    processedVideos.add(newVideo);
    injectAirPlayButton(newVideo);
    return; // Button already handled, exit early
  } else {
    video.setAttribute('x-webkit-airplay', 'allow');
    video.setAttribute('airplay', 'allow');
  }
}

injectAirPlayButton(video);
```

}

// ─────────────────────────────────────────────────────────────────────────
// MUTATION OBSERVER — watches for videos added dynamically after page load
// ─────────────────────────────────────────────────────────────────────────

const observer = new MutationObserver((mutations) => {
for (const mutation of mutations) {
for (const node of mutation.addedNodes) {
if (node.nodeType !== 1) continue; // elements only
if (node.tagName === ‘VIDEO’) {
processVideo(node);
} else if (node.querySelectorAll) {
node.querySelectorAll(‘video’).forEach(processVideo);
}
}
}
});

// ─────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────

function init() {
// Process any videos already on the page
document.querySelectorAll(‘video’).forEach(processVideo);

```
// Watch for future videos
observer.observe(document.documentElement, {
  childList: true,
  subtree:   true,
});
```

}

// Run after DOM is available (we’re at document-start so body may not exist yet)
if (document.readyState === ‘loading’) {
document.addEventListener(‘DOMContentLoaded’, init);
} else {
init();
}

})();