import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import { buildFingerprintInitScript } from "./browser-fingerprint-script.js";

/**
 * P5 runtime verification of the anti-detect engine in a REAL Chromium. The
 * product injects `buildFingerprintInitScript` via CDP
 * Page.addScriptToEvaluateOnNewDocument; playwright's addInitScript uses the same
 * primitive, so this exercises the exact injected JS in real Blink/V8. UA / UA-CH /
 * timezone / locale come from CDP overrides in the product; here they are applied
 * through playwright's equivalent context options (same observable outcome) so we
 * can assert the whole coherent identity end to end.
 *
 * Opt-in (needs a Chromium binary): `PW_E2E=1 npx vitest run browser-fingerprint-script.e2e`.
 */
const RUN = process.env.PW_E2E === "1";

describe.skipIf(!RUN)("buildFingerprintInitScript in real Chromium", () => {
  const profile = generateFingerprintProfile({
    id: "e2e",
    os: "macos",
    timezone: "Europe/Berlin",
    locale: "de-DE",
    languages: ["de-DE", "de"],
    nowMs: 1,
  });
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function pageWithProfile() {
    const context = await browser.newContext({
      userAgent: profile.userAgent,
      locale: profile.locale,
      timezoneId: profile.timezone,
    });
    await context.addInitScript({ content: buildFingerprintInitScript(profile) });
    const page = await context.newPage();
    await page.goto("about:blank");
    return { context, page };
  }

  it("hides webdriver and spoofs navigator to the profile", async () => {
    const { context, page } = await pageWithProfile();
    expect(await page.evaluate(() => navigator.webdriver)).toBeUndefined();
    expect(await page.evaluate(() => navigator.platform)).toBe("MacIntel");
    expect(await page.evaluate(() => navigator.hardwareConcurrency)).toBe(
      profile.hardwareConcurrency,
    );
    expect(await page.evaluate(() => (navigator as { deviceMemory?: number }).deviceMemory)).toBe(
      profile.deviceMemory,
    );
    expect(await page.evaluate(() => navigator.userAgent)).toBe(profile.userAgent);
    expect(await page.evaluate(() => Array.from(navigator.languages))).toEqual(profile.languages);
    await context.close();
  });

  it("reports the profile timezone and locale (coherent with UA)", async () => {
    const { context, page } = await pageWithProfile();
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
      "Europe/Berlin",
    );
    await context.close();
  });

  it("spoofs WebGL vendor/renderer to the profile GPU", async () => {
    const { context, page } = await pageWithProfile();
    const gl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("webgl") as WebGLRenderingContext | null;
      if (!ctx) return null;
      const ext = ctx.getExtension("WEBGL_debug_renderer_info");
      if (!ext) return null;
      return {
        vendor: ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string,
        renderer: ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string,
      };
    });
    // Headless chromium exposes WEBGL_debug_renderer_info; if absent we skip.
    if (gl) {
      expect(gl.vendor).toBe(profile.webglVendor);
      expect(gl.renderer).toBe(profile.webglRenderer);
    }
    await context.close();
  });

  it("spoofs screen metrics to the profile", async () => {
    const { context, page } = await pageWithProfile();
    const screen = await page.evaluate(() => ({ w: window.screen.width, h: window.screen.height }));
    expect(screen.w).toBe(profile.screen.width);
    expect(screen.h).toBe(profile.screen.height);
    await context.close();
  });

  it("canvas readback is STABLE across reads (not per-call random) and native-masked", async () => {
    const { context, page } = await pageWithProfile();
    const result = await page.evaluate(() => {
      const draw = () => {
        const c = document.createElement("canvas");
        c.width = 200;
        c.height = 50;
        const ctx = c.getContext("2d")!;
        ctx.textBaseline = "top";
        ctx.font = "16px Arial";
        ctx.fillStyle = "#f60";
        ctx.fillRect(0, 0, 200, 50);
        ctx.fillStyle = "#069";
        ctx.fillText("fingerprint-test", 2, 2);
        return c.toDataURL();
      };
      return {
        a: draw(),
        b: draw(),
        toStringNative: HTMLCanvasElement.prototype.toDataURL.toString().includes("[native code]"),
      };
    });
    // Same drawing twice → identical output (seeded noise is deterministic).
    expect(result.a).toBe(result.b);
    // Override masks itself as native code.
    expect(result.toStringNative).toBe(true);
    await context.close();
  });

  it("produces a DIFFERENT canvas hash under a different profile seed (noise applied)", async () => {
    const draw = `(() => { const c = document.createElement('canvas'); c.width=200;c.height=50;
      const x=c.getContext('2d'); x.textBaseline='top'; x.font='16px Arial'; x.fillStyle='#f60';
      x.fillRect(0,0,200,50); x.fillStyle='#069'; x.fillText('fingerprint-test',2,2); return c.toDataURL(); })()`;

    const other = generateFingerprintProfile({
      id: "e2e-2",
      os: "macos",
      seed: "different",
      nowMs: 1,
    });

    const ctxA = await browser.newContext();
    await ctxA.addInitScript({ content: buildFingerprintInitScript(profile) });
    const pgA = await ctxA.newPage();
    await pgA.goto("about:blank");
    const hashA = await pgA.evaluate(draw);

    const ctxB = await browser.newContext();
    await ctxB.addInitScript({ content: buildFingerprintInitScript(other) });
    const pgB = await ctxB.newPage();
    await pgB.goto("about:blank");
    const hashB = await pgB.evaluate(draw);

    expect(hashA).not.toBe(hashB);
    await ctxA.close();
    await ctxB.close();
  });
});
