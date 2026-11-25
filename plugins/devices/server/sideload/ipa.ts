import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { architectureName, machoSlices, sliceHeaderLength, sliceIsEncrypted } from "./macho.js";
import { asString, parsePlistDict, type PlistDict } from "./plist.js";
import { listZip, readZipEntry, readZipEntryPrefix, type ZipEntry } from "./zip.js";

/** What 26.5 shows before anything is signed: name, ids, encryption, architectures. */
export interface IpaInspection {
  sha256: string;
  sizeBytes: number;
  name: string;
  bundleId: string;
  version: string;
  minimumOs: string | null;
  encrypted: boolean;
  architectures: string[];
  extensions: IpaExtension[];
  hasWatchApp: boolean;
  signed: boolean;
  /** `Payload/<Name>.app/` inside the archive. */
  appDir: string;
}

export interface IpaExtension {
  bundleId: string;
  name: string;
  /** Relative to the .app: `PlugIns/Share.appex`. */
  path: string;
}

export class IpaError extends Error {
  constructor(
    readonly code: "not_an_ipa" | "encrypted_ipa" | "unsupported_ipa",
    message: string,
  ) {
    super(message);
    this.name = "IpaError";
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function bundleName(info: PlistDict, fallback: string): string {
  return asString(info.CFBundleDisplayName) ?? asString(info.CFBundleName) ?? fallback;
}

async function readPlistEntry(file: string, entry: ZipEntry): Promise<PlistDict> {
  return parsePlistDict(await readZipEntry(file, entry));
}

async function executableFacts(
  file: string,
  entry: ZipEntry,
): Promise<{ architectures: string[]; encrypted: boolean }> {
  const head = await readZipEntryPrefix(file, entry, 4096);
  const slices = machoSlices(head);
  const furthest = Math.max(...slices.map((slice) => slice.offset));
  let buffer = await readZipEntryPrefix(file, entry, furthest + 4096);
  const needed = Math.max(
    ...slices.map((slice) => slice.offset + sliceHeaderLength(buffer, slice.offset)),
  );
  if (needed > buffer.length) buffer = await readZipEntryPrefix(file, entry, needed);
  return {
    architectures: slices.map((slice) => architectureName(slice.cputype, slice.cpusubtype)),
    encrypted: slices.some((slice) => sliceIsEncrypted(buffer, slice.offset)),
  };
}

export async function inspectIpa(file: string): Promise<IpaInspection> {
  let entries: ZipEntry[];
  try {
    entries = await listZip(file);
  } catch (error) {
    throw new IpaError("not_an_ipa", error instanceof Error ? error.message : String(error));
  }
  const appMatch = entries
    .map((entry) => /^(Payload\/[^/]+\.app\/)/.exec(entry.name)?.[1])
    .find((match) => match !== undefined);
  if (!appMatch) throw new IpaError("not_an_ipa", "The IPA has no Payload/<App>.app");
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const infoEntry = byName.get(`${appMatch}Info.plist`);
  if (!infoEntry) throw new IpaError("not_an_ipa", "The app has no Info.plist");
  const info = await readPlistEntry(file, infoEntry);
  const bundleId = asString(info.CFBundleIdentifier);
  const executable = asString(info.CFBundleExecutable);
  if (!bundleId || !executable) {
    throw new IpaError("not_an_ipa", "Info.plist lacks CFBundleIdentifier or CFBundleExecutable");
  }
  const executableEntry = byName.get(`${appMatch}${executable}`);
  if (!executableEntry) throw new IpaError("not_an_ipa", `Executable ${executable} is missing`);
  const facts = await executableFacts(file, executableEntry);

  const extensions: IpaExtension[] = [];
  const extensionPattern = new RegExp(
    `^${appMatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}((?:PlugIns|Extensions)/[^/]+\\.appex)/Info\\.plist$`,
  );
  for (const entry of entries) {
    const relative = extensionPattern.exec(entry.name)?.[1];
    if (!relative) continue;
    const extensionInfo = await readPlistEntry(file, entry);
    const extensionId = asString(extensionInfo.CFBundleIdentifier);
    if (!extensionId) continue;
    extensions.push({
      bundleId: extensionId,
      name: bundleName(extensionInfo, path.basename(relative, ".appex")),
      path: relative,
    });
  }

  const stats = await stat(file);
  return {
    sha256: await sha256File(file),
    sizeBytes: stats.size,
    name: bundleName(info, path.basename(appMatch.slice(0, -1), ".app")),
    bundleId,
    version: asString(info.CFBundleShortVersionString) ?? asString(info.CFBundleVersion) ?? "",
    minimumOs: asString(info.MinimumOSVersion),
    encrypted: facts.encrypted,
    architectures: facts.architectures,
    extensions,
    hasWatchApp: entries.some((entry) => entry.name.startsWith(`${appMatch}Watch/`)),
    signed: byName.has(`${appMatch}_CodeSignature/CodeResources`),
    appDir: appMatch,
  };
}

/** Copies (or moves, for uploads) an IPA into `sideload/ipa/<sha256>.ipa`. */
export async function storeIpa(input: {
  source: string;
  ipaDir: string;
  move: boolean;
}): Promise<{ path: string; sha256: string }> {
  const sha256 = await sha256File(input.source);
  await mkdir(input.ipaDir, { recursive: true, mode: 0o700 });
  const target = path.join(input.ipaDir, `${sha256}.ipa`);
  if (path.resolve(input.source) === target) return { path: target, sha256 };
  if (input.move) {
    try {
      await rename(input.source, target);
    } catch {
      await copyFile(input.source, target);
      await rm(input.source, { force: true });
    }
  } else {
    await copyFile(input.source, target);
  }
  return { path: target, sha256 };
}
