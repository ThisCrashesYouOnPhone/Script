/**
 * wasm_runner.js
 * Runs cineby.sc's module.wasm in Node.js to:
 *   1. Call serve() — get the hash value (like window.hash in browser)
 *   2. Call verify(hash)
 *   3. Call decrypt(ciphertext, tmdbId) — get the pre-processed string for CryptoJS
 *   4. Then CryptoJS.AES.decrypt(result, b35ebba4) gives us the sources JSON
 */

const fs = require('fs');
const Hashids = require('hashids/cjs');
const CryptoJS = require('crypto-js');

// ─── c7 XOR hash ──────────────────────────────────────────────────────────────
function c7(e) {
  const t = e => e.split('').map(e => e.charCodeAt(0));
  return e.split('').map(e => e.charCodeAt(0))
    .map(e => t('8c465aa8af6cbfd4c1f91bf0c8d678ba').reduce((acc, v) => acc ^ v, e))
    .map(e => ('0' + Number(e).toString(16)).substr(-2))
    .join('');
}

// ─── Compute b35ebba4 (the AES key) ───────────────────────────────────────────
const tmdbId = '334541';
const k = c7(tmdbId + 'd486ae1ce6fdbe63b60bd1704541fcf0');
const h = new Hashids();
const b35ebba4 = h.encodeHex(k);
console.log('[Key] c7 k =', k);
console.log('[Key] b35ebba4 =', b35ebba4);

// ─── WASM memory helpers (mirrors the JS wrapper in module 12813) ─────────────
function makeWasmEnv(memory) {
  let mem = memory;

  function readString(ptr) {
    if (!ptr) return null;
    const buf = mem.buffer;
    const lenPtr = (ptr - 4) >>> 2;
    const len = new Uint32Array(buf)[lenPtr] >>> 1;
    const arr = new Uint16Array(buf);
    const start = ptr >>> 1;
    let result = '';
    for (let i = start; i < start + len;) {
      const chunk = Math.min(len - (i - start), 1024);
      result += String.fromCharCode(...arr.subarray(i, i + chunk));
      i += chunk;
    }
    return result;
  }

  function writeString(exports, str) {
    if (str == null) return 0;
    const len = str.length;
    const ptr = exports.__new(len << 1, 2) >>> 0;
    const arr = new Uint16Array(mem.buffer);
    for (let i = 0; i < len; i++) {
      arr[(ptr >>> 1) + i] = str.charCodeAt(i);
    }
    return ptr;
  }

  return { readString, writeString };
}

async function runWasm() {
  const wasmBuffer = fs.readFileSync('./module.wasm');
  
  // WASM env imports (mirrors the browser wrapper)
  let memory;
  const importObj = {
    env: {
      seed: () => Date.now() * Math.random(),
      abort: (msg, file, line, col) => {
        console.error('[WASM abort]', line, col);
        throw new Error('WASM abort');
      }
    }
  };

  const result = await WebAssembly.instantiate(wasmBuffer, importObj);
  const exports = result.instance.exports;
  memory = exports.memory;

  console.log('\n[WASM] Exports:', Object.keys(exports).filter(k => typeof exports[k] === 'function'));

  const { readString, writeString } = makeWasmEnv(memory);

  // Step 1: serve() — this sets the hash code (mimics window.hash)
  let hash = null;
  try {
    const servePtr = exports.serve();
    const serveCode = readString(servePtr >>> 0);
    console.log('\n[WASM] serve() code (first 200):', serveCode ? serveCode.slice(0, 200) : '(null)');

    // Execute the serve code in a sandboxed context (it sets window.hash)
    const fakeWindow = {};
    try {
      const fn = new Function('window', serveCode || '');
      fn(fakeWindow);
      hash = fakeWindow.hash;
      console.log('[WASM] window.hash after serve():', hash ? hash.slice(0, 80) + '...' : '(null)');
    } catch (execErr) {
      console.warn('[WASM] serve() exec error:', execErr.message);
    }
  } catch (e) {
    console.error('[WASM] serve() failed:', e.message);
  }

  // Step 2: verify(hash)
  if (hash) {
    try {
      const hashPtr = writeString(exports, hash);
      exports.verify(hashPtr);
      console.log('[WASM] verify() passed!');
    } catch (e) {
      console.warn('[WASM] verify() threw (may be okay):', e.message);
    }
  } else {
    console.warn('[WASM] No hash — skipping verify (WASM decrypt may fail)');
  }

  // Step 3: decrypt(ciphertext, tmdbId)
  const ciphertext = fs.readFileSync('./sources_ciphertext.txt', 'utf8').trim();
  console.log('\n[Decrypt] Ciphertext length:', ciphertext.length);
  console.log('[Decrypt] Ciphertext first 40:', ciphertext.slice(0, 40));

  let wasmDecrypted = null;
  try {
    const ctPtr = writeString(exports, ciphertext);
    const tmdbPtr = writeString(exports, tmdbId);
    const resultPtr = exports.decrypt(ctPtr, tmdbPtr);
    wasmDecrypted = readString(resultPtr >>> 0);
    console.log('[WASM] decrypt() output (first 200):', wasmDecrypted ? wasmDecrypted.slice(0, 200) : '(null)');
  } catch (e) {
    console.error('[WASM] decrypt() failed:', e.message);
  }

  // Step 4: CryptoJS.AES.decrypt(wasmDecrypted, b35ebba4)
  if (wasmDecrypted) {
    console.log('\n[CryptoJS] Attempting AES decrypt with b35ebba4 key...');
    try {
      const final = CryptoJS.AES.decrypt(wasmDecrypted, b35ebba4).toString(CryptoJS.enc.Utf8);
      if (final && final.length > 10) {
        console.log('✅ SUCCESS! Decrypted output (first 500):');
        console.log(final.slice(0, 500));
        try {
          const parsed = JSON.parse(final);
          console.log('\n✅ Parsed JSON keys:', Object.keys(parsed));
          if (parsed.sources) {
            console.log('Stream sources:');
            parsed.sources.forEach(s => console.log(' -', s.url || s.file, '(', s.quality, ')'));
          }
        } catch(pe) {
          console.log('(Could not parse as JSON, but decryption output is above)');
        }
      } else {
        console.log('❌ CryptoJS returned empty/short result. Key or ciphertext mismatch.');
      }
    } catch (e) {
      console.error('[CryptoJS] Error:', e.message);
    }
  }
}

runWasm().catch(err => {
  console.error('Fatal WASM runner error:', err);
});
