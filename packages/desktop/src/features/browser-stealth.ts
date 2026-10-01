import { app, type Session, type WebContents } from "electron";
import log from "electron-log";
import type { BrowserFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import { buildFingerprintInitScript, CHROME_SHIM_SOURCE } from "./browser-fingerprint-script.js";

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
 * The identity is applied before a guest's first request (main.ts holds the guest's
 * initial URL until applyStealthToWebContents resolves) and re-applied to every open
 * guest when the profile changes (reapplyStealthToGuests). Cross-site iframes and
 * dedicated workers run as separate CDP targets and get the same overrides through
 * Target.setAutoAttach.
 */
let stealthEnabled = false;
let activeProfile: BrowserFingerprintProfile | null = null;

export function setStealthEnabled(enabled: boolean): void {
  stealthEnabled = enabled;
}

export function isStealthEnabled(): boolean {
  return stealthEnabled;
}

export function setActiveFingerprintProfile(profile: BrowserFingerprintProfile | null): void {
  activeProfile = profile;
  markIdentityKnown();
}

/**
 * The app sends the active profile (or `null`) once it reaches the daemon. Until then a
 * guest restored at startup would load with no identity, and anything it starts — a shared
 * worker in particular — keeps that identity. Guests wait for it, at most IDENTITY_WAIT_MS
 * (the daemon may be unreachable).
 */
const IDENTITY_WAIT_MS = 5_000;
let markIdentityKnown: () => void = () => undefined;
const identityKnown = new Promise<void>((resolve) => {
  markIdentityKnown = resolve;
});
let identityResolved = false;
void identityKnown.then(() => {
  identityResolved = true;
  return undefined;
});

function waitForIdentity(): Promise<void> {
  return Promise.race([
    identityKnown,
    new Promise<void>((resolve) => setTimeout(resolve, IDENTITY_WAIT_MS).unref?.()),
  ]);
}

export function getActiveFingerprintProfile(): BrowserFingerprintProfile | null {
  return activeProfile;
}

// Legacy fixed fingerprint, used only when no profile is active but the global
// toggle is on. Runs in the guest's main world before page scripts.
const STEALTH_SOURCE = `(() => {
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
  try {
    Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const fakePlugins = [{ name: 'Chromium PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }];
      Object.defineProperty(Navigator.prototype, 'plugins', { get: () => fakePlugins, configurable: true });
    }
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

/** The Chromium version this Electron build runs, e.g. "146.0.7680.179". */
const ENGINE_CHROME_VERSION = process.versions.chrome ?? "";

const CHROME_BRANDS = new Set(["Chromium", "Google Chrome"]);

/**
 * Present the engine's real Chrome version. A profile generated for an older Chrome
 * would contradict the features the page can detect, so the UA's Chrome major and the
 * Chrome brands in UA Client Hints follow the running engine. The OS identity is kept.
 */
export function alignProfileWithEngine(
  profile: BrowserFingerprintProfile,
  engineVersion: string = ENGINE_CHROME_VERSION,
): BrowserFingerprintProfile {
  const major = engineVersion.split(".")[0];
  if (!major) {
    return profile;
  }
  const hints = profile.uaClientHints;
  return {
    ...profile,
    userAgent: profile.userAgent.replace(/Chrome\/\d+(?:\.\d+){3}/, `Chrome/${major}.0.0.0`),
    uaClientHints: {
      ...hints,
      brands: hints.brands.map((entry) => ({
        brand: entry.brand,
        version: CHROME_BRANDS.has(entry.brand) ? major : entry.version,
      })),
      fullVersionList: hints.fullVersionList.map((entry) => ({
        brand: entry.brand,
        version: CHROME_BRANDS.has(entry.brand) ? engineVersion : entry.version,
      })),
    },
  };
}

/**
 * The User-Agent a desktop Chrome of this engine sends: Electron's default without the
 * app and Electron tokens, with the reduced "Chrome/<major>.0.0.0" form.
 */
export function browserUserAgentFromElectron(electronUserAgent: string): string {
  return (
    electronUserAgent
      // App tokens sit between "(KHTML, like Gecko)" and "Chrome/": "JAgentDesk/x" in a
      // packaged app, the package name ("@jagentdesk/desktop/x") in development.
      .replace(/(\(KHTML, like Gecko\))\s+.*?\s*(Chrome\/)/, "$1 $2")
      .replace(/\s+Electron\/\S+/g, "")
      .replace(/Chrome\/(\d+)(?:\.\d+){3}/, "Chrome/$1.0.0.0")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/**
 * Electron's own User-Agent, read before {@link applySessionIdentity} changes the process
 * default. The app window keeps it.
 */
export const ELECTRON_USER_AGENT = app.userAgentFallback;

function defaultBrowserUserAgent(): string {
  return browserUserAgentFromElectron(ELECTRON_USER_AGENT);
}

type UaMetadata = ReturnType<typeof buildUserAgentMetadata>;

function hostChPlatform(): { platform: string; navigatorPlatform: string } {
  switch (process.platform) {
    case "win32":
      return { platform: "Windows", navigatorPlatform: "Win32" };
    case "darwin":
      return { platform: "macOS", navigatorPlatform: "MacIntel" };
    default:
      return { platform: "Linux", navigatorPlatform: "Linux x86_64" };
  }
}

/**
 * Client Hints for the host's real platform with Chrome brands, matching the plain Chrome
 * UA used without a profile (Electron's own brand list omits "Google Chrome").
 */
export function hostUserAgentMetadata(
  engineVersion: string = ENGINE_CHROME_VERSION,
  systemVersion: string = typeof process.getSystemVersion === "function"
    ? process.getSystemVersion()
    : "",
): UaMetadata {
  const major = engineVersion.split(".")[0] ?? "";
  return {
    brands: [
      { brand: "Chromium", version: major },
      { brand: "Google Chrome", version: major },
      { brand: "Not=A?Brand", version: "24" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: engineVersion },
      { brand: "Google Chrome", version: engineVersion },
      { brand: "Not=A?Brand", version: "24.0.0.0" },
    ],
    fullVersion: engineVersion,
    platform: hostChPlatform().platform,
    platformVersion: systemVersion,
    architecture: process.arch === "arm64" ? "arm" : "x86",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
  };
}

/**
 * The low-entropy Client Hints headers a real Chrome sends on every secure request. Electron
 * sends them on subresource requests but never on navigations, which no real Chrome does.
 */
export function navigationClientHintHeaders(metadata: UaMetadata): Record<string, string> {
  const brands = (metadata.brands as Array<{ brand: string; version: string }>)
    .map((entry) => `"${entry.brand}";v="${entry.version}"`)
    .join(", ");
  return {
    "Sec-CH-UA": brands,
    "Sec-CH-UA-Mobile": metadata.mobile ? "?1" : "?0",
    "Sec-CH-UA-Platform": `"${String(metadata.platform)}"`,
  };
}

function isPotentiallyTrustworthy(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Current identity's UA metadata: the profile's, or the host's without one. */
function currentUserAgentMetadata(): UaMetadata {
  const profile = effectiveProfile();
  return profile ? buildUserAgentMetadata(profile) : hostUserAgentMetadata();
}

/** Add Client Hints to navigation requests of the agentic-browser session (see above). */
export function installNavigationClientHints(browserSession: Session): void {
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const navigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    const headers = details.requestHeaders;
    const present = Object.keys(headers).some((name) => name.toLowerCase() === "sec-ch-ua");
    if (!navigation || present || !isPotentiallyTrustworthy(details.url)) {
      callback({ requestHeaders: headers });
      return;
    }
    callback({
      requestHeaders: { ...headers, ...navigationClientHintHeaders(currentUserAgentMetadata()) },
    });
  });
}

/**
 * Chromium expands the language list it is given into an Accept-Language header with its
 * own q-values, and derives navigator.languages from it; the profile stores the header
 * form ("en-US,en;q=0.9"), so the q-values are dropped here.
 */
export function acceptLanguageList(acceptLanguage: string): string {
  return acceptLanguage
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim() ?? "")
    .filter((entry) => entry.length > 0)
    .join(",");
}

/** The profile in effect, aligned with the engine, or null when no profile stealth applies. */
const HOST_OS: Partial<Record<NodeJS.Platform, BrowserFingerprintProfile["os"]>> = {
  darwin: "macos",
  win32: "windows",
  linux: "linux",
};

/**
 * WebGL exposes more than the vendor/renderer strings (extensions, limits, rendered pixels),
 * and strict checkers compare them: claiming another GPU was flagged as masking by PixelScan
 * even for a macOS profile on a Mac. When the profile's OS is the host's, the real GPU is
 * reported (empty strings = no WebGL patch); a cross-OS profile has to claim a GPU of its OS.
 */
export function alignProfileWithHost(
  profile: BrowserFingerprintProfile,
  platform: NodeJS.Platform = process.platform,
): BrowserFingerprintProfile {
  if (HOST_OS[platform] !== profile.os) return profile;
  return { ...profile, webglVendor: "", webglRenderer: "" };
}

function effectiveProfile(): BrowserFingerprintProfile | null {
  return activeProfile && activeProfile.stealthEnabled
    ? alignProfileWithHost(alignProfileWithEngine(activeProfile))
    : null;
}

/**
 * Session-wide identity for the agentic-browser partition. Covers every request from
 * every frame and worker, including the very first one: the profile's UA and
 * Accept-Language, or a plain Chrome UA (no "JAgentDesk"/"Electron" tokens) without one.
 */
export function applySessionIdentity(browserSession: Session): void {
  const profile = effectiveProfile();
  const userAgent = profile ? profile.userAgent : defaultBrowserUserAgent();
  if (profile) {
    browserSession.setUserAgent(userAgent, acceptLanguageList(profile.acceptLanguage));
  } else {
    browserSession.setUserAgent(userAgent);
  }
  // Shared workers are not CDP children of the page, and their navigator.userAgent comes
  // from the process default, not the session ("JAgentDesk/… Electron/…"). The app window
  // pins ELECTRON_USER_AGENT, so only agentic guests see this.
  app.userAgentFallback = userAgent;
}

/**
 * Permissions that reveal the machine behind the identity (device names, location, local
 * fonts, real screens) or open hardware. Electron grants every permission by default; an
 * agentic tab is refused them, like a browser where the user never clicked "Allow".
 */
const DENIED_GUEST_PERMISSIONS = new Set<string>([
  "media",
  "geolocation",
  "display-capture",
  "local-fonts",
  "window-management",
  "hid",
  "serial",
  "usb",
  "midiSysex",
  "idle-detection",
  "speaker-selection",
]);

export function isGuestPermissionAllowed(permission: string): boolean {
  return !DENIED_GUEST_PERMISSIONS.has(permission);
}

export function installGuestPermissionPolicy(browserSession: Session): void {
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isGuestPermissionAllowed(permission));
  });
  browserSession.setPermissionCheckHandler((_contents, permission) =>
    isGuestPermissionAllowed(permission),
  );
}

type SendCommand = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown> | undefined>;

function commandSender(contents: WebContents, sessionId?: string): SendCommand {
  return async (method, params) =>
    (await contents.debugger.sendCommand(method, params, sessionId)) as
      | Record<string, unknown>
      | undefined;
}

/**
 * Engine-level overrides (UA + UA Client Hints + navigator.platform, timezone, locale).
 * Less detectable than JS monkey-patching because they change the value at the browser
 * boundary; the init script only covers surfaces CDP can't. Without a profile the
 * overrides are reset (plain Chrome UA, host timezone and locale). Device metrics are
 * NOT forced (it would resize the visible guest); screen.* is spoofed in the init script.
 */
async function applyIdentityOverrides(
  send: SendCommand,
  profile: BrowserFingerprintProfile | null,
  onError: (message: string, error: unknown) => void,
  options: { locale: boolean } = { locale: true },
): Promise<void> {
  try {
    await send("Network.enable");
    await send(
      "Network.setUserAgentOverride",
      profile
        ? {
            userAgent: profile.userAgent,
            acceptLanguage: acceptLanguageList(profile.acceptLanguage),
            platform: navigatorPlatform(profile),
            userAgentMetadata: buildUserAgentMetadata(profile),
          }
        : {
            userAgent: defaultBrowserUserAgent(),
            // Without it the override resets Accept-Language to "en-US" while
            // navigator.languages keeps the system list.
            acceptLanguage: app.getPreferredSystemLanguages().join(","),
            platform: hostChPlatform().navigatorPlatform,
            userAgentMetadata: hostUserAgentMetadata(),
          },
    );
  } catch (error) {
    onError("ua-override failed", error);
  }
  try {
    await send("Emulation.setTimezoneOverride", { timezoneId: profile?.timezone ?? "" });
  } catch (error) {
    onError("timezone-override failed", error);
  }
  if (!options.locale) {
    return;
  }
  try {
    await send("Emulation.setLocaleOverride", profile ? { locale: profile.locale } : {});
  } catch (error) {
    onError("locale-override failed", error);
  }
}

// A worker's navigator.platform does not follow the UA override, and workers have no
// "evaluate on new document"; the worker is paused at start, so this runs before its code.
function workerNavigatorSource(profile: BrowserFingerprintProfile): string {
  const values = {
    platform: navigatorPlatform(profile),
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory: profile.deviceMemory,
  };
  return `(() => { const v = ${JSON.stringify(values)}; const p = Object.getPrototypeOf(navigator);
  for (const k of Object.keys(v)) { try { Object.defineProperty(p, k, { get: () => v[k], configurable: true }); } catch (e) {} } })();`;
}

const WEBRTC_DISABLE_SOURCE =
  "(() => { try { const N = () => { throw new DOMException('WebRTC disabled', 'NotAllowedError'); };" +
  " window.RTCPeerConnection = N; window.webkitRTCPeerConnection = N; } catch (e) {} })();";

// WebRTC can leak the real public IP via STUN/UDP even behind an HTTP proxy.
// `force-proxy` restricts ICE to proxy-reachable candidates; `disable` also
// neutralises RTCPeerConnection in the page so no candidate is gathered.
function applyWebRtcPolicy(contents: WebContents, profile: BrowserFingerprintProfile | null): void {
  try {
    contents.setWebRTCIPHandlingPolicy(
      profile && profile.webrtcPolicy !== "default" ? "disable_non_proxied_udp" : "default",
    );
  } catch (error) {
    logWarn("webrtc-policy failed", contents, error);
  }
}

/** Page scripts that must run before any page script, for the given identity. */
function initScriptSources(profile: BrowserFingerprintProfile | null, legacy: boolean): string[] {
  // Chrome's window.chrome APIs for every identity: pages call them (and break without them).
  if (!profile) {
    return legacy ? [CHROME_SHIM_SOURCE, STEALTH_SOURCE] : [CHROME_SHIM_SOURCE];
  }
  const sources = [CHROME_SHIM_SOURCE, buildFingerprintInitScript(profile)];
  for (const custom of profile.initScripts) {
    if (typeof custom === "string" && custom.trim().length > 0) {
      sources.push(custom);
    }
  }
  if (profile.webrtcPolicy === "disable") {
    sources.push(WEBRTC_DISABLE_SOURCE);
  }
  return sources;
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

interface GuestIdentityState {
  /** Identity this guest has (or is getting): profile JSON, "legacy" or "off". */
  key: string;
  ready: Promise<void>;
  /** Page.addScriptToEvaluateOnNewDocument identifiers, removed on the next change. */
  scriptIds: string[];
  autoAttach: boolean;
}

const guestStates = new WeakMap<WebContents, GuestIdentityState>();

function identityKey(): string {
  const profile = effectiveProfile();
  if (profile) {
    return JSON.stringify(profile);
  }
  return stealthEnabled ? "legacy" : "off";
}

/**
 * Apply the current identity to a guest (webview or popup) and resolve once it is in
 * place. Idempotent per identity: concurrent callers share one application, and a later
 * profile change replaces the previous overrides and init scripts.
 */
export function applyStealthToWebContents(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) {
    return Promise.resolve();
  }
  if (!identityResolved) {
    return waitForIdentity().then(() => {
      identityResolved = true;
      return applyStealthToWebContents(contents);
    });
  }
  const key = identityKey();
  const previous = guestStates.get(contents);
  if (previous?.key === key) {
    return previous.ready;
  }
  const state: GuestIdentityState = {
    key,
    ready: Promise.resolve(),
    scriptIds: [],
    autoAttach: previous?.autoAttach ?? false,
  };
  const previousScriptIds = previous?.scriptIds ?? [];
  state.ready = (previous?.ready ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => applyGuestIdentity(contents, state, previousScriptIds));
  guestStates.set(contents, state);
  return state.ready;
}

async function applyGuestIdentity(
  contents: WebContents,
  state: GuestIdentityState,
  previousScriptIds: string[],
): Promise<void> {
  if (contents.isDestroyed()) {
    return;
  }
  const profile = effectiveProfile();
  const legacy = !profile && stealthEnabled;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    const send = commandSender(contents);
    const onError = (message: string, error: unknown) => logWarn(message, contents, error);
    // Engine overrides first: they must be in place before the first request.
    await applyIdentityOverrides(send, profile, onError);
    await send("Page.enable");
    for (const identifier of previousScriptIds) {
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => undefined);
    }
    for (const source of initScriptSources(profile, legacy)) {
      const result = await send("Page.addScriptToEvaluateOnNewDocument", { source });
      if (typeof result?.identifier === "string") {
        state.scriptIds.push(result.identifier);
      }
    }
    applyWebRtcPolicy(contents, profile);
    // Always: cross-site iframes and workers run in their own renderer, which would
    // otherwise send Electron's default UA ("JAgentDesk/…", "Electron/…").
    if (!state.autoAttach) {
      state.autoAttach = true;
      await installChildTargetIdentity(contents);
    }
    log.info("[browser-stealth] applied identity", {
      webContentsId: contents.id,
      identity: profile ? `profile:${profile.id}` : state.key,
    });
  } catch (error) {
    logWarn("injection failed", contents, error);
  }
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/**
 * Cross-site iframes and dedicated workers are separate CDP targets that do not inherit
 * the page's overrides. Auto-attach pauses each one before it runs, applies the current
 * identity through its session, then resumes it.
 */
async function installChildTargetIdentity(contents: WebContents): Promise<void> {
  contents.debugger.on("message", (_event, method, params, parentSessionId) => {
    if (method !== "Target.attachedToTarget") {
      return;
    }
    const attached = params as { sessionId?: string; targetInfo?: { type?: string } };
    const childSessionId = attached.sessionId;
    if (!childSessionId || contents.isDestroyed()) {
      return;
    }
    void prepareChildTarget(contents, childSessionId, attached.targetInfo?.type).finally(() => {
      if (contents.isDestroyed()) {
        return;
      }
      void contents.debugger
        .sendCommand("Runtime.runIfWaitingForDebugger", undefined, childSessionId)
        .catch(() => undefined);
    });
    void parentSessionId;
  });
  await contents.debugger.sendCommand("Target.setAutoAttach", AUTO_ATTACH);
}

async function prepareChildTarget(
  contents: WebContents,
  sessionId: string,
  type: string | undefined,
): Promise<void> {
  const profile = effectiveProfile();
  const send = commandSender(contents, sessionId);
  // Without a profile the child still gets the plain Chrome UA (applyIdentityOverrides).
  const onError = (message: string, error: unknown) =>
    logWarn(`${message} (${type ?? "target"})`, contents, error);
  const worker = type === "worker" || type === "shared_worker" || type === "service_worker";
  try {
    // A dedicated worker inherits the page's locale override; setting it again fails.
    await applyIdentityOverrides(send, profile, onError, { locale: !worker });
    if (worker && profile) {
      await send("Runtime.evaluate", { expression: workerNavigatorSource(profile) });
    }
    if (type === "iframe") {
      await send("Page.enable");
      for (const source of initScriptSources(profile, !profile && stealthEnabled)) {
        await send("Page.addScriptToEvaluateOnNewDocument", { source });
      }
    }
    await send("Target.setAutoAttach", AUTO_ATTACH);
  } catch (error) {
    onError("child target identity failed", error);
  }
}

/** Re-apply the current identity to every open guest of the agentic-browser session. */
export async function reapplyStealthToGuests(
  browserSession: Session,
  allContents: WebContents[],
): Promise<void> {
  await Promise.all(
    allContents
      .filter((contents) => !contents.isDestroyed() && contents.session === browserSession)
      .map((contents) => applyStealthToWebContents(contents)),
  );
}

function logWarn(message: string, contents: WebContents, error: unknown): void {
  log.warn(`[browser-stealth] ${message}`, {
    webContentsId: contents.id,
    error: error instanceof Error ? error.message : String(error),
  });
}
