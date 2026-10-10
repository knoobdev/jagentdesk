import { resolve } from "node:path";

export function resolveRepositoryDirectory(options: { cwd?: string; host?: string }): string {
  const cwd = options.cwd ?? process.cwd();
  if (!options.host) {
    return resolve(cwd);
  }
  return cwd;
}
