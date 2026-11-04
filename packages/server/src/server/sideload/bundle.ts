import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SideloadOptions } from "@jagentdesk/protocol/sideload/rpc-schemas";
import type { IpaInspection } from "./ipa.js";
import { addLoadDylib, linkedDylibs } from "./macho.js";
import { asDict, asString, buildXmlPlist, parsePlistDict, type PlistDict } from "./plist.js";

const execFileAsync = promisify(execFile);

/**
 * The 26.5 edits on an extracted `.app`, done before signing so zsign and the codesign
 * fallback sign exactly the same bundle: bundle ids (main + extensions), name, minimum iOS,
 * device restrictions, file sharing, extension removal, icon, inject.
 */

export interface BundlePlan {
  mainBundleId: string;
  /** Extensions that stay, with their final bundle ids; each needs its own App ID. */
  extensions: Array<{ path: string; originalBundleId: string; bundleId: string }>;
}

export class BundleEditError extends Error {
  constructor(
    readonly code: "invalid_option" | "inject_failed" | "substrate_required",
    message: string,
  ) {
    super(message);
    this.name = "BundleEditError";
  }
}

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

function renamedExtensionId(original: string, oldMain: string, newMain: string): string {
  if (original.startsWith(`${oldMain}.`)) return `${newMain}${original.slice(oldMain.length)}`;
  const last = original.split(".").pop() ?? "extension";
  return `${newMain}.${last}`;
}

function extensionKept(bundleId: string, remove: SideloadOptions["removeExtensions"]): boolean {
  if (remove === "all") return false;
  return !(remove ?? []).includes(bundleId);
}

export function planBundle(inspection: IpaInspection, options: SideloadOptions): BundlePlan {
  const requested = options.bundleId?.trim();
  if (requested && !BUNDLE_ID_PATTERN.test(requested)) {
    throw new BundleEditError("invalid_option", `"${requested}" is not a valid bundle ID`);
  }
  const mainBundleId = requested || inspection.bundleId;
  const extensions = inspection.extensions
    .filter((extension) => extensionKept(extension.bundleId, options.removeExtensions))
    .map((extension) => ({
      path: extension.path,
      originalBundleId: extension.bundleId,
      bundleId: renamedExtensionId(extension.bundleId, inspection.bundleId, mainBundleId),
    }));
  return { mainBundleId, extensions };
}

async function readInfo(bundleDir: string): Promise<PlistDict> {
  return parsePlistDict(await readFile(path.join(bundleDir, "Info.plist")));
}

async function writeInfo(bundleDir: string, info: PlistDict): Promise<void> {
  await writeFile(path.join(bundleDir, "Info.plist"), buildXmlPlist(info));
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function replaceId(value: string | null, oldMain: string, newMain: string): string | null {
  if (value === null) return null;
  return value === oldMain || value.startsWith(`${oldMain}.`)
    ? `${newMain}${value.slice(oldMain.length)}`
    : value;
}

async function applyIcon(appDir: string, info: PlistDict, iconPath: string): Promise<void> {
  const png = await readFile(iconPath);
  if (png.subarray(1, 4).toString("latin1") !== "PNG") {
    throw new BundleEditError("invalid_option", "The app icon must be a PNG file");
  }
  // Icons named in CFBundleIconFiles win once CFBundleIconName (the asset catalog) is gone.
  for (const name of ["JADIcon60x60@2x.png", "JADIcon60x60@3x.png", "JADIcon76x76@2x~ipad.png"]) {
    await writeFile(path.join(appDir, name), png);
  }
  const primary = { CFBundleIconFiles: ["JADIcon60x60"] };
  info.CFBundleIcons = { CFBundlePrimaryIcon: primary };
  info["CFBundleIcons~ipad"] = {
    CFBundlePrimaryIcon: { CFBundleIconFiles: ["JADIcon60x60", "JADIcon76x76"] },
  };
  delete info.CFBundleIconName;
}

interface InjectItem {
  kind: "dylib" | "framework" | "bundle";
  source: string;
}

async function debItems(debPath: string, workDir: string): Promise<InjectItem[]> {
  const data = await readFile(debPath);
  if (data.toString("latin1", 0, 8) !== "!<arch>\n") {
    throw new BundleEditError("inject_failed", `${path.basename(debPath)} is not a .deb archive`);
  }
  const target = await mkdtemp(path.join(workDir, "deb-"));
  let offset = 8;
  while (offset + 60 <= data.length) {
    const name = data
      .toString("latin1", offset, offset + 16)
      .trim()
      .replace(/\/$/, "");
    const size = Number.parseInt(data.toString("latin1", offset + 48, offset + 58).trim(), 10);
    const body = data.subarray(offset + 60, offset + 60 + size);
    if (name.startsWith("data.tar")) {
      const tarball = path.join(target, name);
      await writeFile(tarball, body);
      const root = path.join(target, "root");
      await mkdir(root);
      // bsdtar (macOS, Windows) and GNU tar read gz/xz/lzma/zst data members.
      await execFileAsync("tar", ["-xf", tarball, "-C", root]);
      return collectInjectables(root);
    }
    offset += 60 + size + (size % 2);
  }
  throw new BundleEditError("inject_failed", `${path.basename(debPath)} has no data member`);
}

async function collectInjectables(root: string): Promise<InjectItem[]> {
  const items: InjectItem[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".framework")) {
        items.push({ kind: "framework", source: full });
      } else if (entry.isDirectory() && entry.name.endsWith(".bundle")) {
        items.push({ kind: "bundle", source: full });
      } else if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".dylib")) {
        items.push({ kind: "dylib", source: full });
      }
    }
  }
  await walk(root);
  return items;
}

async function injectItems(paths: readonly string[], workDir: string): Promise<InjectItem[]> {
  const items: InjectItem[] = [];
  for (const source of paths) {
    const lower = source.toLowerCase();
    if (lower.endsWith(".dylib")) items.push({ kind: "dylib", source });
    else if (lower.endsWith(".framework")) items.push({ kind: "framework", source });
    else if (lower.endsWith(".bundle")) items.push({ kind: "bundle", source });
    else if (lower.endsWith(".deb")) items.push(...(await debItems(source, workDir)));
    else throw new BundleEditError("invalid_option", `Cannot inject ${path.basename(source)}`);
  }
  return items;
}

const SUBSTRATE = /CydiaSubstrate|libsubstrate|libsubstitute/;

async function applyInject(
  appDir: string,
  executable: string,
  paths: readonly string[],
  workDir: string,
): Promise<string[]> {
  const items = await injectItems(paths, workDir);
  const frameworks = path.join(appDir, "Frameworks");
  const loadPaths: string[] = [];
  for (const item of items) {
    const name = path.basename(item.source);
    if (item.kind === "bundle") {
      await cp(item.source, path.join(appDir, name), { recursive: true });
      continue;
    }
    await mkdir(frameworks, { recursive: true });
    await cp(item.source, path.join(frameworks, name), { recursive: true });
    if (item.kind === "dylib") {
      const linked = linkedDylibs(await readFile(item.source));
      if (linked.some((dep) => SUBSTRATE.test(dep))) {
        throw new BundleEditError(
          "substrate_required",
          `${name} needs CydiaSubstrate; bundling ElleKit for tweaks is not available in this build.`,
        );
      }
      loadPaths.push(`@executable_path/Frameworks/${name}`);
    } else {
      const frameworkInfo = await readInfo(item.source).catch(() => ({}) as PlistDict);
      const binary =
        asString(frameworkInfo.CFBundleExecutable) ?? path.basename(name, ".framework");
      loadPaths.push(`@executable_path/Frameworks/${name}/${binary}`);
    }
  }
  const executablePath = path.join(appDir, executable);
  let binary: Buffer = await readFile(executablePath);
  for (const loadPath of loadPaths) binary = addLoadDylib(binary, loadPath);
  await writeFile(executablePath, binary);
  return loadPaths;
}

async function editMainInfo(
  appDir: string,
  options: SideloadOptions,
  plan: BundlePlan,
): Promise<string[]> {
  const notes: string[] = [];
  const info = await readInfo(appDir);
  info.CFBundleIdentifier = plan.mainBundleId;
  if (options.appName?.trim()) {
    info.CFBundleDisplayName = options.appName.trim();
    notes.push(`Name: ${options.appName.trim()}`);
  }
  if (options.minimumOs?.trim()) {
    if (!/^\d+(\.\d+){0,2}$/.test(options.minimumOs.trim())) {
      throw new BundleEditError("invalid_option", `"${options.minimumOs}" is not an iOS version`);
    }
    info.MinimumOSVersion = options.minimumOs.trim();
  }
  if (options.removeDeviceRestrictions) delete info.UISupportedDevices;
  if (options.fileSharing) {
    info.UIFileSharingEnabled = true;
    info.LSSupportsOpeningDocumentsInPlace = true;
  }
  if (options.iconPath) await applyIcon(appDir, info, options.iconPath);
  await writeInfo(appDir, info);

  return notes;
}

async function editExtensionInfos(
  appDir: string,
  inspection: IpaInspection,
  plan: BundlePlan,
): Promise<void> {
  for (const extension of plan.extensions) {
    const extensionDir = path.join(appDir, extension.path);
    const extensionInfo = await readInfo(extensionDir);
    extensionInfo.CFBundleIdentifier = extension.bundleId;
    const companion = replaceId(
      asString(extensionInfo.WKCompanionAppBundleIdentifier),
      inspection.bundleId,
      plan.mainBundleId,
    );
    if (companion) extensionInfo.WKCompanionAppBundleIdentifier = companion;
    const attributes = asDict(asDict(extensionInfo.NSExtension)?.NSExtensionAttributes);
    const watchApp = replaceId(
      asString(attributes?.WKAppBundleIdentifier),
      inspection.bundleId,
      plan.mainBundleId,
    );
    if (attributes && watchApp) attributes.WKAppBundleIdentifier = watchApp;
    await writeInfo(extensionDir, extensionInfo);
  }
}

/** Applies options to an extracted `.app`; returns what changed, for the progress log. */
export async function editBundle(input: {
  appDir: string;
  inspection: IpaInspection;
  options: SideloadOptions;
  plan: BundlePlan;
}): Promise<string[]> {
  const { appDir, inspection, options, plan } = input;
  const notes: string[] = [];
  const keptPaths = new Set(plan.extensions.map((extension) => extension.path));
  for (const extension of inspection.extensions) {
    if (!keptPaths.has(extension.path)) {
      await rm(path.join(appDir, extension.path), { recursive: true, force: true });
      notes.push(`Removed extension ${extension.bundleId}`);
    }
  }
  if (await exists(path.join(appDir, "Watch"))) {
    // Watch apps need their own App IDs and profiles; free teams cannot sign them.
    await rm(path.join(appDir, "Watch"), { recursive: true, force: true });
    notes.push("Removed the Apple Watch app");
  }

  notes.push(...(await editMainInfo(appDir, options, plan)));

  await editExtensionInfos(appDir, inspection, plan);
  if (plan.mainBundleId !== inspection.bundleId) {
    notes.push(`Bundle ID: ${inspection.bundleId} → ${plan.mainBundleId}`);
  }

  if (options.inject && options.inject.length > 0) {
    const executable = asString((await readInfo(appDir)).CFBundleExecutable);
    if (!executable) throw new BundleEditError("inject_failed", "No CFBundleExecutable");
    const scratch = await mkdtemp(path.join(tmpdir(), "jad-inject-"));
    try {
      const loaded = await applyInject(appDir, executable, options.inject, scratch);
      for (const loadPath of loaded) notes.push(`Injected ${loadPath}`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return notes;
}
