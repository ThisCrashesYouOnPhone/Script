/**
 * fix_encode.js — Diagnose and fix the Hashids extraction from HAR
 * 
 * Goal: get the actual AES key = Hashids.encode(k) where
 *   k = c7('334541' + 'd486ae1ce6fdbe63b60bd1704541fcf0')
 */

const fs = require('fs');

const har = JSON.parse(fs.readFileSync('www.cineby.sc.har', 'utf8'));

// ── Step 1: Verify k from c7 ──────────────────────────────────────────────────
function c7(e) {
  const t = e => e.split('').map(e => e.charCodeAt(0));
  return e.split('').map(e => e.charCodeAt(0))
    .map(e => t('8c465aa8af6cbfd4c1f91bf0c8d678ba').reduce((acc, v) => acc ^ v, e))
    .map(e => ('0' + Number(e).toString(16)).substr(-2))
    .join('');
}

const tmdbId = '334541';
const k = c7(tmdbId + 'd486ae1ce6fdbe63b60bd1704541fcf0');
console.log('[Step 1] c7 k =', k);
console.log('[Step 1] k length =', k.length);

// ── Step 2: Find Hashids chunk in HAR ──────────────────────────────────────────
const chunk4896Entry = har.log.entries.find(e =>
  e.request.url.includes('4896-2535ccc269c78169.js') &&
  e.response.content &&
  e.response.content.text
);

if (!chunk4896Entry) {
  console.error('[Step 2] FAILED: chunk 4896 not found in HAR');
  process.exit(1);
}
const chunk4896 = chunk4896Entry.response.content.text;
console.log('[Step 2] chunk4896 length:', chunk4896.length);

// ── Step 3: Locate class y boundaries more carefully ──────────────────────────
const classStart = chunk4896.indexOf('class y{');
console.log('[Step 3] class y starts at index:', classStart);

// Find the correct end — we need to find the matching closing brace, not a hardcoded string
// Let's try to find the end of the module by looking for the end pattern
const possibleEnds = [
  ',59403:function',
  '\n},',
  '},function',
  ';return y',
  'return new y(',
];

for (const end of possibleEnds) {
  const idx = chunk4896.indexOf(end, classStart + 8);
  if (idx !== -1) {
    console.log(`[Step 3] Possible end marker "${end}" at index: ${idx}`);
  }
}

// Extract a larger window and print first 2000 chars for inspection
const classSnippet = chunk4896.slice(classStart, classStart + 2000);
console.log('\n[Step 3] First 2000 chars of class y block:');
console.log(classSnippet);
console.log('\n...');

// ── Step 4: Try to find the encode method ────────────────────────────────────
const encodeIdx = chunk4896.indexOf('encode(', classStart);
console.log('\n[Step 4] First "encode(" after class start:', encodeIdx);
if (encodeIdx !== -1) {
  console.log('[Step 4] Context around encode:', chunk4896.slice(encodeIdx - 20, encodeIdx + 200));
}

// ── Step 5: Try using the npm hashids package directly ────────────────────────
// The cineby.sc Hashids is standard hashids.js with empty salt and default alphabet
try {
  const Hashids = require('hashids/cjs');
  const h = new Hashids(); // default: no salt, no min length, default alphabet
  // k is a hex string — Hashids.encode() takes numbers, so we need to determine
  // what exactly k is being passed as. From the source: x.encode(k) where k is the hex string.
  // Hashids can encode a hex string via encodeHex(), or encode numbers via encode().
  // Let's try both:
  console.log('\n[Step 5] Testing npm hashids package:');
  console.log('  h.encode(k as string):', h.encode(k));
  console.log('  h.encodeHex(k):', h.encodeHex(k));
  
  // Also try encoding k parsed as a BigInt or chunked numbers
  const kBig = BigInt('0x' + k);
  console.log('  k as BigInt:', kBig.toString());
  // BigInt may be too large, try splitting k into 2-char hex bytes as numbers
  const kBytes = k.match(/.{2}/g).map(b => parseInt(b, 16));
  console.log('  kBytes:', kBytes);
  console.log('  h.encode(...kBytes):', h.encode(...kBytes));
  
} catch (e) {
  console.log('[Step 5] npm hashids not installed:', e.message);
  console.log('[Step 5] Run: npm install hashids');
}
