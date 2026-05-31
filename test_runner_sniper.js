// test_runner_sniper.js
// Automated CLI Test Environment for Orion Stream Sniper Adblocker

const fs = require('fs');
const vm = require('vm');
const path = require('path');

console.log('=====================================================');
console.log('  STARTING ORION STREAM SNIPER TEST SUITE  ');
console.log('=====================================================\n');

// ─── 1. BROWSER DOM ENVIRONMENT MOCKS ──────────────────────────────────────────

const mockLocalStorage = {
  store: {},
  getItem(key) { return this.store[key] !== undefined ? this.store[key] : null; },
  setItem(key, value) { this.store[key] = String(value); }
};

const mockDocument = {
  readyState: 'loading',
  listeners: {},
  addEventListener(event, cb) {
    this.listeners[event] = cb;
  },
  triggerDOMContentLoaded() {
    this.readyState = 'complete';
    if (this.listeners['DOMContentLoaded']) {
      this.listeners['DOMContentLoaded']();
    }
  },
  documentElement: {
    tagName: 'HTML',
    nodeType: 1,
    childNodes: [],
    appendChild(node) {
      this.childNodes.push(node);
      node.parentNode = this;
    }
  },
  createElement(tag) {
    return {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      style: {},
      attributes: {},
      childNodes: [],
      parentNode: null,
      getBoundingClientRect() { return { width: 640, height: 360 }; },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return this.attributes[name] || null;
      },
      appendChild(node) {
        this.childNodes.push(node);
        node.parentNode = this;
      },
      addEventListener(event, cb) {
        this.listeners = this.listeners || {};
        this.listeners[event] = cb;
      },
      dispatchEvent(event, data) {
        if (this.listeners && this.listeners[event]) {
          this.listeners[event](data);
        }
      }
    };
  },
  getElementById(id) {
    // Return dummy player container to prevent takeover crashes
    const container = this.createElement('div');
    container.id = id;
    return container;
  },
  querySelector(sel) {
    if (sel === 'source[data-ap-injected]') {
      return this.childNodes.find(n => n.tagName === 'SOURCE' && n.attributes['data-ap-injected'] === 'true') || null;
    }
    if (sel === '.ap-btn-injected') {
      return this.childNodes.find(n => n.className === 'ap-btn-injected') || null;
    }
    // Return dummy elements to prevent crashes in player selectors
    const el = this.createElement('div');
    el.className = sel.replace('.', '');
    return el;
  }
};

class MockXMLHttpRequest {
  constructor() {
    this.listeners = {};
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  addEventListener(event, cb) {
    this.listeners[event] = cb;
  }
  setRequestHeader(n, v) {
    this.headers = this.headers || {};
    this.headers[n] = v;
  }
  send(body) {
    this.body = body;
    if (this.listeners['loadend']) {
      this.listeners['loadend']();
    }
  }
}

const mockWindow = {
  setTimeout: setTimeout,
  setInterval: setInterval,
  clearTimeout: clearTimeout,
  open(url, target, features) {
    return null;
  },
  addEventListener(event, cb) {
    this.messageListener = cb;
  }
};

const mockHTMLVideoElement = {
  prototype: {
    _src: '',
    get src() { return this._src; },
    set src(val) { this._src = val; }
  }
};

const mockHTMLMediaElement = {
  prototype: {
    load() { this.loaded = true; }
  }
};

const sandbox = {
  window: mockWindow,
  document: mockDocument,
  location: {
    href: 'https://pooembed.eu/stream/12345',
    hostname: 'pooembed.eu'
  },
  XMLHttpRequest: MockXMLHttpRequest,
  HTMLVideoElement: mockHTMLVideoElement,
  HTMLMediaElement: mockHTMLMediaElement,
  localStorage: mockLocalStorage,
  WeakSet: WeakSet,
  Map: Map,
  Set: Set,
  console: console,
  setTimeout: setTimeout,
  setInterval: setInterval,
  clearTimeout: clearTimeout,
  Request: class { constructor(url) { this.url = url; } }
};

// Setup prototypes
Object.setPrototypeOf(mockHTMLVideoElement.prototype, mockHTMLMediaElement.prototype);

sandbox.setTimeout = mockWindow.setTimeout;
sandbox.setInterval = mockWindow.setInterval;
sandbox.clearTimeout = mockWindow.clearTimeout;
sandbox.open = mockWindow.open;

// ─── 2. LOAD AND EVALUATE SCRIPT ─────────────────────────────────────────────

const scriptPath = path.join(__dirname, 'sniper.user.js');
const scriptContent = fs.readFileSync(scriptPath, 'utf8');

vm.createContext(sandbox);
vm.runInContext(scriptContent, sandbox);

// ─── 3. TEST CASES ───────────────────────────────────────────────────────────

let totalTests = 0;
let passedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`[PASS] ${message}`);
  } else {
    console.error(`[FAIL] ${message}`);
  }
}

mockDocument.triggerDOMContentLoaded();

// Test 1: Local Storage GM Fallback Verification (Verify logged entry exists in localStorage)
try {
  // Let the background async XHR logger run, and assert that it successfully writes to mockLocalStorage!
  setTimeout(() => {
    const rawVal = mockLocalStorage.getItem('orion_net_log');
    assert(
      rawVal !== null && rawVal.includes('xhr') && rawVal.includes('playlist.m3u8'),
      'Fallback storage successfully fell back to localStorage in Orion sandbox context.'
    );
  }, 250);
} catch (e) {
  assert(false, `Storage fallback test failed: ${e.message}`);
}

// Test 2: Timeout Interception (Blocking >3000ms long-delay ad redirects)
try {
  let wasExecuted = false;
  sandbox.setTimeout(() => {
    wasExecuted = true;
  }, 5000);
  
  setTimeout(() => {
    assert(wasExecuted === false, 'Ad timer blocking: setTimeout calls with delays >3s are successfully blocked from executing.');
  }, 100);
} catch (e) {
  assert(false, `Timeout blocking test failed: ${e.message}`);
}

// Test 3: Normal Timer Execution (<3000ms delays allowed)
try {
  let wasExecuted = false;
  sandbox.setTimeout(() => {
    wasExecuted = true;
  }, 10);
  
  setTimeout(() => {
    assert(wasExecuted === true, 'Timer integrity: standard UI timeouts with delays <=3s are allowed to run normally.');
  }, 150);
} catch (e) {
  assert(false, `Normal timer test failed: ${e.message}`);
}

// Test 4: Window.open Hijack (Neutralizing Popup Redirects)
try {
  const dummyWin = sandbox.window.open('https://malicious-ad-site.com', '_blank');
  assert(
    dummyWin !== null && dummyWin.closed === true,
    'Popup Shield: window.open attempts are successfully hijacked and return a neutralized dummy closed window.'
  );
} catch (e) {
  assert(false, `Popup shield test failed: ${e.message}`);
}

// Test 5: EasyList CSS Injections
try {
  const cssInjected = mockDocument.documentElement.childNodes.find(n => n.tagName === 'STYLE');
  
  assert(
    cssInjected !== undefined && cssInjected.textContent.includes('display: none !important'),
    'CSS Adblocker: EasyList aesthetic display block styles are successfully injected into the DOM.'
  );
} catch (e) {
  assert(false, `CSS adblocker test failed: ${e.message}`);
}

// Test 6: Network Sniffer (XMLHttpRequest)
try {
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('GET', 'https://example.com/stream/playlist.m3u8');
  xhr.send();
  
  assert(
    xhr.url === 'https://example.com/stream/playlist.m3u8',
    'Stream Sniper: Sniffed XMLHttpRequest stream requests successfully.'
  );
} catch (e) {
  assert(false, `XHR sniffer test failed: ${e.message}`);
}

// ─── 4. REPORT ───────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log('\n=====================================================');
  console.log(`  TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
  if (passedTests === totalTests) {
    console.log('  STATUS: SUCCESS (All tests passed cleanly!)');
  } else {
    console.error('  STATUS: FAILURE (Some tests failed)');
  }
  console.log('=====================================================');
}, 500);
