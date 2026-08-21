import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// GUI-launched daemons (the desktop app) inherit a minimal PATH such as
// `/usr/bin:/bin:/usr/sbin:/sbin`, which omits Homebrew, npm/nvm, and other
// user-level bin directories. Provider CLIs (codex, opencode, gemini, claude…)
// then probe as "unavailable" even though they are installed. We recover the
// real PATH the same way editors like VS Code do: ask the user's login shell,
// and additionally union in well-known install locations. We only ADD entries;
// existing PATH directories are always preserved.

interface EnrichPathLogger {
  debug(obj: unknown, msg?: string): void;
}

const LOGIN_SHELL_TIMEOUT_MS = 3000;
const PATH_START_MARKER = "__JAGENTDESK_PATH_START__";
const PATH_END_MARKER = "__JAGENTDESK_PATH_END__";

function commonBinDirs(): string[] {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".volta", "bin"),
  ];
}

// The login-shell probe is what captures version-managed tools (nvm/asdf/fnm)
// whose bin directories are exported from the user's shell rc. GUI/launchd
// processes frequently start without SHELL set, so fall back to the account's
// real login shell and finally the platform default.
function resolveUserShell(): string | null {
  if (process.platform === "win32") {
    return null;
  }
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const fromUser = os.userInfo().shell?.trim();
    if (fromUser) {
      return fromUser;
    }
  } catch {
    // os.userInfo() can throw on some platforms; fall through to the default.
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

// Ask the user's login+interactive shell for its PATH. Interactive (`-i`) is
// required because Homebrew/nvm/asdf usually export PATH from `.zshrc`/`.bashrc`.
// Bounded and best-effort: any failure falls back to the common directories.
async function resolveLoginShellPath(timeoutMs: number): Promise<string | null> {
  const shell = resolveUserShell();
  if (!shell) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(
      shell,
      ["-lic", `printf "${PATH_START_MARKER}%s${PATH_END_MARKER}" "$PATH"`],
      { timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024 },
    );
    const start = stdout.indexOf(PATH_START_MARKER);
    const end = stdout.indexOf(PATH_END_MARKER);
    if (start < 0 || end < 0 || end <= start) {
      return null;
    }
    const value = stdout.slice(start + PATH_START_MARKER.length, end).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Widen `process.env.PATH` so daemon-side CLI discovery finds tools installed in
 * the user's shell environment even when the process was launched from a GUI
 * with a minimal PATH. Never removes existing entries.
 */
export async function enrichProcessPath(logger?: EnrichPathLogger): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  // Skip the shell probe under the test runner to keep unit/e2e daemons fast and
  // hermetic, and when explicitly disabled.
  if (
    process.env.VITEST ||
    process.env.NODE_ENV === "test" ||
    process.env.JAGENTDESK_NO_PATH_ENRICH
  ) {
    return;
  }
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(existing);
  const merged = [...existing];
  const added: string[] = [];

  const addDir = (dir: string, requireExists: boolean): void => {
    if (!dir || seen.has(dir)) {
      return;
    }
    if (requireExists && !existsSync(dir)) {
      return;
    }
    seen.add(dir);
    merged.push(dir);
    added.push(dir);
  };

  const shellPath = await resolveLoginShellPath(LOGIN_SHELL_TIMEOUT_MS);
  if (shellPath) {
    for (const dir of shellPath.split(path.delimiter).filter(Boolean)) {
      addDir(dir, false);
    }
  }
  for (const dir of commonBinDirs()) {
    addDir(dir, true);
  }

  if (added.length > 0) {
    process.env.PATH = merged.join(path.delimiter);
    logger?.debug(
      { added, source: shellPath ? "login-shell+common" : "common" },
      "Enriched daemon PATH for provider CLI discovery",
    );
  }
}
