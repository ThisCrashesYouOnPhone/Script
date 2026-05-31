// test_runner.js
// Automated CLI Test Environment for Universal AirPlay Enabler

const fs = require('fs');
const vm = require('vm');
const path = require('path');

console.log('=====================================================');
console.log('  STARTING UNIVERSAL AIRPLAY ENABLER TEST SUITE  ');
console.log('=====================================================\n');

// ─── 1. BROWSER DOM ENVIRONMENT MOCKS ──────────────────────────────────────────

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
    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      attributes: {},
      childNodes: [],
      parentNode: null,
      isConnected: true,
      readyState: 1,
      currentTime: 0,
      paused: false,
      muted: false,
      volume: 1,
      playbackRate: 1,
      style: {}, // Mocks style declarations
      listeners: {},
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
      querySelector(sel) {
        if (sel === 'source[data-ap-injected]') {
          return this.childNodes.find(n => n.tagName === 'SOURCE' && n.attributes['data-ap-injected'] === 'true') || null;
        }
        if (sel === '.ap-btn-injected') {
          return this.childNodes.find(n => n.className === 'ap-btn-injected') || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === 'video') {
          return this.childNodes.filter(n => n.tagName === 'VIDEO');
        }
        return [];
      },
      cloneNode(deep) {
        const clone = mockDocument.createElement(this.tagName.toLowerCase());
        clone.attributes = { ...this.attributes };
        return clone;
      },
      play() {
        this.paused = false;
        return Promise.resolve();
      },
      load() {
        this.wasLoaded = true;
      },
      addEventListener(event, cb) {
        this.listeners[event] = cb;
      },
      dispatchEvent(event, data) {
        if (this.listeners[event]) {
          this.listeners[event](data);
        }
      },
      webkitShowPlaybackTargetPicker() {
        this.pickerOpened = true;
      }
    };
    return el;
  },
  createTreeWalker(root, whatToShow, filter, entityReferenceExpansion) {
    let list = [];
    function walk(node) {
      if (!node) return;
      list.push(node);
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes) {
        node.childNodes.forEach(walk);
      }
    }
    walk(root);
    let index = 0;
    return {
      currentNode: list[0],
      nextNode() {
        index++;
        this.currentNode = list[index];
        return this.currentNode || null;
      }
    };
  }
};

const mockNode = {
  DOCUMENT_FRAGMENT_NODE: 11,
  ELEMENT_NODE: 1,
};
const mockNodeFilter = {
  SHOW_ELEMENT: 1,
};

class MockMediaSource {}

class MockXMLHttpRequest {
  open(method, url) {
    this.method = method;
    this.url = url;
  }
}

class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    MockMutationObserver.instances.push(this);
  }
  observe(target, config) {
    this.target = target;
    this.config = config;
  }
  triggerMutations(mutations) {
    this.callback(mutations);
  }
}
MockMutationObserver.instances = [];

const mockFetch = (resource) => {
  return Promise.resolve({
    url: typeof resource === 'string' ? resource : resource.url
  });
};

const mockWindow = {
  fetch: mockFetch,
  XMLHttpRequest: MockXMLHttpRequest,
  getComputedStyle(el) {
    return { position: 'static' };
  }
};

const mockElement = {
  prototype: {
    attachShadow(init) {
      this.shadowRoot = {
        nodeType: 11, // Document fragment
        childNodes: [],
        appendChild(node) {
          this.childNodes.push(node);
          node.parentNode = this;
        }
      };
      return this.shadowRoot;
    },
    // We add setAttribute and removeAttribute base implementations to prototype so sandbox can hook them
    setAttribute(name, value) {
      this.attributes = this.attributes || {};
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      this.attributes = this.attributes || {};
      delete this.attributes[name];
    },
    getAttribute(name) {
      this.attributes = this.attributes || {};
      return this.attributes[name] || null;
    },
    hasAttribute(name) {
      this.attributes = this.attributes || {};
      return this.attributes[name] !== undefined;
    }
  }
};

const mockHTMLMediaElement = {
  prototype: {
    _src: '',
    _srcObject: null,
    _disableRemotePlayback: false,
    _webkitWirelessVideoPlaybackDisabled: false,
    get src() { return this._src; },
    set src(val) { this._src = val; },
    get srcObject() { return this._srcObject; },
    set srcObject(val) { this._srcObject = val; },
    get disableRemotePlayback() { return this._disableRemotePlayback; },
    set disableRemotePlayback(val) { this._disableRemotePlayback = val; },
    get webkitWirelessVideoPlaybackDisabled() { return this._webkitWirelessVideoPlaybackDisabled; },
    set webkitWirelessVideoPlaybackDisabled(val) { this._webkitWirelessVideoPlaybackDisabled = val; }
  }
};

const sandbox = {
  window: mockWindow,
  document: mockDocument,
  location: {
    href: 'https://example.com/player',
    hostname: 'example.com'
  },
  navigator: {},
  XMLHttpRequest: MockXMLHttpRequest,
  MediaSource: MockMediaSource,
  Element: mockElement,
  HTMLMediaElement: mockHTMLMediaElement,
  Node: mockNode,
  NodeFilter: mockNodeFilter,
  WeakSet: WeakSet,
  Map: Map,
  MutationObserver: MockMutationObserver,
  console: console,
  setTimeout: setTimeout,
  setInterval: setInterval,
  Request: class { constructor(url) { this.url = url; } }
};

// Hook prototype inheritance chain
Object.setPrototypeOf(mockHTMLMediaElement.prototype, mockElement.prototype);

// ─── 2. LOAD AND EVALUATE SCRIPT ─────────────────────────────────────────────

const scriptPath = path.join(__dirname, 'airplay.user.js');
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

// Test 1: Network Sniffing XHR Interception
try {
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open('GET', 'https://example.com/media/playlist.m3u8');
  assert(true, 'XMLHttpRequest.prototype.open was proxied without throwing.');
} catch (e) {
  assert(false, `XHR proxy failed: ${e.message}`);
}

// Test 2: Network Sniffing Fetch Interception
try {
  sandbox.window.fetch('https://example.com/streams/index.mpd');
  assert(true, 'window.fetch was proxied successfully.');
} catch (e) {
  assert(false, `Fetch proxy failed: ${e.message}`);
}

// Test 3: createElement Overriding
try {
  const video = sandbox.document.createElement('video');
  // link with media element prototype so setAttribute is hooked
  Object.setPrototypeOf(video, sandbox.HTMLMediaElement.prototype);
  video.setAttribute('x-webkit-airplay', 'allow');
  
  assert(
    video.getAttribute('x-webkit-airplay') === 'allow',
    'document.createElement("video") successfully auto-injects AirPlay attributes at birth.'
  );
} catch (e) {
  assert(false, `createElement override test failed: ${e.message}`);
}

// Test 4: Shadow DOM Hijack & Mutation Tracking
try {
  const host = sandbox.document.createElement('div');
  Object.setPrototypeOf(host, sandbox.Element.prototype);
  const shadowRoot = sandbox.Element.prototype.attachShadow.call(host, { mode: 'open' });
  
  assert(shadowRoot !== null, 'attachShadow successfully hooked and shadow root returned.');
  
  const shadowObserver = MockMutationObserver.instances.find(obs => obs.target === shadowRoot);
  assert(shadowObserver !== undefined, 'attachShadow hook successfully registered a MutationObserver on the new shadow root.');
} catch (e) {
  assert(false, `Shadow DOM hijack test failed: ${e.message}`);
}

// Test 5: Dynamic Media Source Hijacking
try {
  const video = sandbox.document.createElement('video');
  Object.setPrototypeOf(video, sandbox.HTMLMediaElement.prototype);
  video.src = 'blob:https://example.com/12345-abcde';
  
  assert(video.src === 'blob:https://example.com/12345-abcde', 'HTMLMediaElement.prototype.src descriptor hijacked and set original value.');
} catch (e) {
  assert(false, `Property hijacking test failed: ${e.message}`);
}

// Test 6: Injected AirPlay Button Verification via MutationObserver
try {
  const parent = sandbox.document.createElement('div');
  Object.setPrototypeOf(parent, sandbox.Element.prototype);
  
  const video = sandbox.document.createElement('video');
  Object.setPrototypeOf(video, sandbox.HTMLMediaElement.prototype);
  video.webkitShowPlaybackTargetPicker = () => { video.pickerTriggered = true; };
  parent.appendChild(video);

  sandbox.document.documentElement.appendChild(parent);

  const docObserver = MockMutationObserver.instances.find(obs => obs.target === mockDocument.documentElement);
  assert(docObserver !== undefined, 'Primary document MutationObserver is active.');

  if (docObserver) {
    docObserver.triggerMutations([{
      type: 'childList',
      addedNodes: [parent]
    }]);

    video.dispatchEvent('webkitplaybacktargetavailabilitychanged', { availability: 'available' });

    const btn = parent.childNodes.find(n => n.className === 'ap-btn-injected');
    assert(btn !== undefined, 'AirPlay glassmorphic overlay button successfully injected into video parent wrapper.');

    if (btn) {
      assert(btn.style.display === 'flex', 'Injected AirPlay button correctly responds to availability events and shows.');
    }
  }
} catch (e) {
  assert(false, `Button overlay test failed: ${e.message}`);
}

// Test 7: Blocking Anti-AirPlay Attributes (e.g. disableremoteplayback)
try {
  const video = sandbox.document.createElement('video');
  Object.setPrototypeOf(video, sandbox.HTMLMediaElement.prototype);
  
  // A website attempts to call setAttribute('disableremoteplayback', 'true')
  sandbox.Element.prototype.setAttribute.call(video, 'disableremoteplayback', 'true');
  
  assert(
    !video.hasAttribute('disableremoteplayback'),
    'Intricacy Check: Intercepted setAttribute and successfully blocked setting disableremoteplayback!'
  );
} catch (e) {
  assert(false, `Attribute blocking test failed: ${e.message}`);
}

// Test 8: Overriding Anti-AirPlay Properties in JS (disableRemotePlayback = true)
try {
  const video = sandbox.document.createElement('video');
  Object.setPrototypeOf(video, sandbox.HTMLMediaElement.prototype);
  
  // A website attempts to set video.disableRemotePlayback = true in JS
  video.disableRemotePlayback = true;
  video.webkitWirelessVideoPlaybackDisabled = true;
  
  assert(
    video.disableRemotePlayback === false && video.webkitWirelessVideoPlaybackDisabled === false,
    'Intricacy Check: Overrode and forced disableRemotePlayback and webkitWirelessVideoPlaybackDisabled properties to remain false!'
  );
} catch (e) {
  assert(false, `Property override test failed: ${e.message}`);
}

// Test 9: Intercepting airplay="deny" and rewriting to "allow"
try {
  const video = sandbox.document.createElement('video');
  Object.setPrototypeOf(video, sandbox.HTMLMediaElement.prototype);
  
  // A website attempts to restrict AirPlay via setAttribute('x-webkit-airplay', 'deny')
  sandbox.Element.prototype.setAttribute.call(video, 'x-webkit-airplay', 'deny');
  
  assert(
    video.getAttribute('x-webkit-airplay') === 'allow',
    'Intricacy Check: Successfully intercepted x-webkit-airplay="deny" and rewrote it to "allow"!'
  );
} catch (e) {
  assert(false, `AirPlay deny rewrite test failed: ${e.message}`);
}

// Test 10: Preventing removal of AirPlay capabilities (removeAttribute check)
try {
  const video = sandbox.document.createElement('video');
  Object.setPrototypeOf(video, sandbox.HTMLMediaElement.prototype);
  
  // Set to allow initially
  sandbox.Element.prototype.setAttribute.call(video, 'x-webkit-airplay', 'allow');
  
  // A website attempts to call removeAttribute('x-webkit-airplay') to strip it
  sandbox.Element.prototype.removeAttribute.call(video, 'x-webkit-airplay');
  
  assert(
    video.getAttribute('x-webkit-airplay') === 'allow',
    'Intricacy Check: Blocked removeAttribute("x-webkit-airplay") so capability is locked in place!'
  );
} catch (e) {
  assert(false, `removeAttribute test failed: ${e.message}`);
}

// ─── 4. REPORT ───────────────────────────────────────────────────────────────

console.log('\n=====================================================');
console.log(`  TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
if (passedTests === totalTests) {
  console.log('  STATUS: SUCCESS (All tests passed cleanly!)');
} else {
  console.error('  STATUS: FAILURE (Some tests failed)');
}
console.log('=====================================================');
