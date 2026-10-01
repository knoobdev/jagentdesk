import { describe, expect, it } from "vitest";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import vm from "node:vm";
import { buildFingerprintInitScript, CHROME_SHIM_SOURCE } from "./browser-fingerprint-script.js";

describe("buildFingerprintInitScript", () => {
  it("embeds the profile's WebGL identity and hardware", () => {
    const profile = generateFingerprintProfile({ id: "m", os: "macos", nowMs: 1 });
    const script = buildFingerprintInitScript(profile);
    expect(script).toContain(profile.webglRenderer);
    expect(script).toContain(profile.webglVendor);
    // navigator.platform for macOS must be the frozen "MacIntel", not the raw OS.
    expect(script).toContain("MacIntel");
  });

  it("patches the read-back paths and reports webdriver false", () => {
    const script = buildFingerprintInitScript(
      generateFingerprintProfile({ id: "w", os: "windows", nowMs: 1 }),
    );
    expect(script).toContain("'webdriver', () => false");
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

describe("native masking in a page", () => {
  // A minimal page: the injected scripts only touch these globals.
  function runInPage(profileOs: "windows" | "macos") {
    const context = vm.createContext({
      performance: { timeOrigin: 1, now: () => 5, getEntriesByType: () => [] },
    });
    vm.runInContext(
      `
      window = globalThis;
      class Navigator {}
      Object.defineProperty(Navigator.prototype, "platform", { get() { return "MacIntel"; }, enumerable: true, configurable: true });
      Object.defineProperty(Navigator.prototype, "webdriver", { get() { return true; }, enumerable: true, configurable: true });
      navigator = Object.create(Navigator.prototype);
      Object.defineProperty(navigator, "plugins", { value: { length: 5 } });
      class Screen {}
      globalThis.Permissions = class Permissions { query(descriptor) { return descriptor; } };
      globalThis.WebGLRenderingContext = class WebGLRenderingContext { getParameter(p) { return p; } };
      `,
      context,
    );
    vm.runInContext(CHROME_SHIM_SOURCE, context);
    vm.runInContext(
      buildFingerprintInitScript(generateFingerprintProfile({ id: "p", os: profileOs, nowMs: 1 })),
      context,
    );
    return (expression: string) => vm.runInContext(expression, context) as unknown;
  }

  it("shims window.chrome without patching Function.prototype.toString", () => {
    const context = vm.createContext({});
    vm.runInContext(
      "window = globalThis; globalThis.performance = { timeOrigin: 0, getEntriesByType: () => [] };",
      context,
    );
    const original = vm.runInContext("Function.prototype.toString", context);
    vm.runInContext(CHROME_SHIM_SOURCE, context);
    expect(vm.runInContext("Function.prototype.toString", context)).toBe(original);
    expect(vm.runInContext("Function.prototype.toString.call(chrome.csi)", context)).toBe(
      "function () { [native code] }",
    );
    expect(
      vm.runInContext("'prototype' in chrome.loadTimes && chrome.loadTimes.length", context),
    ).toBe(0);
  });

  it("reports native code through Function.prototype.toString for every override", () => {
    const evaluate = runInPage("windows");
    const toString = (target: string) =>
      evaluate(`Function.prototype.toString.call(${target})`) as string;
    expect(toString('Object.getOwnPropertyDescriptor(Navigator.prototype, "platform").get')).toBe(
      "function get platform() { [native code] }",
    );
    expect(toString("WebGLRenderingContext.prototype.getParameter")).toBe(
      "function getParameter() { [native code] }",
    );
    expect(toString("chrome.loadTimes")).toBe("function () { [native code] }");
    expect(evaluate("chrome.loadTimes.name")).toBe("");
    expect(toString("Function.prototype.toString")).toBe("function toString() { [native code] }");
    // Unpatched functions keep their real source.
    expect(toString("function mine() { return 1; }")).toContain("return 1");
  });

  it("gives overrides the shape of native functions", () => {
    const evaluate = runInPage("windows");
    expect(evaluate("WebGLRenderingContext.prototype.getParameter.length")).toBe(1);
    expect(evaluate('"prototype" in WebGLRenderingContext.prototype.getParameter')).toBe(false);
    expect(
      evaluate('Object.hasOwn(WebGLRenderingContext.prototype.getParameter, "toString")'),
    ).toBe(false);
    expect(
      evaluate('Object.getOwnPropertyDescriptor(Navigator.prototype, "platform").enumerable'),
    ).toBe(true);
    expect(evaluate("navigator.platform")).toBe("Win32");
    expect(evaluate("navigator.webdriver")).toBe(false);
    expect(evaluate("typeof chrome.csi")).toBe("function");
  });
});
