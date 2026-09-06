import type { BrowserFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

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

  return `(() => {
  const CFG = ${configLiteral};

  // Make a replacement function report native code, matching name/length so
  // toString/name checks don't expose the patch.
  const native = (fn, name) => {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      const s = 'function ' + name + '() { [native code] }';
      Object.defineProperty(fn, 'toString', {
        value: function toString() { return s; }, configurable: true, writable: true,
      });
    } catch (e) {}
    return fn;
  };
  const define = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: native(getter, 'get ' + prop), configurable: true }); } catch (e) {}
  };

  // 1. navigator.webdriver — the #1 automation tell.
  define(Navigator.prototype, 'webdriver', () => undefined);

  // 2. window.chrome presence (headless Chromium lacks it).
  try { if (!window.chrome) { window.chrome = { runtime: {} }; } } catch (e) {}

  // 3. languages / plugins / platform, defined on the prototype.
  define(Navigator.prototype, 'languages', () => Object.freeze(CFG.languages.slice()));
  define(Navigator.prototype, 'platform', () => CFG.platform);
  const fakePlugins = [
    { name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' },
    { name: 'Microsoft Edge PDF Viewer' }, { name: 'WebKit built-in PDF' },
  ];
  define(Navigator.prototype, 'plugins', () => fakePlugins);

  // 4. permissions.query for notifications (headless returns 'denied' oddly).
  try {
    const q = window.navigator.permissions && window.navigator.permissions.query;
    if (q) {
      const patched = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission || 'default' })
          : q.call(window.navigator.permissions, parameters);
      window.navigator.permissions.query = native(patched, 'query');
    }
  } catch (e) {}

  // 5. WebGL vendor/renderer coherent with the profile OS.
  try {
    const patchGL = (proto) => {
      if (!proto) return;
      const orig = proto.getParameter;
      const patched = function getParameter(parameter) {
        if (parameter === 37445) return CFG.webglVendor;   // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return CFG.webglRenderer;  // UNMASKED_RENDERER_WEBGL
        return orig.apply(this, arguments);
      };
      proto.getParameter = native(patched, 'getParameter');
    };
    patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  } catch (e) {}

  // 6. Plausible hardware.
  define(Navigator.prototype, 'hardwareConcurrency', () => CFG.hardwareConcurrency);
  define(Navigator.prototype, 'deviceMemory', () => CFG.deviceMemory);

  // 7. Screen metrics.
  try {
    define(Screen.prototype, 'width', () => CFG.screen.width);
    define(Screen.prototype, 'height', () => CFG.screen.height);
    define(Screen.prototype, 'availWidth', () => CFG.screen.availWidth);
    define(Screen.prototype, 'availHeight', () => CFG.screen.availHeight);
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
    const noiseData = (data, w, h) => {
      const rng = mulberry32(CFG.canvasSeed ^ (w * 31 + h));
      for (let i = 0; i < data.length; i += 4) {
        if (rng() < 0.02) { data[i] = data[i] ^ 1; data[i + 1] = data[i + 1] ^ 1; data[i + 2] = data[i + 2] ^ 1; }
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
    HTMLCanvasElement.prototype.toDataURL = native(function toDataURL() {
      try { return origToDataURL.apply(noisedClone(this), arguments); } catch (e) { return origToDataURL.apply(this, arguments); }
    }, 'toDataURL');
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    if (origToBlob) {
      HTMLCanvasElement.prototype.toBlob = native(function toBlob() {
        try { return origToBlob.apply(noisedClone(this), arguments); } catch (e) { return origToBlob.apply(this, arguments); }
      }, 'toBlob');
    }
    CanvasRenderingContext2D.prototype.getImageData = native(function getImageData(x, y, w, h) {
      const img = origGetImageData.apply(this, arguments);
      try { noiseData(img.data, w, h); } catch (e) {}
      return img;
    }, 'getImageData');
  } catch (e) {}

  // 9. Audio noise — tiny seeded per-sample perturbation on the read-back path.
  try {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = native(function getChannelData(channel) {
      const data = origGetChannelData.apply(this, arguments);
      try {
        const rng = mulberry32(CFG.audioSeed ^ (channel + 1));
        for (let i = 0; i < data.length; i += 100) { data[i] = data[i] + (rng() - 0.5) * 1e-7; }
      } catch (e) {}
      return data;
    }, 'getChannelData');
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
