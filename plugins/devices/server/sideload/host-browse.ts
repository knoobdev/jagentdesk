import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * "Browse host…" for the Sideload Install picker (26.9, ADR-0032 §9). Lists exactly one folder
 * on the daemon host: its non-hidden sub-folders, and only the installable files of the asked
 * kind (`.ipa` for iOS, `.apk` / `.apks` for Android) with their size. Never reads file contents,
 * never returns any other file.
 */

export type HostBrowseKind = "ios" | "android";

export interface HostBrowseEntry {
  name: string;
  kind: "directory" | "file";
  size?: number;
}

export interface HostBrowseResult {
  path: string;
  parent: string | null;
  entries: HostBrowseEntry[];
}

export class HostBrowseError extends Error {
  constructor(
    readonly code: "invalid_path" | "not_found" | "not_a_directory" | "permission_denied",
    message: string,
  ) {
    super(message);
    this.name = "HostBrowseError";
  }
}

const EXTENSIONS: Record<HostBrowseKind, readonly string[]> = {
  ios: [".ipa"],
  android: [".apk", ".apks"],
};

export function isInstallableFile(name: string, kind: HostBrowseKind): boolean {
  const lower = name.toLowerCase();
  return EXTENSIONS[kind].some((extension) => lower.endsWith(extension));
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

function folderError(error: unknown, folder: string): HostBrowseError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return new HostBrowseError("not_found", `${folder} does not exist`);
  if (code === "ENOTDIR")
    return new HostBrowseError("not_a_directory", `${folder} is not a folder`);
  if (code === "EACCES" || code === "EPERM") {
    return new HostBrowseError("permission_denied", `No permission to open ${folder}`);
  }
  return new HostBrowseError(
    "invalid_path",
    error instanceof Error ? error.message : String(error),
  );
}

// A plain file that is not installable is dropped without a stat; symlinks (and entries the
// filesystem does not type) need one to tell folders from files.
async function describe(
  folder: string,
  dirent: Dirent,
  kind: HostBrowseKind,
): Promise<HostBrowseEntry | null> {
  if (isHidden(dirent.name)) return null;
  if (dirent.isDirectory()) return { name: dirent.name, kind: "directory" };
  const installable = isInstallableFile(dirent.name, kind);
  const untyped = dirent.isSymbolicLink() || !dirent.isFile();
  if (!installable && !untyped) return null;
  const target = await stat(path.join(folder, dirent.name)).catch(() => null);
  if (!target) return null;
  if (target.isDirectory()) return { name: dirent.name, kind: "directory" };
  if (installable && target.isFile()) return { name: dirent.name, kind: "file", size: target.size };
  return null;
}

export async function browseHost(input: {
  path?: string | null;
  kind: HostBrowseKind;
  homeDir?: string;
}): Promise<HostBrowseResult> {
  const requested = input.path?.trim() ? input.path.trim() : (input.homeDir ?? os.homedir());
  if (!path.isAbsolute(requested)) {
    throw new HostBrowseError("invalid_path", "Choose a folder from the list");
  }
  const folder = path.resolve(requested);
  let dirents: Dirent[];
  try {
    dirents = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    throw folderError(error, folder);
  }
  const described = await Promise.all(
    dirents.map((dirent) => describe(folder, dirent, input.kind)),
  );
  const entries = described
    .filter((entry): entry is HostBrowseEntry => entry !== null)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    });
  const parent = path.dirname(folder);
  return { path: folder, parent: parent === folder ? null : parent, entries };
}
