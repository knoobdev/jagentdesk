import { describe, expect, it, vi } from "vitest";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

vi.mock("electron", () => ({
  app: {
    userAgentFallback:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) JAgentDesk/0.9.44 Chrome/146.0.7680.179 Electron/41.2.0 Safari/537.36",
    getPreferredSystemLanguages: () => ["en-US", "vi-VN"],
  },
}));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

const {
  acceptLanguageList,
  alignProfileWithEngine,
  browserUserAgentFromElectron,
  hostUserAgentMetadata,
  navigationClientHintHeaders,
} = await import("./browser-stealth.js");

const profile = generateFingerprintProfile({
  id: "bfp_a1b2c3",
  name: "work",
  os: "windows",
  nowMs: 1_790_000_000_000,
});

describe("browser identity helpers", () => {
  it("drops the app and Electron tokens and reduces the Chrome version", () => {
    expect(
      browserUserAgentFromElectron(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) JAgentDesk/0.9.44 Chrome/146.0.7680.179 Electron/41.2.0 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    );
  });

  it("presents the engine's Chrome version in the UA and Client Hints", () => {
    const aligned = alignProfileWithEngine(profile, "146.0.7680.179");
    expect(aligned.userAgent).toContain("Chrome/146.0.0.0");
    expect(aligned.userAgent).toContain("Windows NT 10.0");
    const chrome = aligned.uaClientHints.fullVersionList.find(
      (entry) => entry.brand === "Google Chrome",
    );
    expect(chrome?.version).toBe("146.0.7680.179");
    expect(aligned.uaClientHints.brands.find((entry) => entry.brand === "Chromium")?.version).toBe(
      "146",
    );
    // The GREASE brand keeps its own version.
    expect(
      aligned.uaClientHints.brands.find((entry) => entry.brand === "Not=A?Brand")?.version,
    ).toBe("24");
  });

  it("passes the language list without q-values", () => {
    expect(acceptLanguageList("en-US,en;q=0.9")).toBe("en-US,en");
    expect(acceptLanguageList("vi-VN, vi;q=0.9, en;q=0.8")).toBe("vi-VN,vi,en");
  });

  it("builds the low-entropy Client Hints a real Chrome sends on navigations", () => {
    expect(navigationClientHintHeaders(hostUserAgentMetadata("146.0.7680.179", "14.1.0"))).toEqual({
      "Sec-CH-UA": '"Chromium";v="146", "Google Chrome";v="146", "Not=A?Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": expect.stringMatching(/^"(macOS|Windows|Linux)"$/),
    });
  });
});

describe("alignProfileWithHost", () => {
  it("reports the real GPU when the profile's OS is the host's", async () => {
    const { alignProfileWithHost } = await import("./browser-stealth.js");
    const mac = generateFingerprintProfile({ id: "bfp_mac", os: "macos", nowMs: 1 });
    expect(alignProfileWithHost(mac, "darwin")).toMatchObject({
      webglVendor: "",
      webglRenderer: "",
    });
    const windows = generateFingerprintProfile({ id: "bfp_win", os: "windows", nowMs: 1 });
    expect(alignProfileWithHost(windows, "darwin").webglRenderer).toBe(windows.webglRenderer);
  });
});
