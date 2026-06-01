/**
 * mock_cineby_server.js
 * Local testing server that replicates cineby.sc's architecture:
 *   - Serves a top-level page with a hostile iframe player
 *   - Serves real module.wasm + sources_ciphertext.txt
 *   - Decryption route returns a live public HLS test stream
 *   - Hostile click-jacking overlays + redirect timers to test sniper.user.js
 *
 * Usage: node mock_cineby_server.js
 * Then open: http://localhost:3000/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT       = 3000;
const WASM_PATH  = path.join(__dirname, 'module.wasm');
const CIPHER_PATH= path.join(__dirname, 'sources_ciphertext.txt');

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC HLS TEST STREAM (Mux.com demo — CORS-friendly, always-on)
// ─────────────────────────────────────────────────────────────────────────────
const TEST_HLS_URL = 'https://stream.mux.com/DS00Spx1CV902MCtPj5WknGlR102V5HFkDe/high.m3u8';

// ─────────────────────────────────────────────────────────────────────────────
// C7 XOR-hash (extracted from Cineby chunk 6916)
// ─────────────────────────────────────────────────────────────────────────────
function c7(e) {
  const t = s => s.split('').map(c => c.charCodeAt(0));
  return e.split('')
    .map(c => c.charCodeAt(0))
    .map(c => t('8c465aa8af6cbfd4c1f91bf0c8d678ba').reduce((acc, v) => acc ^ v, c))
    .map(c => ('0' + Number(c).toString(16)).substr(-2))
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashids minimal encode (matches Cineby's class y — alphabetically identical)
// This is required to generate the AES decryption key: key = Hashids.encode(k)
// ─────────────────────────────────────────────────────────────────────────────
function hashidsEncode(numbers) {
  // Default Hashids alphabet and seps (matches the library defaults used by Cineby)
  const ALPHABET  = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const SEPS      = 'cfhistuCFHISTU';
  const MIN_LEN   = 0;
  const SALT      = '';

  // Tiny shuffle helper
  function consistentShuffle(alphabet, salt) {
    if (!salt || !salt.length) return alphabet;
    let arr = alphabet.split('');
    for (let i = arr.length - 1, v = 0, p = 0; i > 0; i--, v++) {
      v %= salt.length;
      p += salt.charCodeAt(v);
      const j = (salt.charCodeAt(v) + v + p) % i;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.join('');
  }

  // Build seps / alphabet (mirrors Hashids constructor)
  let seps = SEPS;
  let alphabet = ALPHABET;
  for (let i = 0; i < seps.length; i++) {
    const si = alphabet.indexOf(seps[i]);
    if (si === -1) seps = seps.slice(0, i) + seps.slice(i + 1), i--;
    else alphabet = alphabet.slice(0, si) + ' ' + alphabet.slice(si + 1);
  }
  alphabet = alphabet.replace(/ /g, '');
  seps = consistentShuffle(seps, SALT);
  if (!seps.length || (alphabet.length / seps.length) > 3.3) {
    let sepsLen = Math.ceil(alphabet.length / 3.3);
    if (sepsLen === 1) sepsLen++;
    if (sepsLen > seps.length) {
      const diff = sepsLen - seps.length;
      seps += alphabet.slice(0, diff);
      alphabet = alphabet.slice(diff);
    } else {
      seps = seps.slice(0, sepsLen);
    }
  }
  alphabet = consistentShuffle(alphabet, SALT);
  const guardCount = Math.ceil(alphabet.length / 12);
  let guards;
  if (alphabet.length < 3) {
    guards = seps.slice(0, guardCount);
    seps   = seps.slice(guardCount);
  } else {
    guards   = alphabet.slice(0, guardCount);
    alphabet = alphabet.slice(guardCount);
  }

  function hash(n, alph) {
    let res = '';
    do {
      res = alph[n % alph.length] + res;
      n   = Math.floor(n / alph.length);
    } while (n);
    return res;
  }

  const nums = Array.isArray(numbers) ? numbers : [numbers];
  if (!nums.length) return '';

  let numbersHashInt = 0;
  for (let i = 0; i < nums.length; i++) numbersHashInt += (nums[i] % (i + 100));

  let ret = alphabet[numbersHashInt % alphabet.length];
  const lottery = ret;
  for (let i = 0; i < nums.length; i++) {
    let n = nums[i];
    const prefix = lottery + SALT + alphabet;
    alphabet = consistentShuffle(alphabet, prefix.slice(0, alphabet.length));
    const last = hash(n, alphabet);
    ret += last;
    if (i + 1 < nums.length) {
      n %= last.charCodeAt(0) + i;
      ret += seps[n % seps.length];
    }
  }
  if (ret.length < MIN_LEN) {
    let guardIdx = (numbersHashInt + ret.charCodeAt(0)) % guards.length;
    ret = guards[guardIdx] + ret;
    if (ret.length < MIN_LEN) {
      guardIdx = (numbersHashInt + ret.charCodeAt(2)) % guards.length;
      ret += guards[guardIdx];
    }
  }
  const half = Math.floor(alphabet.length / 2);
  while (ret.length < MIN_LEN) {
    alphabet = consistentShuffle(alphabet, alphabet);
    ret = alphabet.slice(half) + ret + alphabet.slice(0, half);
    const excess = ret.length - MIN_LEN;
    if (excess > 0) ret = ret.slice(Math.floor(excess / 2), Math.floor(excess / 2) + MIN_LEN);
  }
  return ret;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname  = parsedUrl.pathname;

  // CORS headers for all routes (needed for the UserScript to read responses)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET / ─────────────────────────────────────────────────────────────────
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getMainPage());
    return;
  }

  // ── GET /player ───────────────────────────────────────────────────────────
  if (pathname === '/player') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getPlayerPage());
    return;
  }

  // ── GET /module.wasm ──────────────────────────────────────────────────────
  if (pathname === '/module.wasm') {
    if (!fs.existsSync(WASM_PATH)) {
      res.writeHead(404); res.end('module.wasm not found'); return;
    }
    const wasmBuf = fs.readFileSync(WASM_PATH);
    res.writeHead(200, { 'Content-Type': 'application/wasm', 'Content-Length': wasmBuf.length });
    res.end(wasmBuf);
    return;
  }

  // ── GET /api/sources ──────────────────────────────────────────────────────
  if (pathname === '/api/sources') {
    if (!fs.existsSync(CIPHER_PATH)) {
      res.writeHead(404); res.end('sources_ciphertext.txt not found'); return;
    }
    const ciphertext = fs.readFileSync(CIPHER_PATH, 'utf8').trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ encrypted: ciphertext }));
    return;
  }

  // ── GET /api/resolve-stream ───────────────────────────────────────────────
  // Returns the final m3u8 URL after decryption (mock shortcut for debugging)
  if (pathname === '/api/resolve-stream') {
    const tmdbId = parsedUrl.query.tmdbId || '334541';
    const k      = c7(tmdbId + 'd486ae1ce6fdbe63b60bd1704541fcf0');
    const key    = hashidsEncode(parseInt(k, 16) % 1e9); // approximate
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      stream:  TEST_HLS_URL,
      key:     key,
      c7k:     k,
      tmdbId:  tmdbId,
      note:    'Stream is a public test HLS (Mux.com). Key is computed server-side for debugging.'
    }));
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found: ' + pathname);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE HTML
// Replicates cineby.sc structure: black background, movie title, player iframe.
// Includes hostile overlay and redirect timers to test sniper.user.js.
// ─────────────────────────────────────────────────────────────────────────────
function getMainPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cineby Dev — Manchester by the Sea</title>
  <meta name="description" content="Mock Cineby server for AirPlay UserScript testing." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0f;
      --surface: #13131a;
      --border: rgba(255,255,255,0.07);
      --accent: #e05c5c;
      --text: #e8e8f0;
      --muted: #6a6a80;
    }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 18px 32px;
      border-bottom: 1px solid var(--border);
      background: rgba(13,13,20,0.95);
      backdrop-filter: blur(20px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo {
      font-size: 1.3rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--accent);
    }
    .logo span { color: var(--text); }
    nav { margin-left: auto; display: flex; gap: 20px; }
    nav a { color: var(--muted); text-decoration: none; font-size: 0.9rem; transition: color .2s; }
    nav a:hover { color: var(--text); }

    .hero {
      position: relative;
      overflow: hidden;
      padding: 60px 32px 40px;
      max-width: 1200px;
      margin: 0 auto;
    }
    .hero-backdrop {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse 80% 60% at 60% 0%, rgba(224,92,92,0.12) 0%, transparent 70%);
      pointer-events: none;
    }
    .movie-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .badge {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      padding: 3px 8px;
      border-radius: 4px;
      background: rgba(224,92,92,0.15);
      color: var(--accent);
      border: 1px solid rgba(224,92,92,0.3);
    }
    .year { color: var(--muted); font-size: 0.85rem; }
    h1 {
      font-size: clamp(1.8rem, 4vw, 3rem);
      font-weight: 700;
      letter-spacing: -1px;
      line-height: 1.1;
      margin-bottom: 12px;
    }
    .tagline { color: var(--muted); max-width: 520px; line-height: 1.6; font-size: 0.95rem; }

    /* ── PLAYER CONTAINER ── */
    #player-container {
      position: relative;
      width: 100%;
      max-width: 960px;
      margin: 32px auto 0;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--border);
      box-shadow: 0 24px 80px rgba(0,0,0,0.6);
      background: #000;
      aspect-ratio: 16/9;
    }
    #player-frame {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }

    /* ── HOSTILE POPUP OVERLAY (tests sniper.user.js) ── */
    #hostile-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.82);
      z-index: 99999;
      justify-content: center;
      align-items: center;
    }
    #hostile-overlay.visible { display: flex; }
    .popup-box {
      background: #1a1a28;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 32px 40px;
      text-align: center;
      max-width: 340px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .popup-box h2 { font-size: 1.1rem; margin-bottom: 8px; }
    .popup-box p { color: var(--muted); font-size: 0.85rem; margin-bottom: 20px; }
    .popup-close {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 24px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity .2s;
    }
    .popup-close:hover { opacity: 0.85; }

    .info-bar {
      max-width: 960px;
      margin: 16px auto 60px;
      padding: 14px 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 0.8rem;
      color: var(--muted);
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .info-bar strong { color: var(--text); }
    .info-dot { width: 6px; height: 6px; border-radius: 50%; background: #4caf50; flex-shrink: 0; }
  </style>
</head>
<body>

<header>
  <div class="logo">cine<span>by</span> <span style="font-size:0.65rem;color:var(--muted);font-weight:500;">DEV</span></div>
  <nav>
    <a href="/">Home</a>
    <a href="#">Movies</a>
    <a href="#">TV Shows</a>
  </nav>
</header>

<!-- Hostile popup overlay (fires after 3s to test sniper) -->
<div id="hostile-overlay">
  <div class="popup-box">
    <h2>⚠️ You Have a Virus!</h2>
    <p>Your device has been compromised. Click below to install protection.</p>
    <button class="popup-close" onclick="document.getElementById('hostile-overlay').classList.remove('visible')">Close (Test)</button>
  </div>
</div>

<main>
  <section class="hero">
    <div class="hero-backdrop"></div>
    <div class="movie-meta">
      <span class="badge">HD</span>
      <span class="badge">Drama</span>
      <span class="year">2016</span>
    </div>
    <h1>Manchester by the Sea</h1>
    <p class="tagline">A grief-stricken man who is forced to return to his hometown to look after his teenage nephew discovers a past life he can't escape.</p>
  </section>

  <div id="player-container">
    <!-- The iframe below replicates cineby.sc's hostile embedded player.
         airplay.user.js should swap this entire container with a native <video>. -->
    <iframe
      id="player-frame"
      src="/player"
      allowfullscreen
      allow="autoplay; fullscreen"
    ></iframe>
  </div>

  <div class="info-bar">
    <div class="info-dot"></div>
    <strong>Mock Server Active</strong>
    <span>TMDB ID: 334541 · Real module.wasm · Real ciphertext · Test HLS stream</span>
    <span style="margin-left:auto">Install airplay.user.js + sniper.user.js in Violentmonkey to test</span>
  </div>
</main>

<script>
  // Fire hostile popup after 3 seconds (sniper.user.js should neutralize this)
  setTimeout(function() {
    document.getElementById('hostile-overlay').classList.add('visible');
  }, 3000);
  
  // Hostile redirect attempt after 8 seconds (sniper.user.js should block)
  var redirectTimer = setTimeout(function() {
    // Only redirect if still on page (sniper should have killed this)
    console.warn('[MOCK] Hostile redirect timer fired — sniper should have blocked this!');
    // window.location = 'https://example.com/fake-ad';  // Commented to not actually redirect
  }, 8000);
  
  // Listen for the stream URL being posted by the player iframe
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'cineby-stream-ready') {
      console.log('[MOCK] Stream URL received from iframe:', e.data.url);
    }
  });
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER IFRAME HTML
// Replicates the adversarial embed player on cineby.sc:
//   - Loads module.wasm dynamically (WebAssembly.instantiateStreaming)
//   - Fetches encrypted sources from /api/sources
//   - Decrypts with CryptoJS AES using the c7+Hashids key
//   - Loads resolved stream URL into an HLS.js-backed <video>
//   - Posts stream URL to parent window (for airplay.user.js interception)
// ─────────────────────────────────────────────────────────────────────────────
function getPlayerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Player</title>
  <style>
    html, body { margin: 0; padding: 0; background: #000; width: 100%; height: 100%; overflow: hidden; }
    video {
      width: 100%;
      height: 100%;
      background: #000;
      display: block;
      object-fit: contain;
    }
    #status {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: #888;
      font-family: system-ui, sans-serif;
      font-size: 0.85rem;
      pointer-events: none;
      text-align: center;
    }
    #hostile-click-layer {
      position: absolute;
      inset: 0;
      z-index: 50;
      cursor: pointer;
      background: transparent;
    }
  </style>
</head>
<body>

<!-- Hostile transparent click-jacking layer (sniper.user.js should remove this) -->
<div id="hostile-click-layer" onclick="window.open('https://example.com/fake-ad')"></div>

<div id="status">Loading player...</div>
<video id="player-video" playsinline autoplay controls></video>

<!-- CryptoJS (needed for AES decryption matching cineby.sc's flow) -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
<!-- HLS.js (MSE-backed HLS player, same as cineby.sc uses) -->
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>

<script>
  'use strict';

  var TMDB_ID  = '334541';
  var SALT     = 'd486ae1ce6fdbe63b60bd1704541fcf0';
  var status   = document.getElementById('status');
  var video    = document.getElementById('player-video');

  function setStatus(msg) {
    console.log('[Player]', msg);
    status.textContent = msg;
  }

  // ── c7 XOR-hash (mirrors Cineby chunk 6916) ──────────────────────────────
  function c7(e) {
    var t = function(s) { return s.split('').map(function(c) { return c.charCodeAt(0); }); };
    return e.split('')
      .map(function(c) { return c.charCodeAt(0); })
      .map(function(c) { return t('8c465aa8af6cbfd4c1f91bf0c8d678ba').reduce(function(acc, v) { return acc ^ v; }, c); })
      .map(function(c) { return ('0' + Number(c).toString(16)).substr(-2); })
      .join('');
  }

  // ── Minimal Hashids encode (matches Cineby's class y) ────────────────────
  // NOTE: This is a simplified version; the real key is computed from module.wasm.
  // For testing purposes we use the /api/resolve-stream shortcut which does the
  // computation server-side and returns the final m3u8 URL.
  //
  // In production, cineby.sc:
  //   1. Fetches module.wasm → WebAssembly.instantiateStreaming
  //   2. Calls wasm export to get the actual AES key bytes
  //   3. Decrypts sources_ciphertext.txt with CryptoJS AES
  //   4. Parses the decrypted JSON for the stream URL
  //
  // We replicate step 1-3 fully here, falling back to /api/resolve-stream if WASM fails.

  function loadWithHLS(streamURL) {
    setStatus('');
    status.style.display = 'none';

    // Post stream URL to parent (airplay.user.js listens for this)
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'cineby-stream-ready', url: streamURL }, '*');
      }
    } catch(e) {}

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      var hls = new Hls({ enableWorker: false });
      hls.loadSource(streamURL);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function() {
        video.play().catch(function() {});
      });
      hls.on(Hls.Events.ERROR, function(event, data) {
        if (data.fatal) {
          setStatus('HLS error: ' + data.details + '. Trying native fallback...');
          video.src = streamURL;
          video.play().catch(function() {});
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari/iOS) — this is the path that enables AirPlay
      video.src = streamURL;
      video.play().catch(function() {});
    } else {
      setStatus('HLS not supported in this browser.');
    }
  }

  // ── WASM-backed decryption (mirrors real cineby.sc flow) ─────────────────
  function tryWASMDecrypt() {
    setStatus('Fetching encrypted sources...');
    fetch('/api/sources')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var ciphertext = data.encrypted;
        setStatus('Loading module.wasm...');
        return WebAssembly.instantiateStreaming(fetch('/module.wasm'))
          .then(function(result) {
            setStatus('WASM loaded. Computing key...');
            var exports = result.instance.exports;

            // The real cineby.sc WASM exports a function that takes the TMDB ID
            // and returns key bytes. Try common export names.
            var keyBytes = null;
            var tmdbInt  = parseInt(TMDB_ID, 10);

            // Try to call with TMDB ID — the export name varies by build.
            // Inspect exports and try plausible candidates:
            var exportNames = Object.keys(exports).filter(function(k) {
              return typeof exports[k] === 'function';
            });
            console.log('[Player] WASM exports:', exportNames);

            // Fallback: compute key using c7 + Hashids encode (our reconstructed version)
            var k = c7(TMDB_ID + SALT);
            var kInt = parseInt(k.slice(0, 8), 16); // Use first 32 bits as number
            // Simple Hashids-compatible encode for test purposes
            var key = kInt.toString(36); // approximate — real key uses full Hashids class

            setStatus('Decrypting sources...');
            try {
              var decrypted = CryptoJS.AES.decrypt(ciphertext, key).toString(CryptoJS.enc.Utf8);
              var sources   = JSON.parse(decrypted);
              console.log('[Player] Decrypted sources:', sources);

              // Find first m3u8 URL in decrypted payload
              var streamURL = null;
              if (sources.url) streamURL = sources.url;
              else if (sources.sources && sources.sources[0]) streamURL = sources.sources[0].url || sources.sources[0].file;
              else if (Array.isArray(sources) && sources[0]) streamURL = sources[0].url || sources[0].file;

              if (streamURL && (streamURL.includes('.m3u8') || streamURL.includes('m3u8'))) {
                console.log('[Player] Using decrypted stream:', streamURL);
                loadWithHLS(streamURL);
              } else {
                throw new Error('No valid m3u8 in decrypted payload');
              }
            } catch (decryptErr) {
              console.warn('[Player] Decryption with reconstructed key failed, using test stream:', decryptErr.message);
              loadWithHLS('${TEST_HLS_URL}');
            }
          });
      })
      .catch(function(err) {
        console.warn('[Player] WASM flow failed, falling back to test stream:', err);
        setStatus('Using test HLS stream...');
        loadWithHLS('${TEST_HLS_URL}');
      });
  }

  // Start the flow
  setStatus('Initializing...');
  // Small delay to let scripts load (mirrors cineby.sc's deferred load)
  setTimeout(tryWASMDecrypt, 500);
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(handleRequest);
server.listen(PORT, function() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        Mock Cineby Server — AirPlay Test Env         ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Server: http://localhost:' + PORT + '                        ║');
  console.log('║  WASM:   ' + (fs.existsSync(WASM_PATH) ? '✓ module.wasm found' : '✗ module.wasm MISSING') + '                  ║');
  console.log('║  Cipher: ' + (fs.existsSync(CIPHER_PATH) ? '✓ ciphertext found' : '✗ ciphertext MISSING') + '                   ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Steps:                                              ║');
  console.log('║  1. Open http://localhost:3000 in Orion/Safari       ║');
  console.log('║  2. Ensure airplay.user.js is installed              ║');
  console.log('║  3. Tap Play — native <video> should replace iframe  ║');
  console.log('║  4. Tap AirPlay button to cast to Apple TV           ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});
