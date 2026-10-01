import { randomUUID } from "node:crypto";
import type { BrowserFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

/**
 * Registers patched functions with the `Function.prototype.toString` proxy installed by
 * {@link CHROME_SHIM_SOURCE}. Random per app run, so a page cannot register or probe it.
 */
const NATIVE_TOKEN = JSON.stringify(randomUUID());

/**
 * In-page helpers shared by the injected scripts. `native(fn, name)` makes
 * `Function.prototype.toString.call(fn)` report "function name() { [native code] }"
 * without giving the function an own `toString` (itself a tell); `method` builds a
 * replacement without a `prototype` and with the original `length`, like a native method;
 * `define` installs a prototype getter with the original descriptor's shape.
 */
const NATIVE_HELPERS = `
  const native = (fn, name) => {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) {}
    try { Function.prototype.toString.call(fn, ${NATIVE_TOKEN}, name); } catch (e) {}
    return fn;
  };
  const method = (name, length, impl) => {
    const fn = ({ [name](...args) { return impl.apply(this, args); } })[name];
    try { Object.defineProperty(fn, 'length', { value: length, configurable: true }); } catch (e) {}
    return native(fn, name);
  };
  const define = (obj, prop, getter) => {
    try {
      const original = Object.getOwnPropertyDescriptor(obj, prop);
      const holder = { get [prop]() { return getter(); } };
      const get = native(Object.getOwnPropertyDescriptor(holder, prop).get, 'get ' + prop);
      Object.defineProperty(obj, prop, {
        get,
        set: original ? original.set : undefined,
        enumerable: original ? original.enumerable : true,
        configurable: true,
      });
    } catch (e) {}
  };
`;

/**
 * Replaces `Function.prototype.toString` with a proxy that answers "[native code]" for
 * registered functions (and for itself). Runs first in every document.
 */
const TO_STRING_PRELUDE = `
  (() => {
    const strings = new WeakMap();
    const original = Function.prototype.toString;
    const proxy = new Proxy(original, {
      apply(target, self, args) {
        if (args[0] === ${NATIVE_TOKEN} && typeof self === 'function') {
          strings.set(self, 'function ' + args[1] + '() { [native code] }');
          return '';
        }
        const text = strings.get(self);
        return text !== undefined ? text : Reflect.apply(target, self, args);
      },
    });
    strings.set(proxy, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      value: proxy, writable: true, enumerable: false, configurable: true,
    });
  })();
`;

/**
 * Compile a coherent fingerprint-spoofing init script from a profile. The result
 * is injected into every browser guest's MAIN WORLD before any page script runs
 * (CDP Page.addScriptToEvaluateOnNewDocument), so a page that probes for automation
 * sees the profile's identity instead of the host's real one.
 *
 * Design rules that keep this from being MORE detectable than doing nothing (see
 * the anti-detect brief in the plan doc):
 *  - Every override reports native code from `.toString()` (detectors compare
 *    `fn.toString()` against "function x() { [native code] }").
 *  - Canvas/audio noise is DETERMINISTIC per profile seed — stable within a
 *    session (real browsers are stable) but distinct across profiles. Never
 *    per-call random (two reads of the same pixels must match).
 *  - Noise is sparse and ±1 LSB, so it doesn't break legitimate rendering.
 *  - UA string, UA Client Hints, timezone and locale are applied at the ENGINE
 *    boundary via CDP overrides (Network.setUserAgentOverride /
 *    Emulation.setTimezoneOverride), NOT here — engine-level is less detectable
 *    than monkey-patching navigator in JS, and this script only covers what CDP
 *    can't.
 */
export function buildFingerprintInitScript(profile: BrowserFingerprintProfile): string {
  // Only the fields the in-page script needs; embedded as a JSON literal so no
  // profile value can break out of the string context.
  const config = {
    languages: profile.languages,
    platform: uaPlatformToNavigatorPlatform(profile.os),
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory: profile.deviceMemory,
    webglVendor: profile.webglVendor,
    webglRenderer: profile.webglRenderer,
    canvasSeed: profile.canvasNoiseSeed >>> 0,
    audioSeed: profile.audioNoiseSeed >>> 0,
    screen: profile.screen,
  };
  const configLiteral = JSON.stringify(config);

  return `${TO_STRING_PRELUDE}
(() => {
  const CFG = ${configLiteral};

${NATIVE_HELPERS}
  // 1. navigator.webdriver — the #1 automation tell. A browser nobody automates reports
  //    false (undefined/null is itself a tell). The engine already reports false in agentic
  //    tabs; patching it anyway is a detectable lie, so only a wrong value is replaced.
  if (navigator.webdriver !== false) define(Navigator.prototype, 'webdriver', () => false);

  // 2. window.chrome.loadTimes/csi/app: see CHROME_SHIM_SOURCE (injected for every identity).

  // 3. languages / plugins / platform, defined on the prototype.
  define(Navigator.prototype, 'languages', () => Object.freeze(CFG.languages.slice()));
  define(Navigator.prototype, 'platform', () => CFG.platform);
  // The engine already exposes Chrome's five PDF plugins as real Plugin objects; plain
  // objects would fail instanceof checks, so only fill in when the list is empty.
  if (!navigator.plugins || navigator.plugins.length === 0) {
    const fakePlugins = [
      { name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' },
      { name: 'Microsoft Edge PDF Viewer' }, { name: 'WebKit built-in PDF' },
    ];
    define(Navigator.prototype, 'plugins', () => fakePlugins);
  }

  // 4. permissions.query for notifications (headless returns 'denied' oddly).
  try {
    const proto = window.Permissions && window.Permissions.prototype;
    const q = proto && proto.query;
    if (q) {
      proto.query = method('query', q.length, function (parameters) {
        return parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission || 'default' })
          : q.call(this, parameters);
      });
    }
  } catch (e) {}

  // 5. WebGL vendor/renderer coherent with the profile OS.
  try {
    const patchGL = (proto) => {
      // Empty strings: the profile runs on its own OS and reports the real GPU.
      if (!proto || !CFG.webglVendor || !CFG.webglRenderer) return;
      const orig = proto.getParameter;
      proto.getParameter = method('getParameter', orig.length, function (parameter) {
        if (parameter === 37445) return CFG.webglVendor;   // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return CFG.webglRenderer;  // UNMASKED_RENDERER_WEBGL
        return orig.apply(this, arguments);
      });
    };
    patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  } catch (e) {}

  // 6. Plausible hardware.
  define(Navigator.prototype, 'hardwareConcurrency', () => CFG.hardwareConcurrency);
  define(Navigator.prototype, 'deviceMemory', () => CFG.deviceMemory);

  // 7. Screen metrics. A screen smaller than the browser window is impossible on a real
  //    device, so the profile's size is used only while the window fits in it.
  try {
    const realScreen = {};
    for (const key of ['width', 'height', 'availWidth', 'availHeight']) {
      const d = Object.getOwnPropertyDescriptor(Screen.prototype, key);
      realScreen[key] = d && d.get;
    }
    const fits = () =>
      (window.outerWidth || 0) <= CFG.screen.width && (window.outerHeight || 0) <= CFG.screen.height;
    const screenValue = (key) => function () {
      return fits() || !realScreen[key] ? CFG.screen[key] : realScreen[key].call(this);
    };
    for (const key of ['width', 'height', 'availWidth', 'availHeight']) {
      const value = screenValue(key);
      define(Screen.prototype, key, function () { return value.call(screen); });
    }
    define(Screen.prototype, 'colorDepth', () => CFG.screen.colorDepth);
    define(Screen.prototype, 'pixelDepth', () => CFG.screen.colorDepth);
  } catch (e) {}

  // Seeded PRNG (mulberry32) — deterministic per-profile noise; never the ambient RNG.
  const mulberry32 = (a) => () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // 8. Canvas noise — perturb a sparse subset of pixels by ±1 LSB. The read-back
  // paths (toDataURL/toBlob) render to an OFFSCREEN copy and noise that, leaving the
  // real canvas untouched (so visible rendering isn't corrupted); getImageData
  // returns a noised copy. Both use origGetImageData so the noise is applied exactly
  // once (calling the patched getImageData here would XOR the same seeded pixels
  // twice and cancel out).
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    // Only edge pixels (different from their left neighbour) are touched: a solid fill must
    // read back exactly, or a page that draws one and checks it spots the noise.
    const noiseData = (data, w, h) => {
      const rng = mulberry32(CFG.canvasSeed ^ (w * 31 + h));
      for (let i = 4; i < data.length; i += 4) {
        const edge = data[i] !== data[i - 4] || data[i + 1] !== data[i - 3] || data[i + 2] !== data[i - 2];
        if (rng() < 0.02 && edge) { data[i] = data[i] ^ 1; data[i + 1] = data[i + 1] ^ 1; data[i + 2] = data[i + 2] ^ 1; }
      }
    };
    // A noised offscreen clone of a canvas; the original is never mutated.
    const noisedClone = (canvas) => {
      const w = canvas.width, h = canvas.height;
      const copy = document.createElement('canvas');
      copy.width = w; copy.height = h;
      const cctx = copy.getContext('2d');
      cctx.drawImage(canvas, 0, 0);
      const img = origGetImageData.call(cctx, 0, 0, w, h);
      noiseData(img.data, w, h);
      cctx.putImageData(img, 0, 0);
      return copy;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = method('toDataURL', origToDataURL.length, function () {
      try { return origToDataURL.apply(noisedClone(this), arguments); } catch (e) { return origToDataURL.apply(this, arguments); }
    });
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    if (origToBlob) {
      HTMLCanvasElement.prototype.toBlob = method('toBlob', origToBlob.length, function () {
        try { return origToBlob.apply(noisedClone(this), arguments); } catch (e) { return origToBlob.apply(this, arguments); }
      });
    }
    CanvasRenderingContext2D.prototype.getImageData = method('getImageData', origGetImageData.length, function (x, y, w, h) {
      const img = origGetImageData.apply(this, arguments);
      try { noiseData(img.data, w, h); } catch (e) {}
      return img;
    });
  } catch (e) {}

  // 9. Audio noise — tiny seeded per-sample perturbation on the read-back path.
  try {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = method('getChannelData', origGetChannelData.length, function (channel) {
      const data = origGetChannelData.apply(this, arguments);
      try {
        const rng = mulberry32(CFG.audioSeed ^ (channel + 1));
        // Silence stays silent: only non-zero samples are nudged.
        for (let i = 0; i < data.length; i += 100) { if (data[i] !== 0) data[i] = data[i] + (rng() - 0.5) * 1e-7; }
      } catch (e) {}
      return data;
    });
  } catch (e) {}
})();`;
}

// Chrome freezes navigator.platform to a fixed token per OS family.
function uaPlatformToNavigatorPlatform(os: BrowserFingerprintProfile["os"]): string {
  switch (os) {
    case "windows":
      return "Win32";
    case "macos":
      return "MacIntel";
    case "linux":
      return "Linux x86_64";
  }
}

/**
 * `window.chrome.loadTimes()`, `chrome.csi()` and `chrome.app` exist in every desktop Chrome
 * but not in Electron. Fingerprinting scripts call them (iphey's check "i24" threw
 * "window[x][y] is not a function" and aborted), so their absence is both a tell and a
 * breakage. Values come from the page's own navigation timing; functions report native code.
 */
export const CHROME_SHIM_SOURCE = `
(() => {
  try {
    // No Function.prototype.toString patch here: that proxy is itself detectable. Bound
    // functions already print "function () { [native code] }", which is exactly what
    // Chrome's chrome.loadTimes / chrome.csi print (anonymous, length 0, with a prototype).
    const anonymousNative = (fn) => {
      const bound = fn.bind(null);
      Object.defineProperty(bound, 'name', { value: '', configurable: true });
      Object.defineProperty(bound, 'prototype', { value: {}, writable: true });
      return bound;
    };
    const nativeFn = (fn, name) => {
      const bound = fn.bind(null);
      Object.defineProperty(bound, 'name', { value: name, configurable: true });
      return bound;
    };
    const chrome = window.chrome || (window.chrome = {});
    const nav = () => (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
    const origin = performance.timeOrigin / 1000;
    const at = (ms) => (ms > 0 ? origin + ms / 1000 : 0);
    const paint = () => {
      const entry = performance.getEntriesByType && performance.getEntriesByType('paint').find((p) => p.name === 'first-paint');
      return entry ? at(entry.startTime) : 0;
    };
    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = anonymousNative(function loadTimes() {
        const n = nav();
        const protocol = (n && n.nextHopProtocol) || 'http/1.1';
        return {
          requestTime: at(n ? n.requestStart : 0),
          startLoadTime: origin,
          commitLoadTime: at(n ? n.responseStart : 0),
          finishDocumentLoadTime: at(n ? n.domContentLoadedEventEnd : 0),
          finishLoadTime: at(n ? n.loadEventEnd : 0),
          firstPaintTime: paint(),
          firstPaintAfterLoadTime: 0,
          navigationType: (n && n.type === 'reload') ? 'Reload' : 'Other',
          wasFetchedViaSpdy: protocol === 'h2' || protocol === 'h3',
          wasNpnNegotiated: protocol === 'h2' || protocol === 'h3',
          npnNegotiatedProtocol: protocol === 'http/1.1' ? 'unknown' : protocol,
          wasAlternateProtocolAvailable: false,
          connectionInfo: protocol,
        };
      });
    }
    if (typeof chrome.csi !== 'function') {
      chrome.csi = anonymousNative(function csi() {
        const n = nav();
        return {
          startE: Math.round(performance.timeOrigin),
          onloadT: Math.round(performance.timeOrigin + (n ? n.domContentLoadedEventEnd : 0)),
          pageT: performance.now(),
          tran: (n && n.type === 'reload') ? 1 : 15,
        };
      });
    }
    if (!chrome.app) {
      const InstallState = { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' };
      const RunningState = { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' };
      chrome.app = {
        isInstalled: false,
        InstallState,
        RunningState,
        getDetails: nativeFn(function getDetails() { return null; }, 'getDetails'),
        getIsInstalled: nativeFn(function getIsInstalled() { return false; }, 'getIsInstalled'),
        installState: nativeFn(function installState(cb) { if (typeof cb === 'function') cb(InstallState.NOT_INSTALLED); }, 'installState'),
        runningState: nativeFn(function runningState() { return RunningState.CANNOT_RUN; }, 'runningState'),
      };
    }
  } catch (e) {}
})();`;
