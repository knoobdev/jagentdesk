import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";

// Where the JAgentDesk CLI lives, for the PATH entry and JAGENTDESK_HOOK_CLI every terminal gets. Kept
// apart from terminal.ts so the daemon can resolve it without loading node-pty.

const require = createRequire(import.meta.url);
const JAGENTDESK_CLI_BIN_ENTRY = "@jagentdesk/cli/bin/jagentdesk";

export function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolveJAgentDeskCliBinDir(): string | null {
  const cliExecutable = resolveJAgentDeskCliExecutablePath();
  return cliExecutable ? dirname(cliExecutable) : null;
}

export function resolveJAgentDeskCliExecutablePath(): string | null {
  const configuredCli = process.env.JAGENTDESK_CLI?.trim();
  if (configuredCli) {
    return resolvePath(configuredCli);
  }

  const cliEntrypoint = resolveJAgentDeskCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(dirname(externalCliEntrypoint));
  if (npmBinDir) {
    const shim = resolveJAgentDeskCliShim(npmBinDir);
    if (shim) {
      return shim;
    }
  }

  return externalCliEntrypoint;
}

function resolveJAgentDeskCliBinEntrypoint(): string | null {
  try {
    return require.resolve(JAGENTDESK_CLI_BIN_ENTRY);
  } catch {
    return null;
  }
}

function findNpmBinDir(startPath: string): string | null {
  let current = startPath;
  while (true) {
    const candidate = join(current, "node_modules", ".bin");
    if (hasJAgentDeskCliShim(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasJAgentDeskCliShim(binDir: string): boolean {
  return resolveJAgentDeskCliShim(binDir) !== null;
}

function resolveJAgentDeskCliShim(binDir: string): string | null {
  for (const name of jagentdeskCliShimNames()) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function jagentdeskCliShimNames(): string[] {
  return process.platform === "win32"
    ? ["jagentdesk.cmd", "jagentdesk.exe", "jagentdesk"]
    : ["jagentdesk"];
}
