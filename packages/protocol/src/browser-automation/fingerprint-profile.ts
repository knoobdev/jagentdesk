import { z } from "zod";

/**
 * A coherent browser fingerprint identity for the agentic browser's anti-detect
 * layer. The whole point is CONSISTENCY: every surface (User-Agent, UA Client
 * Hints, WebGL, timezone, screen, canvas/audio noise) is derived from the same
 * real-device template so they can't contradict each other — a mismatched
 * fingerprint is flagged harder than no spoofing at all. Profiles are generated
 * algorithmically from templates (no LLM), persisted daemon-side, listed for the
 * user to pick, and applied by the desktop host via CDP + init scripts. See
 * ADR-0011 and docs/plans/active/agentic-browser-custom-and-anti-detect.md.
 *
 * Honest limits baked into the model: `proxy` is the ONLY real IP control — there
 * is no way to "fake" an IP without routing traffic through a proxy. `webrtcPolicy`
 * closes the STUN leak that otherwise exposes the real IP even behind a proxy.
 */

export const FINGERPRINT_OS_VALUES = ["windows", "macos", "linux"] as const;
export const FingerprintOsSchema = z.enum(FINGERPRINT_OS_VALUES);
export type FingerprintOs = z.infer<typeof FingerprintOsSchema>;

export const WEBRTC_POLICY_VALUES = ["default", "force-proxy", "disable"] as const;
export const WebRtcPolicySchema = z.enum(WEBRTC_POLICY_VALUES);
export type WebRtcPolicy = z.infer<typeof WebRtcPolicySchema>;

const UaBrandSchema = z.object({
  brand: z.string(),
  version: z.string(),
});

export const UaClientHintsSchema = z.object({
  platform: z.string(), // "Windows" | "macOS" | "Linux"
  platformVersion: z.string(),
  architecture: z.string(), // "x86" | "arm"
  bitness: z.string(), // "64"
  model: z.string(),
  mobile: z.boolean(),
  brands: z.array(UaBrandSchema),
  fullVersionList: z.array(UaBrandSchema),
});
export type UaClientHints = z.infer<typeof UaClientHintsSchema>;

export const ScreenMetricsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  availWidth: z.number().int().positive(),
  availHeight: z.number().int().positive(),
  devicePixelRatio: z.number().positive(),
  colorDepth: z.number().int().positive(),
});
export type ScreenMetrics = z.infer<typeof ScreenMetricsSchema>;

export const ProxyConfigSchema = z.object({
  // "scheme://host:port" — http, https, socks5. The only real IP control.
  server: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

export const BrowserFingerprintProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),

  // Coherent device identity.
  os: FingerprintOsSchema,
  osVersion: z.string(),
  userAgent: z.string(),
  uaClientHints: UaClientHintsSchema,
  languages: z.array(z.string()).min(1),
  acceptLanguage: z.string(),
  timezone: z.string(), // IANA, e.g. "America/New_York" — must match proxy geo
  locale: z.string(), // e.g. "en-US"
  screen: ScreenMetricsSchema,
  hardwareConcurrency: z.number().int().positive(),
  deviceMemory: z.number().positive(),
  webglVendor: z.string(),
  webglRenderer: z.string(),
  // Deterministic per-profile noise seeds → canvas/audio hashes stay stable within
  // a session (real browsers are stable) but differ across profiles.
  canvasNoiseSeed: z.number().int(),
  audioNoiseSeed: z.number().int(),

  // Network — the honest IP story.
  proxy: ProxyConfigSchema.nullable(),
  webrtcPolicy: WebRtcPolicySchema,

  // Full customization escape hatches.
  extensions: z.array(z.string()), // absolute unpacked-extension dirs
  initScripts: z.array(z.string()), // custom JS injected on every new document
  // Whether to apply the fingerprint spoofing init script. When false the profile
  // still carries proxy/extensions/initScripts but presents the host's real
  // browser identity (safer against consistency checks than partial spoofing).
  stealthEnabled: z.boolean(),
});
export type BrowserFingerprintProfile = z.infer<typeof BrowserFingerprintProfileSchema>;

/** A device template: the coherent baseline the generator fills a profile from. */
interface DeviceTemplate {
  os: FingerprintOs;
  osVersion: string;
  uaPlatform: string; // OS token inside the UA string
  chPlatform: string; // Sec-CH-UA-Platform
  chPlatformVersion: string;
  architecture: string;
  webglVendor: string;
  webglRenderer: string;
  screen: ScreenMetrics;
  hardwareConcurrency: number;
  deviceMemory: number;
}

// Chrome version presented across UA + UA-CH. Bump as Chromium in Electron moves;
// keeping ONE source here guarantees UA and Client Hints never disagree.
const CHROME_MAJOR = "140";
const CHROME_FULL = "140.0.7259.0";

const DEVICE_TEMPLATES: Record<FingerprintOs, DeviceTemplate> = {
  windows: {
    os: "windows",
    osVersion: "10.0",
    uaPlatform: "Windows NT 10.0; Win64; x64",
    chPlatform: "Windows",
    chPlatformVersion: "15.0.0", // UA-CH reports the Win platform version (Win11 = 15.x)
    architecture: "x86",
    webglVendor: "Google Inc. (NVIDIA)",
    webglRenderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      devicePixelRatio: 1,
      colorDepth: 24,
    },
    hardwareConcurrency: 12,
    deviceMemory: 8,
  },
  macos: {
    os: "macos",
    osVersion: "10_15_7", // Chrome freezes the reported macOS version at 10_15_7
    uaPlatform: "Macintosh; Intel Mac OS X 10_15_7",
    chPlatform: "macOS",
    chPlatformVersion: "14.5.0",
    architecture: "arm",
    webglVendor: "Google Inc. (Apple)",
    webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
    screen: {
      width: 1512,
      height: 982,
      availWidth: 1512,
      availHeight: 944,
      devicePixelRatio: 2,
      colorDepth: 30,
    },
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
  linux: {
    os: "linux",
    osVersion: "",
    uaPlatform: "X11; Linux x86_64",
    chPlatform: "Linux",
    chPlatformVersion: "6.8.0",
    architecture: "x86",
    webglVendor: "Google Inc. (Intel)",
    webglRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1053,
      devicePixelRatio: 1,
      colorDepth: 24,
    },
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
};

function buildUserAgent(template: DeviceTemplate): string {
  return `Mozilla/5.0 (${template.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
}

function buildClientHints(template: DeviceTemplate): UaClientHints {
  // Chrome's GREASE brand set. The order and the "Not=A?Brand" grease entry match
  // what a real Chrome sends so the brand list itself isn't a tell.
  const brands = [
    { brand: "Chromium", version: CHROME_MAJOR },
    { brand: "Google Chrome", version: CHROME_MAJOR },
    { brand: "Not=A?Brand", version: "24" },
  ];
  const fullVersionList = [
    { brand: "Chromium", version: CHROME_FULL },
    { brand: "Google Chrome", version: CHROME_FULL },
    { brand: "Not=A?Brand", version: "24.0.0.0" },
  ];
  return {
    platform: template.chPlatform,
    platformVersion: template.chPlatformVersion,
    architecture: template.architecture,
    bitness: "64",
    model: "",
    mobile: false,
    brands,
    fullVersionList,
  };
}

// Deterministic 32-bit hash so a caller-supplied seed yields stable, distinct
// canvas/audio seeds; falls back to a time-based seed when none is given.
function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface GenerateFingerprintProfileInput {
  id: string;
  name?: string;
  os?: FingerprintOs;
  timezone?: string;
  locale?: string;
  languages?: string[];
  proxy?: ProxyConfig | null;
  webrtcPolicy?: WebRtcPolicy;
  /** Stable seed for canvas/audio noise; defaults to `id` so a profile is reproducible. */
  seed?: string;
  nowMs: number;
}

/**
 * Build a coherent fingerprint profile from a device template. Pure/algorithmic —
 * no network, no LLM. Caller supplies `id` and `nowMs` (so this stays deterministic
 * and testable); everything else defaults to a coherent value.
 */
export function generateFingerprintProfile(
  input: GenerateFingerprintProfileInput,
): BrowserFingerprintProfile {
  const os = input.os ?? "windows";
  const template = DEVICE_TEMPLATES[os];
  const locale = input.locale ?? "en-US";
  const languages = input.languages ?? [locale, locale.split("-")[0] ?? "en"];
  const seedBase = input.seed ?? input.id;
  return {
    id: input.id,
    name: input.name?.trim() || defaultProfileName(os),
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    os,
    osVersion: template.osVersion,
    userAgent: buildUserAgent(template),
    uaClientHints: buildClientHints(template),
    languages,
    acceptLanguage: buildAcceptLanguage(languages),
    timezone: input.timezone ?? "America/New_York",
    locale,
    screen: template.screen,
    hardwareConcurrency: template.hardwareConcurrency,
    deviceMemory: template.deviceMemory,
    webglVendor: template.webglVendor,
    webglRenderer: template.webglRenderer,
    canvasNoiseSeed: hash32(`${seedBase}:canvas`),
    audioNoiseSeed: hash32(`${seedBase}:audio`),
    proxy: input.proxy ?? null,
    webrtcPolicy: input.webrtcPolicy ?? (input.proxy ? "force-proxy" : "default"),
    extensions: [],
    initScripts: [],
    stealthEnabled: true,
  };
}

function defaultProfileName(os: FingerprintOs): string {
  const label = os === "macos" ? "macOS" : os === "windows" ? "Windows" : "Linux";
  return `${label} · Chrome ${CHROME_MAJOR}`;
}

function buildAcceptLanguage(languages: string[]): string {
  // "en-US,en;q=0.9" — descending quality after the primary language.
  return languages
    .map((lang, index) =>
      index === 0 ? lang : `${lang};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`,
    )
    .join(",");
}
