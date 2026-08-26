import type { WebContents } from "electron";
import log from "electron-log";

/**
 * Anti-detection ("stealth") for the agentic browser. When enabled, every new
 * browser guest gets fingerprint/webdriver patches injected BEFORE any page
 * script runs (CDP Page.addScriptToEvaluateOnNewDocument), so sites that probe
 * for automation see a plausible human browser. Toggled from the renderer via
 * the `jagentdesk:browser:set-stealth` IPC (see stealth-store.ts). This performs
 * real fingerprint normalisation for legitimate automation of the user's own
 * accounts (ADR-0011) — it is not a mock.
 */
let stealthEnabled = false;
const appliedContents = new WeakSet<WebContents>();

export function setStealthEnabled(enabled: boolean): void {
  stealthEnabled = enabled;
}

export function isStealthEnabled(): boolean {
  return stealthEnabled;
}

// Runs in the guest's main world before page scripts. Keeps to well-known,
// low-risk normalisations (no canvas poisoning, which breaks legit sites).
const STEALTH_SOURCE = `(() => {
  try {
    // 1. navigator.webdriver — the #1 automation tell.
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
  } catch (e) {}
  try {
    // 2. window.chrome presence (headless Chromium lacks it).
    if (!window.chrome) { window.chrome = { runtime: {} }; }
  } catch (e) {}
  try {
    // 3. Non-empty languages / plugins. Define on the prototype (the instance
    // property can be non-configurable, which silently defeats an instance-level
    // defineProperty).
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    const fakePlugins = [{ name: 'Chromium PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }];
    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => fakePlugins, configurable: true });
  } catch (e) {}
  try {
    // 4. permissions.query for notifications (headless returns 'denied' oddly).
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission || 'default' })
          : originalQuery(parameters);
    }
  } catch (e) {}
  try {
    // 5. WebGL vendor/renderer — spoof a common real GPU string.
    const patchGL = (proto) => {
      if (!proto) return;
      const getParameter = proto.getParameter;
      proto.getParameter = function (parameter) {
        if (parameter === 37445) { return 'Google Inc. (Apple)'; }        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) { return 'ANGLE (Apple, Apple M-series, OpenGL 4.1)'; } // UNMASKED_RENDERER_WEBGL
        return getParameter.apply(this, arguments);
      };
    };
    patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  } catch (e) {}
  try {
    // 6. Plausible hardware.
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  } catch (e) {}
})();`;

/**
 * Inject the stealth patches into a guest webContents. No-op when stealth is off
 * or already applied. Safe to call from did-attach-webview; the CDP debugger is
 * shared with the automation layer, which guards isAttached() the same way.
 */
export async function applyStealthToWebContents(contents: WebContents): Promise<void> {
  if (!stealthEnabled || appliedContents.has(contents) || contents.isDestroyed()) {
    return;
  }
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    await contents.debugger.sendCommand("Page.enable");
    await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: STEALTH_SOURCE,
    });
    appliedContents.add(contents);
    log.info("[browser-stealth] injected patches", { webContentsId: contents.id });
  } catch (error) {
    log.warn("[browser-stealth] injection failed", {
      webContentsId: contents.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
