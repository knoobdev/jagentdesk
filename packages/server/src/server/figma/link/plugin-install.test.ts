import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { computePluginChecksum, installFigmaLinkPlugin } from "./plugin-install.js";
import { describe, expect, it } from "vitest";

const logger = pino({ level: "silent" });

function makeVendor(): string {
  const vendor = mkdtempSync(path.join(tmpdir(), "jad-figma-vendor-"));
  mkdirSync(path.join(vendor, "dist"), { recursive: true });
  writeFileSync(
    path.join(vendor, "manifest.json"),
    JSON.stringify({
      name: "JAgentDesk Figma Link",
      id: "jagentdesk-figma-link",
      main: "dist/code.js",
      ui: "dist/index.html",
    }),
  );
  writeFileSync(path.join(vendor, "dist", "code.js"), "console.log(1);");
  writeFileSync(path.join(vendor, "dist", "index.html"), "<html></html>");
  writeFileSync(path.join(vendor, "LICENSE.md"), "MIT\n");
  return vendor;
}

describe("installFigmaLinkPlugin", () => {
  it("copies the managed plugin and is idempotent on the second pass", async () => {
    const vendor = makeVendor();
    const root = mkdtempSync(path.join(tmpdir(), "jad-figma-install-"));

    const first = await installFigmaLinkPlugin({
      logger,
      vendorPluginDir: vendor,
      installDir: path.join(root, "@hdc/jagentdesk-plugin-figma-link"),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.installed).toBe(true);
    expect(readFileSync(path.join(first.dir, "dist", "code.js"), "utf8")).toContain(
      "console.log(1)",
    );
    expect(
      JSON.parse(readFileSync(path.join(first.dir, ".jagentdesk-managed.json"), "utf8")).managedBy,
    ).toBe("jagentdesk-server");

    const second = await installFigmaLinkPlugin({
      logger,
      vendorPluginDir: vendor,
      installDir: path.join(root, "@hdc/jagentdesk-plugin-figma-link"),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.installed).toBe(false); // checksum match — no copy
  });

  it("refreshes a stale managed install when the vendor payload changes", async () => {
    const vendor = makeVendor();
    const root = mkdtempSync(path.join(tmpdir(), "jad-figma-install-"));
    const first = await installFigmaLinkPlugin({
      logger,
      vendorPluginDir: vendor,
      installDir: path.join(root, "@hdc/jagentdesk-plugin-figma-link"),
    });
    expect(first.ok).toBe(true);

    writeFileSync(path.join(vendor, "dist", "code.js"), "console.log(2);");
    const second = await installFigmaLinkPlugin({
      logger,
      vendorPluginDir: vendor,
      installDir: path.join(root, "@hdc/jagentdesk-plugin-figma-link"),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.installed).toBe(true);
    if (!second.ok) return;
    expect(readFileSync(path.join(second.dir, "dist", "code.js"), "utf8")).toContain(
      "console.log(2)",
    );
  });

  it("never clobbers an unmanaged copy the user placed there", async () => {
    const vendor = makeVendor();
    const root = mkdtempSync(path.join(tmpdir(), "jad-figma-install-"));
    const target = path.join(root, "@hdc/jagentdesk-plugin-figma-link");
    mkdirSync(path.join(target, "dist"), { recursive: true });
    writeFileSync(path.join(target, "manifest.json"), "{}");
    writeFileSync(path.join(target, "dist", "code.js"), "user built");

    const result = await installFigmaLinkPlugin({
      logger,
      vendorPluginDir: vendor,
      installDir: path.join(root, "@hdc/jagentdesk-plugin-figma-link"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toBe(false);
    expect(readFileSync(path.join(target, "dist", "code.js"), "utf8")).toBe("user built");
  });

  it("reports vendor_missing when the manifest is not there", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "jad-figma-install-"));
    const result = await installFigmaLinkPlugin({
      logger,
      vendorPluginDir: path.join(root, "nope"),
      installDir: path.join(root, "@hdc/jagentdesk-plugin-figma-link"),
    });
    expect(result).toEqual({ ok: false, error: "vendor_missing" });
  });

  it("backs off after a failure and re-checksums match", async () => {
    const vendor = makeVendor();
    const root = mkdtempSync(path.join(tmpdir(), "jad-figma-install-"));
    const result = await installFigmaLinkPlugin({
      logger,
      vendorPluginDir: vendor,
      installDir: path.join(root, "@hdc/jagentdesk-plugin-figma-link"),
      backoffMs: 300_000,
      lastFailureAt: Date.now(),
      now: () => Date.now(),
    });
    expect(result).toEqual({ ok: false, error: "backoff" });
    expect(await computePluginChecksum(vendor)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Figma Link plugin location", () => {
  it("installs under the daemon home, never in the user's home (spec 32.4.1)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "jad-figma-home-"));
    const { FigmaLinkServer } = await import("./bridge.js");
    const server = new FigmaLinkServer({
      secrets: { get: async () => null, set: async () => undefined, delete: async () => undefined },
      dataDir: home,
      logger,
      port: 0,
    } as never);
    const installDir = (server as unknown as { options: { installDir?: string; dataDir: string } })
      .options;
    expect(installDir.installDir ?? path.join(installDir.dataDir, "figma", "plugin")).toBe(
      path.join(home, "figma", "plugin"),
    );
  });
});
