// Packaged path resolution follows Paseo #10273; installation stays with the native skills hub.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledSkillsDir(moduleUrl: string | URL = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "skills"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "skills"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
