import { describe, expect, it } from "vitest";
import {
  BrowserFingerprintProfileSchema,
  generateFingerprintProfile,
} from "./fingerprint-profile.js";

describe("generateFingerprintProfile", () => {
  it("produces a schema-valid profile", () => {
    const profile = generateFingerprintProfile({ id: "bfp_1", os: "windows", nowMs: 1_000 });
    expect(() => BrowserFingerprintProfileSchema.parse(profile)).not.toThrow();
  });

  it("keeps UA, UA-CH platform and WebGL coherent per OS (no mismatched signals)", () => {
    const win = generateFingerprintProfile({ id: "w", os: "windows", nowMs: 1 });
    expect(win.userAgent).toContain("Windows NT 10.0");
    expect(win.uaClientHints.platform).toBe("Windows");
    expect(win.webglVendor).toContain("NVIDIA");

    const mac = generateFingerprintProfile({ id: "m", os: "macos", nowMs: 1 });
    expect(mac.userAgent).toContain("Mac OS X");
    expect(mac.uaClientHints.platform).toBe("macOS");
    expect(mac.webglRenderer).toContain("Apple");

    const linux = generateFingerprintProfile({ id: "l", os: "linux", nowMs: 1 });
    expect(linux.userAgent).toContain("Linux x86_64");
    expect(linux.uaClientHints.platform).toBe("Linux");
  });

  it("presents the same Chrome major in UA and every Client-Hints brand", () => {
    const p = generateFingerprintProfile({ id: "c", os: "windows", nowMs: 1 });
    const uaMajor = p.userAgent.match(/Chrome\/(\d+)\./)?.[1];
    expect(uaMajor).toBeTruthy();
    for (const brand of p.uaClientHints.brands) {
      if (brand.brand === "Chromium" || brand.brand === "Google Chrome") {
        expect(brand.version).toBe(uaMajor);
      }
    }
  });

  it("derives deterministic, distinct canvas/audio seeds from the seed input", () => {
    const a = generateFingerprintProfile({ id: "x", seed: "same", nowMs: 1 });
    const b = generateFingerprintProfile({ id: "y", seed: "same", nowMs: 2 });
    expect(a.canvasNoiseSeed).toBe(b.canvasNoiseSeed); // same seed → same noise
    expect(a.canvasNoiseSeed).not.toBe(a.audioNoiseSeed); // canvas ≠ audio
  });

  it("defaults WebRTC to force-proxy when a proxy is set (closes the STUN IP leak)", () => {
    const withProxy = generateFingerprintProfile({
      id: "p",
      proxy: { server: "socks5://127.0.0.1:1080" },
      nowMs: 1,
    });
    expect(withProxy.webrtcPolicy).toBe("force-proxy");
    const noProxy = generateFingerprintProfile({ id: "q", nowMs: 1 });
    expect(noProxy.webrtcPolicy).toBe("default");
    expect(noProxy.proxy).toBeNull();
  });

  it("builds a descending-quality Accept-Language from the language list", () => {
    const p = generateFingerprintProfile({ id: "al", languages: ["en-US", "en"], nowMs: 1 });
    expect(p.acceptLanguage).toBe("en-US,en;q=0.9");
  });
});
