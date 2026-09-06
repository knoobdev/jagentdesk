import { describe, expect, it } from "vitest";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import { buildFingerprintInitScript } from "./browser-fingerprint-script.js";

describe("buildFingerprintInitScript", () => {
  it("embeds the profile's WebGL identity and hardware", () => {
    const profile = generateFingerprintProfile({ id: "m", os: "macos", nowMs: 1 });
    const script = buildFingerprintInitScript(profile);
    expect(script).toContain(profile.webglRenderer);
    expect(script).toContain(profile.webglVendor);
    // navigator.platform for macOS must be the frozen "MacIntel", not the raw OS.
    expect(script).toContain("MacIntel");
  });

  it("masks overrides as native code (toString check) and hides webdriver", () => {
    const script = buildFingerprintInitScript(
      generateFingerprintProfile({ id: "w", os: "windows", nowMs: 1 }),
    );
    expect(script).toContain("[native code]");
    expect(script).toContain("webdriver");
    // Patches the read-back paths that fingerprinters hash.
    expect(script).toContain("toDataURL");
    expect(script).toContain("getImageData");
    expect(script).toContain("getChannelData");
  });

  it("uses the profile's deterministic seeds (not Math.random)", () => {
    const profile = generateFingerprintProfile({ id: "s", seed: "fixed", nowMs: 1 });
    const script = buildFingerprintInitScript(profile);
    expect(script).toContain(String(profile.canvasNoiseSeed >>> 0));
    expect(script).toContain(String(profile.audioNoiseSeed >>> 0));
    expect(script).toContain("mulberry32");
    expect(script).not.toContain("Math.random");
  });

  it("is a self-contained IIFE with no unescaped profile injection", () => {
    const profile = generateFingerprintProfile({ id: "i", nowMs: 1 });
    const script = buildFingerprintInitScript(profile);
    expect(script.trimStart().startsWith("(() => {")).toBe(true);
    expect(script.trimEnd().endsWith("})();")).toBe(true);
    // The config is embedded as a JSON literal (parseable slice after `const CFG = `).
    const json = script.slice(script.indexOf("const CFG = ") + "const CFG = ".length);
    const literal = json.slice(0, json.indexOf(";\n"));
    expect(() => JSON.parse(literal)).not.toThrow();
  });
});
