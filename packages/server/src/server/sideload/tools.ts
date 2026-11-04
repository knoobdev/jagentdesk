import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { toolsBinDir } from "../host-tools/installer.js";
import { androidSdkCandidates } from "../host-capabilities/service.js";

/**
 * Where sideload finds its helpers: the host-tools bin dir first (what the installer put
 * there), then PATH, then (adb) the Android SDK locations the capability probe knows.
 */

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatesFor(name: string): string[] {
  if (process.platform !== "win32") return [name];
  return [`${name}.exe`, name];
}

function onPath(name: string): string | null {
  const key = Object.keys(process.env).find((entry) => entry.toUpperCase() === "PATH") ?? "PATH";
  for (const dir of (process.env[key] ?? "").split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidatesFor(name)) {
      const full = path.join(dir, candidate);
      if (executable(full)) return full;
    }
  }
  return null;
}

export function resolveHostTool(jagentdeskHome: string, name: string): string | null {
  for (const candidate of candidatesFor(name)) {
    const full = path.join(toolsBinDir(jagentdeskHome), candidate);
    if (executable(full)) return full;
  }
  return onPath(name);
}

export function resolveAdb(jagentdeskHome: string): string | null {
  const found = resolveHostTool(jagentdeskHome, "adb");
  if (found) return found;
  const roots = androidSdkCandidates({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
    jagentdeskHome,
    exists: existsSync,
  });
  for (const root of roots) {
    for (const candidate of candidatesFor("adb")) {
      const full = path.join(root, "platform-tools", candidate);
      if (executable(full)) return full;
    }
  }
  return null;
}
