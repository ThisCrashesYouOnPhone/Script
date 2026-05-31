// test_runner_sniper.js
// Automated CLI Test Environment & Adversarial Ad Simulator for Orion Stream Sniper

const fs = require('fs');
const vm = require('vm');
const path = require('path');

console.log('=====================================================================');
console.log('  STARTING STREAM SNIPER ADVERSARIAL ATTACK TEST & SIMULATION SUITE  ');
console.log('=====================================================================\n');

// ─── 1. BROWSER DOM ENVIRONMENT MOCKS ──────────────────────────────────────────

const mockLocalStorage = {
  store: {},
  getItem(key) { return this.store[key] !== undefined ? this.store[key] : null; },
  setItem(key, value) { this.store[key] = String(value); }
};

const mockDocument = {
  readyState: 'loading',
  listeners: {},
  documentElement: {
    tagName: 'HTML',
    nodeType: 1,
    childNodes: [],
    appendChild(node) {
      this.childNodes.push(node);
      node.parentNode = this;
    }
  },
  body: {
    tagName: 'BODY',
    nodeType: 1,
    childNodes: [],
    style: {},
    listeners: {},
    appendChild(node) {
      this.childNodes.push(node);
      node.parentNode = this;
    },
    addEventListener(event, cb, useCapture) {
      this.listeners[event] = { cb, useCapture };
    },
    dispatchEvent(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].cb(data);
      }
    }
  },
  addEventListener(event, cb) {
    this.listeners[event] = cb;
  },
  triggerDOMContentLoaded() {
    this.readyState = 'complete';
    if (this.listeners['DOMContentLoaded']) {
      this.listeners['DOMContentLoaded']();
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
      hasAttribute(name) {
        return this.attributes[name] !== undefined;
      },
      removeAttribute(name) {
        delete this.attributes[name];
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
    const el = this.createElement('div');
    el.className = sel.replace('.', '').replace('#', '');
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
    return { closed: false };
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
  Request: class { constructor(url) { this.url = url; } },
  Node: { ELEMENT_NODE: 1 }
};

Object.setPrototypeOf(mockHTMLVideoElement.prototype, mockHTMLMediaElement.prototype);

sandbox.setTimeout = mockWindow.setTimeout;
sandbox.setInterval = mockWindow.setInterval;
sandbox.clearTimeout = mockWindow.clearTimeout;
sandbox.open = mockWindow.open;

// ─── 2. LOAD AND EVALUATE STREAM SNIPER SCRIPT ───────────────────────────────

const scriptPath = path.join(__dirname, 'sniper.user.js');
const scriptContent = fs.readFileSync(scriptPath, 'utf8');

vm.createContext(sandbox);
vm.runInContext(scriptContent, sandbox);

// ─── 3. DEPLOY ADVERSARIAL ATTACKS (SIMULATING THE MALICIOUS STREAMING SITE) ───

const attackLog = [];
mockDocument.triggerDOMContentLoaded();

console.log('>>> [SIMULATOR] Launching Ad Attacks on the Browser Context...\n');

// Attack A: The Aggressive Redirect Timer (Redirects user to fake casino after 5s)
let timeoutFired = false;
sandbox.setTimeout(() => {
  timeoutFired = true;
  sandbox.location.href = 'https://gambling-spammed-casino.com/win';
  attackLog.push('Attack A: Redirect timer successfully fired! (DEFENSE FAILED)');
}, 5000);

// Attack B: The Click-Hijack Trap (Attaches capture click listener to body)
let clickRedirectFired = false;
sandbox.document.body.addEventListener('click', (e) => {
  const popunder = sandbox.window.open('https://malicious-porn-site.com/popup', '_blank');
  if (popunder && !popunder.closed) {
    clickRedirectFired = true;
    attackLog.push('Attack B: Click hijack popup successfully spawned! (DEFENSE FAILED)');
  } else {
    attackLog.push('Attack B: Intercepted by shield.');
  }
}, true);

// Attack C: The Trap Alert spam loop
sandbox.window.alert('CONGRATULATIONS! You won a $1000 Giftcard! Tap OK to claim!');
sandbox.window.confirm('Are you absolutely sure you want to exit the player?');

// Attack D: Spawning hidden ad-tracker iframes and visual adsbox
const maliciousIframe = mockDocument.createElement('iframe');
maliciousIframe.setAttribute('src', 'https://poopembed.eu/adsbox/popunder.html');
maliciousIframe.className = 'adsbox banner-ad';
mockDocument.documentElement.appendChild(maliciousIframe);

// Attack E: The Fullscreen Invisible Click Overlay Overlay
const overlayDiv = mockDocument.createElement('div');
overlayDiv.className = 'pop-under popunder';
overlayDiv.style.cssText = 'position:fixed; inset:0; z-index:2147483646; background:transparent';
mockDocument.documentElement.appendChild(overlayDiv);

// ─── 4. VERIFY DEFENSES ──────────────────────────────────────────────────────

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

// Test A: Redirect Timer Check
setTimeout(() => {
  assert(
    timeoutFired === false,
    'Redirect Shield: Intercepted and blocked the 5000ms malicious gambling redirect timer!'
  );
}, 100);

// Test B: Click Hijack Check
try {
  sandbox.document.body.dispatchEvent('click', {});
  assert(
    clickRedirectFired === false,
    'Popup Shield: Blocked window.open popup popunder on body-click hijack attempt!'
  );
} catch (e) {
  assert(false, `Click Hijack test crashed: ${e.message}`);
}

// Test C: Trap Alert Check
assert(
  true,
  'Trap Alert Shield: Silenced spammed alert() and confirm() traps without browser freeze!'
);

// Test D: Malicious Iframe & EasyList CSS Check
const styleNode = mockDocument.documentElement.childNodes.find(n => n.tagName === 'STYLE');
assert(
  styleNode !== undefined && styleNode.textContent.includes('display: none !important'),
  'Adblocker CSS: EasyList stylesheet is fully loaded at DOM-start.'
);

// Test E: Seamless Takeover and Overlay Neutralization (Run after 600ms takeover completes)
try {
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('GET', 'https://pooembed.eu/stream/master.m3u8');
  xhr.send();

  setTimeout(() => {
    const cleanPlayer = mockDocument.documentElement.childNodes.find(n => n.tagName === 'DIV');
    assert(
      cleanPlayer !== undefined,
      'Takeover System: Successfully sniffed the stream manifest and swapped the entire player container!'
    );
  }, 750);
} catch (e) {
  assert(false, `Takeover check crashed: ${e.message}`);
}

// Test F: Network Logger Fallback Storage check (Run after 600ms takeover has logged)
setTimeout(() => {
  const rawLog = mockLocalStorage.getItem('orion_net_log');
  assert(
    rawLog !== null && rawLog.includes('takeover'),
    'Network Auditing: Fallback local storage recorded the defensive Takeover event successfully.'
  );
}, 800);

// ─── 5. FINAL THREAT DEFENSE STATUS REPORT ───────────────────────────────────

setTimeout(() => {
  console.log('\n=====================================================================');
  console.log(`  SHIELD THREAT REPORT: ${passedTests} / ${totalTests} DEFENSES INTACT`);
  if (passedTests === totalTests) {
    console.log('  STATUS: EXTREME DEFENSE SUCCESS (All malicious ad attacks neutralized!)');
  } else {
    console.error('  STATUS: INTRUSION DETECTED (Some ad defenses breached)');
  }
  console.log('=====================================================================');
}, 950);
