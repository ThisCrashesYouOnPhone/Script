// ==UserScript==
// @name         Eruda Persistent Console
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

const LOG_KEY = 'eruda_persist_logs';
const MAX_LOGS = 200;

// Read existing logs from storage
function getLogs() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } 
  catch { return []; }
}

// Write a new log entry
function saveLog(type, detail) {
  const logs = getLogs();
  logs.push({ type, detail, url: location.href, time: new Date().toLocaleTimeString() });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS); // trim old
  localStorage.setItem(LOG_KEY, JSON.stringify(logs));
}

// Your intercept hooks — same as before but now also persist
const _open = window.open.bind(window);
window.open = function(url, ...args) {
  saveLog('window.open', url);
  return null; // block
};

const _addEL = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function(type, fn, opts) {
  if (['click','mousedown','touchend'].includes(type) && this === document) {
    saveLog('doc-listener', type);
  }
  return _addEL.call(this, type, fn, opts);
};

new MutationObserver(muts => {
  for (const m of muts) for (const node of m.addedNodes) {
    if (node.tagName === 'META' && node.httpEquiv?.toLowerCase() === 'refresh') {
      saveLog('meta-refresh', node.content);
      node.remove();
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// Load Eruda, restore logs, auto-open
window.addEventListener('load', () => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda';
  s.onload = () => {
    eruda.init();
    eruda.show(); // auto-open every page

    const ec = eruda.get('console');

    // Replay persisted logs into Eruda console
    const logs = getLogs();
    if (logs.length) {
      ec.log(`--- Restored ${logs.length} logs from previous pages ---`);
      logs.forEach(({ time, url, type, detail }) => {
        ec.warn(`[${time}] [${type}] on ${url}\n  → ${detail}`);
      });
      ec.log('--- Current page starts below ---');
    }

    // Now override saveLog to also write to Eruda live
    const _save = saveLog;
    window._interceptLog = (type, detail) => {
      saveLog(type, detail);
      ec.warn(`[LIVE][${type}] ${detail}`);
    };
  };
  document.body.appendChild(s);
});
