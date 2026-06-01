/**
 * verify_decrypt.js
 * Attempts full decryption of sources_ciphertext.txt using both
 * encode(k) and encodeHex(k) to determine which one cineby.sc actually uses.
 */

const fs = require('fs');
const Hashids = require('hashids/cjs');
const CryptoJS = require('crypto-js');

function c7(e) {
  const t = e => e.split('').map(e => e.charCodeAt(0));
  return e.split('').map(e => e.charCodeAt(0))
    .map(e => t('8c465aa8af6cbfd4c1f91bf0c8d678ba').reduce((acc, v) => acc ^ v, e))
    .map(e => ('0' + Number(e).toString(16)).substr(-2))
    .join('');
}

const tmdbId = '334541';
const k = c7(tmdbId + 'd486ae1ce6fdbe63b60bd1704541fcf0');
console.log('k =', k);

const h = new Hashids();
const keyEncodeHex = h.encodeHex(k);
const keyEncodeStr = h.encode(k); // will be "" since k is not numeric
const kBytes = k.match(/.{2}/g).map(b => parseInt(b, 16));
const keyEncodeBytes = h.encode(...kBytes);

console.log('keyEncodeHex:', keyEncodeHex);
console.log('keyEncodeStr (empty expected):', JSON.stringify(keyEncodeStr));
console.log('keyEncodeBytes:', keyEncodeBytes);

const ciphertext = fs.readFileSync('sources_ciphertext.txt', 'utf8').trim();
console.log('\nCiphertext first 80 chars:', ciphertext.slice(0, 80));
console.log('Ciphertext length:', ciphertext.length);

const candidates = [
  { label: 'encodeHex(k)', key: keyEncodeHex },
  { label: 'encode(...kBytes)', key: keyEncodeBytes },
  // Also try the raw k string and hex interpretations as a sanity check
  { label: 'raw k string', key: k },
  { label: 'k slice 0-8', key: k.slice(0, 8) },
];

console.log('\n--- Attempting decryption with each key candidate ---');
for (const { label, key } of candidates) {
  if (!key) { console.log(`[${label}] SKIP (empty key)`); continue; }
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    const dec = bytes.toString(CryptoJS.enc.Utf8);
    if (dec && dec.length > 10 && (dec.startsWith('{') || dec.startsWith('['))) {
      console.log(`\n✅ [${label}] DECRYPTED SUCCESSFULLY!`);
      console.log('   Key used:', key.slice(0, 40) + '...');
      console.log('   Decrypted (first 500 chars):', dec.slice(0, 500));
      // Try to parse
      try {
        const parsed = JSON.parse(dec);
        console.log('   Parsed JSON keys:', Object.keys(parsed));
        // Look for stream URLs
        const str = JSON.stringify(parsed);
        const m3u8Matches = str.match(/https?:[^"]+\.m3u8[^"]*/g);
        if (m3u8Matches) console.log('   m3u8 URLs found:', m3u8Matches);
      } catch(pe) {
        console.log('   (Not valid JSON or partial)');
      }
    } else if (dec && dec.length > 0) {
      console.log(`[${label}] Got some output but doesn't look like JSON (len=${dec.length}): "${dec.slice(0, 80)}..."`);
    } else {
      console.log(`[${label}] Decrypted to empty string (wrong key or encoding mismatch)`);
    }
  } catch(e) {
    console.log(`[${label}] Error: ${e.message}`);
  }
}
