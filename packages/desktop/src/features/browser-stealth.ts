import type { WebContents } from "electron";
import log from "electron-log";
import type { BrowserFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import { buildFingerprintInitScript } from "./browser-fingerprint-script.js";

/**
 * Anti-detection ("stealth") for the agentic browser. Every new browser guest gets
 * fingerprint/webdriver patches injected BEFORE any page script runs (CDP
 * Page.addScriptToEvaluateOnNewDocument), plus UA / UA-CH / timezone / locale
 * applied at the engine boundary (CDP Network/Emulation overrides), so sites that
 * probe for automation see the selected profile's identity. This is real
 * fingerprint normalisation for legitimate automation of the user's own accounts
 * (ADR-0011) — not a mock.
 *
 * Two layers, profile-first:
 *  - An ACTIVE fingerprint profile (set from the daemon config via the renderer)
 *    drives a coherent identity — the primary path.
 *  - A legacy global on/off toggle (`setStealthEnabled`) still works as a fallback
 *    with a fixed built-in fingerprint, for builds/users without a profile selected.
 *
 * A profile change takes effect on newly-attached guests / next navigations.
 */
let stealthEnabled = false;
let activeProfile: BrowserFingerprintProfile | null = null;
const appliedContents = new WeakSet<WebContents>();

export function setStealthEnabled(enabled: boolean): void {
  stealthEnabled = enabled;
}

export function isStealthEnabled(): boolean {
  return stealthEnabled;
}

export function setActiveFingerprintProfile(profile: BrowserFingerprintProfile | null): void {
  activeProfile = profile;
}

export function getActiveFingerprintProfile(): BrowserFingerprintProfile | null {
  return activeProfile;
}

// Legacy fixed fingerprint, used only when no profile is active but the global
// toggle is on. Runs in the guest's main world before page scripts.
const STEALTH_SOURCE = `(() => {
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true }); } catch (e) {}
  try { if (!window.chrome) { window.chrome = { runtime: {} }; } } catch (e) {}
  try {
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    const fakePlugins = [{ name: 'Chromium PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }];
    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => fakePlugins, configurable: true });
  } catch (e) {}
  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission || 'default' })
          : originalQuery(parameters);
    }
  } catch (e) {}
  try {
    const patchGL = (proto) => {
      if (!proto) return;
      const getParameter = proto.getParameter;
      proto.getParameter = function (parameter) {
        if (parameter === 37445) { return 'Google Inc. (Apple)'; }
        if (parameter === 37446) { return 'ANGLE (Apple, Apple M-series, OpenGL 4.1)'; }
        return getParameter.apply(this, arguments);
      };
    };
    patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  } catch (e) {}
})();`;

/** UA-CH metadata shape for CDP Network.setUserAgentOverride. */
function buildUserAgentMetadata(profile: BrowserFingerprintProfile): Record<string, unknown> {
  const ch = profile.uaClientHints;
  const chromeFull =
    ch.fullVersionList.find((b) => b.brand === "Google Chrome")?.version ??
    ch.fullVersionList[0]?.version ??
    "";
  return {
    brands: ch.brands,
    fullVersionList: ch.fullVersionList,
    fullVersion: chromeFull,
    platform: ch.platform,
    platformVersion: ch.platformVersion,
    architecture: ch.architecture,
    model: ch.model,
    mobile: ch.mobile,
    bitness: ch.bitness,
    wow64: false,
  };
}

/**
 * Apply engine-level overrides (UA + UA Client Hints, timezone, locale) via CDP.
 * These are less detectable than JS monkey-patching because they change the value
 * at the browser boundary — the init script only covers surfaces CDP can't. We do
 * NOT force device-metrics (it would resize the visible guest); screen.* is spoofed
 * in the init script instead.
 */
async function applyProfileCdpOverrides(
  contents: WebContents,
  profile: BrowserFingerprintProfile,
): Promise<void> {
  try {
    await contents.debugger.sendCommand("Network.enable");
    await contents.debugger.sendCommand("Network.setUserAgentOverride", {
      userAgent: profile.userAgent,
      acceptLanguage: profile.acceptLanguage,
      platform: navigatorPlatform(profile),
      userAgentMetadata: buildUserAgentMetadata(profile),
    });
  } catch (error) {
    logWarn("ua-override failed", contents, error);
  }
  try {
    await contents.debugger.sendCommand("Emulation.setTimezoneOverride", {
      timezoneId: profile.timezone,
    });
  } catch (error) {
    logWarn("timezone-override failed", contents, error);
  }
  try {
    await contents.debugger.sendCommand("Emulation.setLocaleOverride", {
      locale: profile.locale,
    });
  } catch (error) {
    logWarn("locale-override failed", contents, error);
  }
}

// WebRTC can leak the real public IP via STUN/UDP even behind an HTTP proxy.
// `force-proxy` restricts ICE to proxy-reachable candidates; `disable` also
// neutralises RTCPeerConnection in the page so no candidate is gathered.
function applyWebRtcPolicy(contents: WebContents, profile: BrowserFingerprintProfile): void {
  try {
    if (profile.webrtcPolicy === "force-proxy") {
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    } else if (profile.webrtcPolicy === "disable") {
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      void contents.debugger
        .sendCommand("Page.addScriptToEvaluateOnNewDocument", {
          source:
            "(() => { try { const N = () => { throw new DOMException('WebRTC disabled', 'NotAllowedError'); };" +
            " window.RTCPeerConnection = N; window.webkitRTCPeerConnection = N; } catch (e) {} })();",
        })
        .catch(() => {});
    }
  } catch (error) {
    logWarn("webrtc-policy failed", contents, error);
  }
}

function navigatorPlatform(profile: BrowserFingerprintProfile): string {
  switch (profile.os) {
    case "windows":
      return "Win32";
    case "macos":
      return "MacIntel";
    case "linux":
      return "Linux x86_64";
  }
}

/**
 * Inject stealth into a guest webContents. Profile-first: applies the active
 * profile's fingerprint init script + engine overlays + the profile's custom init
 * scripts; otherwise falls back to the legacy global toggle. No-op when neither is
 * active or already applied. Safe from did-attach-webview.
 */
export async function applyStealthToWebContents(contents: WebContents): Promise<void> {
  if (appliedContents.has(contents) || contents.isDestroyed()) {
    return;
  }
  const profile = activeProfile;
  const useProfile = profile !== null && profile.stealthEnabled;
  if (!useProfile && !stealthEnabled) {
    return;
  }
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    await contents.debugger.sendCommand("Page.enable");

    if (useProfile && profile) {
      await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: buildFingerprintInitScript(profile),
      });
      for (const custom of profile.initScripts) {
        if (typeof custom === "string" && custom.trim().length > 0) {
          await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: custom,
          });
        }
      }
      await applyProfileCdpOverrides(contents, profile);
      applyWebRtcPolicy(contents, profile);
      appliedContents.add(contents);
      log.info("[browser-stealth] applied profile", {
        webContentsId: contents.id,
        profileId: profile.id,
      });
      return;
    }

    await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: STEALTH_SOURCE,
    });
    appliedContents.add(contents);
    log.info("[browser-stealth] injected legacy patches", { webContentsId: contents.id });
  } catch (error) {
    logWarn("injection failed", contents, error);
  }
}

function logWarn(message: string, contents: WebContents, error: unknown): void {
  log.warn(`[browser-stealth] ${message}`, {
    webContentsId: contents.id,
    error: error instanceof Error ? error.message : String(error),
  });
}
