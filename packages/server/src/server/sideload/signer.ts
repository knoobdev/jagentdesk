import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import forge from "node-forge";
import { parseProfile } from "./certs.js";
import { buildXmlPlist } from "./plist.js";

const execFileAsync = promisify(execFile);

/**
 * Signs an edited `.app` into an IPA (26.5 "ký"): zsign (MIT, a separate process) on every
 * OS, `codesign` as the macOS fallback when zsign is missing or does not run. The private
 * key is written 0600 into a private temp directory for the signer process and removed
 * right after.
 */

export interface SignInput {
  /** `<work>/Payload/<Name>.app`; `<work>` must hold nothing but `Payload`. */
  appDir: string;
  outputIpa: string;
  certificatePem: string;
  privateKeyPem: string;
  /** Issuers of the certificate when not an Apple WWDR intermediate zsign already knows. */
  chainPem: string[];
  /** Main app profile first, then one per extension. */
  profiles: Buffer[];
}

export interface Signer {
  readonly name: "zsign" | "codesign";
  sign(input: SignInput): Promise<void>;
}

export class SignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignError";
  }
}

function pkcs12(input: SignInput, password: string): Buffer {
  const certs = [input.certificatePem, ...input.chainPem].map((pem) =>
    forge.pki.certificateFromPem(pem),
  );
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    forge.pki.privateKeyFromPem(input.privateKeyPem),
    certs,
    password,
    // 3DES: the one PKCS#12 cipher both macOS `security import` and OpenSSL 3 read.
    { algorithm: "3des" },
  );
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

async function privateDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function commandError(tool: string, error: unknown): SignError {
  const failure = error as { stderr?: string; stdout?: string; message?: string };
  const detail = [failure.stderr, failure.stdout]
    .filter((text): text is string => typeof text === "string" && text.trim() !== "")
    .join("\n")
    .trim();
  return new SignError(
    `${tool} failed: ${(detail || failure.message || "unknown error").slice(-2000)}`,
  );
}

export class ZsignSigner implements Signer {
  readonly name = "zsign";
  constructor(private readonly zsignPath: string) {}

  async sign(input: SignInput): Promise<void> {
    const secrets = await privateDir("jad-zsign-");
    try {
      const password = randomBytes(16).toString("hex");
      const identityPath = path.join(secrets, "identity.p12");
      await writeFile(identityPath, pkcs12(input, password), { mode: 0o600 });
      const args = ["-k", identityPath, "-p", password];
      for (const [index, profile] of input.profiles.entries()) {
        const profilePath = path.join(secrets, `profile-${index}.mobileprovision`);
        await writeFile(profilePath, profile, { mode: 0o600 });
        args.push("-m", profilePath);
      }
      args.push("-f", "-z", "6", "-t", secrets, "-o", input.outputIpa, input.appDir);
      try {
        await execFileAsync(this.zsignPath, args, {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 15 * 60_000,
        });
      } catch (error) {
        throw commandError("zsign", error);
      }
      await stat(input.outputIpa).catch(() => {
        throw new SignError("zsign produced no IPA");
      });
    } finally {
      await rm(secrets, { recursive: true, force: true });
    }
  }
}

/** Nested code inside out: frameworks and dylibs, then extensions, then the app. */
async function nestedCode(appDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const folder of ["Frameworks", "PlugIns", "Extensions"]) {
    const dir = path.join(appDir, folder);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const name = entry.name;
      if (name.endsWith(".framework") || name.endsWith(".dylib") || name.endsWith(".appex")) {
        found.push(path.join(dir, name));
      }
    }
  }
  const rank = (target: string) => (target.endsWith(".appex") ? 1 : 0);
  return found.sort((a, b) => rank(a) - rank(b));
}

let searchListQueue: Promise<unknown> = Promise.resolve();

async function userKeychains(): Promise<string[]> {
  const { stdout } = await execFileAsync("security", ["list-keychains", "-d", "user"]);
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
    .filter((line) => line !== "");
}

/**
 * codesign only finds identities in keychains on the user's search list. The temporary
 * keychain joins the list for the signing run and the previous list is put back exactly;
 * runs are serialized so two signings never interleave their edits.
 */
function withKeychainSearchable<T>(keychain: string, run: () => Promise<T>): Promise<T> {
  const task = searchListQueue.then(async () => {
    const before = await userKeychains();
    await execFileAsync("security", ["list-keychains", "-d", "user", "-s", keychain, ...before]);
    try {
      return await run();
    } finally {
      await execFileAsync("security", ["list-keychains", "-d", "user", "-s", ...before]);
    }
  });
  searchListQueue = task.catch(() => undefined);
  return task;
}

export class CodesignSigner implements Signer {
  readonly name = "codesign";

  async sign(input: SignInput): Promise<void> {
    const scratch = await privateDir("jad-codesign-");
    const keychain = path.join(scratch, "sideload.keychain-db");
    const keychainPassword = randomBytes(24).toString("hex");
    try {
      await this.importIdentity(scratch, keychain, keychainPassword, input);
      await withKeychainSearchable(keychain, () => this.signBundle(input, scratch));
      const payload = path.dirname(input.appDir);
      await rm(input.outputIpa, { force: true });
      await execFileAsync("ditto", [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        payload,
        input.outputIpa,
      ]);
    } finally {
      await execFileAsync("security", ["delete-keychain", keychain]).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async signBundle(input: SignInput, scratch: string): Promise<void> {
    const cert = forge.pki.certificateFromPem(input.certificatePem);
    const identity = forge.md.sha1
      .create()
      .update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
      .digest()
      .toHex()
      .toUpperCase();
    const profiles = input.profiles.map((data) => ({ data, parsed: parseProfile(data) }));
    const base = ["-f", "-s", identity, "--generate-entitlement-der"];
    for (const target of await nestedCode(input.appDir)) {
      const args = [...base];
      if (target.endsWith(".appex")) {
        const bundleId = await this.bundleId(target);
        const profile = profiles.find((candidate) => candidate.parsed.bundleId === bundleId);
        if (!profile) throw new SignError(`No provisioning profile for ${bundleId}`);
        await writeFile(path.join(target, "embedded.mobileprovision"), profile.data);
        const entitlements = path.join(scratch, `${bundleId}.entitlements`);
        await writeFile(entitlements, buildXmlPlist(profile.parsed.entitlements));
        args.push("--entitlements", entitlements);
      }
      await this.codesign([...args, target]);
    }
    const main = profiles[0];
    if (!main) throw new SignError("No provisioning profile for the app");
    await writeFile(path.join(input.appDir, "embedded.mobileprovision"), main.data);
    const entitlements = path.join(scratch, "app.entitlements");
    await writeFile(entitlements, buildXmlPlist(main.parsed.entitlements));
    await this.codesign([...base, "--entitlements", entitlements, input.appDir]);
  }

  private async bundleId(bundleDir: string): Promise<string> {
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(bundleDir, "Info.plist"),
    ]);
    return stdout.trim();
  }

  private async codesign(args: string[]): Promise<void> {
    try {
      await execFileAsync("codesign", args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
    } catch (error) {
      throw commandError("codesign", error);
    }
  }

  private async importIdentity(
    scratch: string,
    keychain: string,
    password: string,
    input: SignInput,
  ): Promise<void> {
    const p12Password = randomBytes(16).toString("hex");
    const p12Path = path.join(scratch, "identity.p12");
    await writeFile(p12Path, pkcs12(input, p12Password), { mode: 0o600 });
    const run = (args: string[]) => execFileAsync("security", args);
    await run(["create-keychain", "-p", password, keychain]);
    await run(["set-keychain-settings", keychain]);
    await run(["unlock-keychain", "-p", password, keychain]);
    await run(["import", p12Path, "-k", keychain, "-P", p12Password, "-T", "/usr/bin/codesign"]);
    await run([
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
  }
}
