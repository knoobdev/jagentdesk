import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { editBundle, planBundle } from "./bundle.js";
import { inspectIpa } from "./ipa.js";
import { linkedDylibs } from "./macho.js";
import { parsePlistDict } from "./plist.js";
import { CodesignSigner, ZsignSigner, type Signer } from "./signer.js";
import {
  createDevelopmentIdentity,
  createDevelopmentProfile,
} from "./test-support/signing-fixtures.js";
import { extractZip, listZip, readZipEntry } from "./zip.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// probe.ipa: an app + share extension built with xcodebuild (CODE_SIGNING_ALLOWED=NO) from a
// two-target XcodeGen project; libjadhello.dylib: clang -dynamiclib for iphoneos arm64 with a
// constructor that NSLogs "JAD-INJECT-HELLO". Both are unsigned build products, no Apple ID.
const PROBE_IPA = path.join(here, "test-fixtures", "probe.ipa");
const HELLO_DYLIB = path.join(here, "test-fixtures", "libjadhello.dylib");
const ZSIGN = process.env.JAD_ZSIGN_PATH ?? "";
const TEAM = "A1B2C3D4E5";
const UDID = "00008110-000A1B2C3D4E5F6A";

async function signProbe(signer: Signer, workRoot: string): Promise<string> {
  const inspection = await inspectIpa(PROBE_IPA);
  const options = {
    bundleId: "dev.jagentdesk.probe.second",
    appName: "Probe Two",
    minimumOs: "16.0",
    removeDeviceRestrictions: true,
    fileSharing: true,
    inject: [HELLO_DYLIB],
  };
  const plan = planBundle(inspection, options);
  const work = path.join(workRoot, signer.name, "work");
  await extractZip(PROBE_IPA, work);
  const appDir = path.join(work, inspection.appDir);
  await editBundle({ appDir, inspection, options, plan });
  const identity = createDevelopmentIdentity(TEAM);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
  const profiles = [plan.mainBundleId, ...plan.extensions.map((e) => e.bundleId)].map((bundleId) =>
    createDevelopmentProfile({ identity, bundleId, deviceUdids: [UDID], expiresAt }),
  );
  const output = path.join(workRoot, signer.name, "signed.ipa");
  await signer.sign({
    appDir,
    outputIpa: output,
    certificatePem: identity.certificatePem,
    privateKeyPem: identity.privateKeyPem,
    chainPem: identity.chainPem,
    profiles,
  });
  return output;
}

async function verifySigned(ipa: string, workRoot: string, label: string): Promise<string> {
  const inspection = await inspectIpa(ipa);
  expect(inspection.bundleId).toBe("dev.jagentdesk.probe.second");
  expect(inspection.name).toBe("Probe Two");
  expect(inspection.minimumOs).toBe("16.0");
  expect(inspection.signed).toBe(true);
  expect(inspection.extensions.map((e) => e.bundleId)).toEqual([
    "dev.jagentdesk.probe.second.share",
  ]);
  const entries = await listZip(ipa);
  const info = parsePlistDict(
    await readZipEntry(ipa, entries.find((e) => e.name === `${inspection.appDir}Info.plist`)!),
  );
  expect(info.UIFileSharingEnabled).toBe(true);
  expect(info.LSSupportsOpeningDocumentsInPlace).toBe(true);
  expect(info.UISupportedDevices).toBeUndefined();

  const out = path.join(workRoot, `${label}-verify`);
  await extractZip(ipa, out);
  const app = path.join(out, inspection.appDir);
  const binary = await readFile(path.join(app, "JadProbe"));
  expect(linkedDylibs(binary)).toContain("@executable_path/Frameworks/libjadhello.dylib");

  const details = await execFileAsync("codesign", ["-dv", "--verbose=4", app]).catch(
    (error: { stderr: string }) => ({ stderr: error.stderr }),
  );
  expect(details.stderr).toContain("Identifier=dev.jagentdesk.probe.second");
  expect(details.stderr).toContain(`Authority=Apple Development: Sideload Test (${TEAM})`);
  const entitlements = await execFileAsync("codesign", ["-d", "--entitlements", ":-", app]);
  expect(entitlements.stdout).toContain(`${TEAM}.dev.jagentdesk.probe.second`);
  const extension = await execFileAsync("codesign", [
    "-dv",
    path.join(app, "PlugIns", "JadProbeShare.appex"),
  ]).catch((error: { stderr: string }) => ({ stderr: error.stderr }));
  expect(extension.stderr).toContain("Identifier=dev.jagentdesk.probe.second.share");
  // The bundle seal must hold: every resource hashed after the profile was embedded.
  const verify = await execFileAsync("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "-v",
    app,
  ]).catch((error: { stderr: string; code: number }) => error);
  expect(String(verify.stderr)).not.toMatch(/sealed resource is missing or invalid|modified/);
  return details.stderr;
}

describe.runIf(process.platform === "darwin")("signing the Xcode-built probe IPA", () => {
  let workRoot = "";
  beforeAll(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), "jad-sign-e2e-"));
  });
  afterAll(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it.runIf(ZSIGN !== "")(
    "zsign signs app + extension with renamed ids and an injected dylib",
    async () => {
      const ipa = await signProbe(new ZsignSigner(ZSIGN), workRoot);
      const details = await verifySigned(ipa, workRoot, "zsign");
      expect(details).toContain(`TeamIdentifier=${TEAM}`);
    },
    120_000,
  );

  it("codesign (macOS fallback) produces the same bundle", async () => {
    // codesign reads TeamIdentifier only from Apple-issued chains, so the test CA leaves it
    // unset; the profile's team still reaches the entitlements checked above.
    const ipa = await signProbe(new CodesignSigner(), workRoot);
    await verifySigned(ipa, workRoot, "codesign");
  }, 120_000);
});
