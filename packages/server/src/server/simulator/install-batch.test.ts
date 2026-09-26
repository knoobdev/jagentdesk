import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SimulatorService } from "./simulator-service.js";

// Verifies the batch/IPA install plumbing WITHOUT a real simulator: an .ipa is unzipped and its
// Payload/<App>.app is located (so the error, if any, comes from simctl rejecting the install — not
// from failing to find the app), and installOnMany aggregates a per-udid result instead of throwing.

const macOS = process.platform === "darwin";

describe.runIf(macOS)("Simulator batch / IPA install", () => {
  it("aggregates a per-simulator result and does not throw on a bad udid", async () => {
    const svc = new SimulatorService();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-app-"));
    const appDir = path.join(tmp, "Demo.app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "Info.plist"), "<plist></plist>");
    const results = await svc.installOnMany(["not-a-real-udid"], appDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.udid).toBe("not-a-real-udid");
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBeTruthy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("unzips an .ipa and finds Payload/<App>.app before installing", async () => {
    const svc = new SimulatorService();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ipa-src-"));
    const payload = path.join(tmp, "Payload", "Demo.app");
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, "Info.plist"), "<plist></plist>");
    const ipa = path.join(tmp, "Demo.ipa");
    execSync(`cd ${JSON.stringify(tmp)} && zip -q -r ${JSON.stringify(ipa)} Payload`);
    // Bad udid → simctl rejects install, but the error must NOT be "no .app found" (extraction worked).
    await expect(svc.installAppSmart("not-a-real-udid", ipa)).rejects.toThrow();
    try {
      await svc.installAppSmart("not-a-real-udid", ipa);
    } catch (err) {
      expect(String(err)).not.toContain("no .app found");
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
