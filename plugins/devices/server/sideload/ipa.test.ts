import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BundleEditError, editBundle, planBundle } from "./bundle.js";
import { IpaError, inspectIpa } from "./ipa.js";
import { addLoadDylib, linkedDylibs, machoSlices, sliceIsEncrypted } from "./macho.js";
import {
  buildXmlPlist,
  parseBinaryPlist,
  parsePlist,
  parsePlistDict,
  parseXmlPlist,
} from "./plist.js";
import { extractZip, listZip, readZipEntry } from "./zip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_IPA = path.join(here, "test-fixtures", "probe.ipa");
const HELLO_DYLIB = path.join(here, "test-fixtures", "libjadhello.dylib");

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jad-ipa-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("plist", () => {
  it("round-trips every XML type", () => {
    const value = {
      text: 'a < b & "c"',
      count: 42,
      ratio: 1.5,
      on: true,
      off: false,
      when: new Date("2026-11-04T01:02:03Z"),
      blob: Buffer.from([0, 1, 2, 250]),
      list: ["x", 1],
      empty: {},
      nested: { deeper: [] },
    };
    expect(parseXmlPlist(buildXmlPlist(value))).toEqual(value);
  });

  it("reads the binary Info.plist xcodebuild writes", async () => {
    const entries = await listZip(PROBE_IPA);
    const info = await readZipEntry(
      PROBE_IPA,
      entries.find((e) => e.name === "Payload/JadProbe.app/Info.plist")!,
    );
    expect(info.toString("latin1", 0, 8)).toBe("bplist00");
    const dict = parsePlistDict(info);
    expect(dict.CFBundleIdentifier).toBe("dev.jagentdesk.probe.app");
    expect(dict.UIDeviceFamily).toEqual([1, 2]);
    // XcodeGen read the YAML flow list [iPhone14,2] as two items; the plist holds exactly that.
    expect(dict.UISupportedDevices).toEqual(["iPhone14", 2]);
    expect(parseBinaryPlist(info)).toEqual(parsePlist(info));
  });
});

describe("inspectIpa", () => {
  it("reads name, ids, version, architectures and extensions", async () => {
    const info = await inspectIpa(PROBE_IPA);
    expect(info).toEqual({
      sha256: "faef6b782f0f2c4fc750d23a895a890e02c7084c1e0b97b671bf5751bf14f6c5",
      sizeBytes: 24704,
      name: "JAD Probe",
      bundleId: "dev.jagentdesk.probe.app",
      version: "1.0",
      minimumOs: "15.0",
      encrypted: false,
      architectures: ["arm64"],
      extensions: [
        {
          bundleId: "dev.jagentdesk.probe.app.share",
          name: "JAD Probe Share",
          path: "PlugIns/JadProbeShare.appex",
        },
      ],
      hasWatchApp: false,
      signed: false,
      appDir: "Payload/JadProbe.app/",
    });
  });

  it("rejects a file that is not an IPA", async () => {
    await expect(inspectIpa(HELLO_DYLIB)).rejects.toBeInstanceOf(IpaError);
  });
});

describe("Mach-O", () => {
  it("detects FairPlay encryption (cryptid != 0)", async () => {
    const dylib = await readFile(HELLO_DYLIB);
    expect(sliceIsEncrypted(dylib, 0)).toBe(false);
    // Thin 64-bit header with one LC_ENCRYPTION_INFO_64 whose cryptid is 1.
    const header = Buffer.alloc(32 + 24);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeInt32LE(0x0100000c, 4);
    header.writeUInt32LE(1, 16);
    header.writeUInt32LE(24, 20);
    header.writeUInt32LE(0x2c, 32);
    header.writeUInt32LE(24, 36);
    header.writeUInt32LE(1, 48);
    expect(machoSlices(header)).toEqual([{ offset: 0, cputype: 0x0100000c, cpusubtype: 0 }]);
    expect(sliceIsEncrypted(header, 0)).toBe(true);
  });

  it("adds a weak load command once, in the header padding", async () => {
    const dylib = await readFile(HELLO_DYLIB);
    const once = addLoadDylib(dylib, "@executable_path/Frameworks/libextra.dylib");
    const twice = addLoadDylib(once, "@executable_path/Frameworks/libextra.dylib");
    expect(linkedDylibs(twice)).toContain("@executable_path/Frameworks/libextra.dylib");
    expect(twice.length).toBe(dylib.length);
    expect(twice.equals(once)).toBe(true);
  });
});

describe("bundle edits", () => {
  it("renames extensions with the main bundle id and drops removed ones", async () => {
    const info = await inspectIpa(PROBE_IPA);
    expect(planBundle(info, { bundleId: "dev.example.copy" })).toEqual({
      mainBundleId: "dev.example.copy",
      extensions: [
        {
          path: "PlugIns/JadProbeShare.appex",
          originalBundleId: "dev.jagentdesk.probe.app.share",
          bundleId: "dev.example.copy.share",
        },
      ],
    });
    expect(planBundle(info, { removeExtensions: "all" }).extensions).toEqual([]);
    expect(
      planBundle(info, { removeExtensions: ["dev.jagentdesk.probe.app.share"] }).extensions,
    ).toEqual([]);
    expect(() => planBundle(info, { bundleId: "bad id!" })).toThrow(BundleEditError);
  });

  it("writes every 26.5 option into the extracted app", async () => {
    const work = await scratch();
    await extractZip(PROBE_IPA, work);
    const appDir = path.join(work, "Payload", "JadProbe.app");
    const inspection = await inspectIpa(PROBE_IPA);
    const options = {
      bundleId: "dev.example.copy",
      appName: "Copy",
      minimumOs: "16.0",
      removeDeviceRestrictions: true,
      fileSharing: true,
      removeExtensions: "all" as const,
      inject: [HELLO_DYLIB],
    };
    const notes = await editBundle({
      appDir,
      inspection,
      options,
      plan: planBundle(inspection, options),
    });
    expect(notes).toEqual([
      "Removed extension dev.jagentdesk.probe.app.share",
      "Name: Copy",
      "Bundle ID: dev.jagentdesk.probe.app → dev.example.copy",
      "Injected @executable_path/Frameworks/libjadhello.dylib",
    ]);
    const info = parsePlistDict(await readFile(path.join(appDir, "Info.plist")));
    expect(info.CFBundleIdentifier).toBe("dev.example.copy");
    expect(info.CFBundleDisplayName).toBe("Copy");
    expect(info.MinimumOSVersion).toBe("16.0");
    expect(info.UISupportedDevices).toBeUndefined();
    expect(info.UIFileSharingEnabled).toBe(true);
    expect(info.LSSupportsOpeningDocumentsInPlace).toBe(true);
    await expect(stat(path.join(appDir, "PlugIns", "JadProbeShare.appex"))).rejects.toThrow();
    expect((await stat(path.join(appDir, "Frameworks", "libjadhello.dylib"))).isFile()).toBe(true);
    expect(linkedDylibs(await readFile(path.join(appDir, "JadProbe")))).toContain(
      "@executable_path/Frameworks/libjadhello.dylib",
    );
    // Executable bits survive extraction.
    expect((await stat(path.join(appDir, "JadProbe"))).mode & 0o111).not.toBe(0);
  });

  it("refuses a version that is not an iOS version", async () => {
    const work = await scratch();
    await extractZip(PROBE_IPA, work);
    const inspection = await inspectIpa(PROBE_IPA);
    const options = { minimumOs: "sixteen" };
    await expect(
      editBundle({
        appDir: path.join(work, "Payload", "JadProbe.app"),
        inspection,
        options,
        plan: planBundle(inspection, options),
      }),
    ).rejects.toMatchObject({ code: "invalid_option" });
  });
});
