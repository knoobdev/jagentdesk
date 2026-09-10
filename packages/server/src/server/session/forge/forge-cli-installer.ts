import { getForgeDefinition } from "@jagentdesk/protocol/forge-manifest";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { execCommand, spawnProcess } from "../../../utils/spawn.js";

/**
 * Forge Hub — CLI detect + guided auto-install (spec §19.3.5 / §19.3.6 / ADR-0016).
 *
 * A host-level (NOT repo-scoped) helper: the app asks whether a forge's CLI is
 * present and, when a supported package manager exists, drives a guided install
 * streaming progress. All external commands run through {@link spawnProcess} /
 * {@link execCommand}, which augment PATH (e.g. /opt/homebrew/bin) so `brew`/`gh`
 * resolve the same way the rest of the daemon resolves external binaries.
 *
 * ADR-0016 §3: package names are NEVER interpolated from client input. The
 * (packageManager, binary) → package pairs live only in {@link PACKAGE_TABLE}
 * below; an entry that is absent is simply not auto-installable.
 */

const VERSION_TIMEOUT_MS = 5_000;
const PM_PROBE_TIMEOUT_MS = 2_000;
const SUDO_PROBE_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** Canonical package-manager names (never a binary name; apt-get → "apt"). */
type PackageManager = "brew" | "apt" | "dnf" | "pacman" | "zypper" | "winget" | "scoop";

/** Package managers whose install needs root. brew/scoop/winget are user-scope. */
const SUDO_MANAGERS: ReadonlySet<PackageManager> = new Set<PackageManager>([
  "apt",
  "dnf",
  "pacman",
  "zypper",
]);

/**
 * STATIC (packageManager, binary) → package-name table (ADR-0016 §3). A missing
 * cell means "no known package for this pair" → not auto-installable there.
 */
const PACKAGE_TABLE: Record<string, Partial<Record<PackageManager, string>>> = {
  gh: {
    brew: "gh",
    apt: "gh",
    dnf: "gh",
    pacman: "github-cli",
    zypper: "gh",
    winget: "GitHub.cli",
    scoop: "gh",
  },
  glab: {
    brew: "glab",
    apt: "glab",
    dnf: "glab",
    pacman: "glab",
    zypper: "glab",
    winget: "glab.glab",
    scoop: "glab",
  },
  tea: {
    brew: "tea",
    scoop: "tea",
  },
};

/** Per-platform manager probe order; `bin` is the executable, `name` its canonical id. */
function packageManagerProbes(): { name: PackageManager; bin: string }[] {
  switch (process.platform) {
    case "darwin":
      return [{ name: "brew", bin: "brew" }];
    case "win32":
      return [
        { name: "winget", bin: "winget" },
        { name: "scoop", bin: "scoop" },
      ];
    default:
      // Linux and other POSIX: probe the common distro managers in order.
      return [
        { name: "apt", bin: "apt-get" },
        { name: "dnf", bin: "dnf" },
        { name: "pacman", bin: "pacman" },
        { name: "zypper", bin: "zypper" },
        { name: "brew", bin: "brew" }, // Linuxbrew, if present
      ];
  }
}

/** First usable package manager on this host, or null. */
async function detectPackageManager(): Promise<PackageManager | null> {
  for (const probe of packageManagerProbes()) {
    if (await findExecutable(probe.bin, PM_PROBE_TIMEOUT_MS)) return probe.name;
  }
  return null;
}

/** CLI binary for a forge, or null when the forge has no JAgentDesk-driven CLI. */
function forgeBinary(forge: string): string | null {
  return getForgeDefinition(forge)?.signIn?.cli ?? null;
}

/**
 * Run `<path> --version` and return the bare semver string, e.g. "2.100.0".
 * `<cli> --version` prints a decorated line (gh: "gh version 2.100.0 (2026-09-03)");
 * returning that whole line makes the app render an ugly doubled "gh gh version …",
 * so we extract the first `N.N.N` token. Falls back to the first non-empty line when
 * no semver is present, and null on failure.
 */
async function readVersion(binaryPath: string): Promise<string | null> {
  try {
    const res = await execCommand(binaryPath, ["--version"], { timeout: VERSION_TIMEOUT_MS });
    const text = res.stdout.trim() || res.stderr.trim();
    const firstNonEmptyLine = text.split("\n", 1)[0]?.trim() || null;
    const m = text.match(/\d+\.\d+\.\d+/);
    return m ? m[0] : firstNonEmptyLine;
  } catch {
    return null;
  }
}

export interface CliStatus {
  binary: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  packageManager: string | null;
  canAutoInstall: boolean;
}

/**
 * Detect whether a forge's CLI is installed and whether it can be auto-installed.
 * Token-only forges (signIn === null, e.g. Bitbucket) — and any forge id with no
 * known CLI — report `installed:true, binary:"", canAutoInstall:false` because
 * they need no CLI.
 */
export async function detectCliStatus(forge: string): Promise<CliStatus> {
  const binary = forgeBinary(forge);
  if (!binary) {
    return {
      binary: "",
      installed: true,
      version: null,
      path: null,
      packageManager: null,
      canAutoInstall: false,
    };
  }
  const path = await findExecutable(binary);
  const version = path ? await readVersion(path) : null;
  const packageManager = await detectPackageManager();
  const canAutoInstall = packageManager != null && PACKAGE_TABLE[binary]?.[packageManager] != null;
  return {
    binary,
    installed: path != null,
    version,
    path,
    packageManager,
    canAutoInstall,
  };
}

export interface InstallProgress {
  phase: "resolving" | "downloading" | "installing" | "verifying" | "done" | "failed";
  percent?: number | null;
  line?: string | null;
}

export interface InstallResult {
  ok: boolean;
  binary: string;
  version?: string | null;
  packageManager?: string | null;
  error?: string | null;
}

// A line that names a download/fetch step, or carries a percentage token.
const DOWNLOAD_RE = /downloading|fetching|\bdownload\b|\d{1,3}(?:\.\d+)?%/i;
const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)%/;

/** Best-effort phase for one output line (default "installing"). */
function classifyLine(line: string): "downloading" | "installing" {
  return DOWNLOAD_RE.test(line) ? "downloading" : "installing";
}

/** Parse a `NN.N%` token from a line, clamped to [0,100]; null when absent. */
function parsePercent(line: string): number | null {
  const m = line.match(PERCENT_RE);
  if (!m) return null;
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** True when the current process already runs as root (no sudo needed). */
function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Build the install command as an ARGS ARRAY (never a shell string). When a
 * sudo-scoped manager needs elevation, prefix `sudo -n` (non-interactive).
 */
function buildInstallCommand(
  pm: PackageManager,
  pkg: string,
  needsSudo: boolean,
): { command: string; args: string[] } {
  let command: string;
  let args: string[];
  switch (pm) {
    case "brew":
      command = "brew";
      args = ["install", pkg];
      break;
    case "apt":
      command = "apt-get";
      args = ["install", "-y", pkg];
      break;
    case "dnf":
      command = "dnf";
      args = ["install", "-y", pkg];
      break;
    case "pacman":
      command = "pacman";
      args = ["-S", "--noconfirm", pkg];
      break;
    case "zypper":
      command = "zypper";
      args = ["--non-interactive", "install", pkg];
      break;
    case "scoop":
      command = "scoop";
      args = ["install", pkg];
      break;
    case "winget":
      command = "winget";
      args = [
        "install",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "-e",
        "--id",
        pkg,
      ];
      break;
  }
  if (needsSudo) {
    return { command: "sudo", args: ["-n", command, ...args] };
  }
  return { command, args };
}

/** Non-interactive sudo check; true when `sudo -n true` succeeds. */
async function canSudoNonInteractive(): Promise<boolean> {
  try {
    await execCommand("sudo", ["-n", "true"], { timeout: SUDO_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Guided auto-install of a forge CLI. Emits many progress events, then the caller
 * turns the returned {@link InstallResult} into the terminal response. Idempotent:
 * an already-installed binary verifies and returns ok:true without installing.
 */
export async function installCli(
  forge: string,
  emitProgress: (progress: InstallProgress) => void,
): Promise<InstallResult> {
  const status = await detectCliStatus(forge);
  const binary = status.binary;

  // Already present (or token-only forge with no CLI) → verify + done, ok:true.
  if (status.installed) {
    emitProgress({ phase: "verifying" });
    emitProgress({ phase: "done" });
    return {
      ok: true,
      binary,
      version: status.version,
      packageManager: status.packageManager,
    };
  }

  const pm = status.packageManager as PackageManager | null;
  const pkg = pm ? PACKAGE_TABLE[binary]?.[pm] : undefined;
  if (!status.canAutoInstall || !pm || !pkg) {
    emitProgress({ phase: "failed", line: "unsupported" });
    return { ok: false, binary, packageManager: pm, error: "unsupported" };
  }

  // Elevation: sudo-scoped managers need root. Try non-interactive sudo only;
  // never prompt for a password.
  const needsSudo = SUDO_MANAGERS.has(pm) && !isRoot();
  if (needsSudo && !(await canSudoNonInteractive())) {
    emitProgress({ phase: "failed", line: "needs-elevation" });
    return { ok: false, binary, packageManager: pm, error: "needs-elevation" };
  }

  emitProgress({ phase: "resolving" });

  const { command, args } = buildInstallCommand(pm, pkg, needsSudo);

  const exit = await runStreamingInstall(command, args, emitProgress);
  if (exit.timedOut) {
    emitProgress({ phase: "failed", line: "timeout" });
    return { ok: false, binary, packageManager: pm, error: "timeout" };
  }
  if (exit.code !== 0) {
    const message =
      exit.lastStderr || exit.spawnError || `install failed with code ${exit.code ?? "unknown"}`;
    emitProgress({ phase: "failed", line: message });
    return { ok: false, binary, packageManager: pm, error: message };
  }

  // Success: re-resolve and read the freshly installed version.
  const path = await findExecutable(binary);
  const version = path ? await readVersion(path) : null;
  emitProgress({ phase: "verifying" });
  emitProgress({ phase: "done" });
  return { ok: true, binary, version, packageManager: pm };
}

interface StreamingExit {
  code: number | null;
  timedOut: boolean;
  lastStderr: string | null;
  spawnError: string | null;
}

/**
 * Spawn the install command, split stdout+stderr into lines, and emit a progress
 * event per line (phase heuristic + best-effort percent). Resolves on process
 * exit, spawn error, or the install timeout (which kills the child).
 */
function runStreamingInstall(
  command: string,
  args: string[],
  emitProgress: (progress: InstallProgress) => void,
): Promise<StreamingExit> {
  return new Promise<StreamingExit>((resolve) => {
    let settled = false;
    let lastStderr: string | null = null;
    let spawnError: string | null = null;

    const child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    const finish = (exit: StreamingExit): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exit);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, timedOut: true, lastStderr, spawnError });
    }, INSTALL_TIMEOUT_MS);

    const makeLineHandler = (isStderr: boolean) => {
      let buffer = "";
      const handleLine = (raw: string): void => {
        const line = raw.replace(/\r$/, "");
        if (!line.trim()) return;
        if (isStderr) lastStderr = line;
        emitProgress({ phase: classifyLine(line), percent: parsePercent(line), line });
      };
      return (chunk: Buffer | string): void => {
        buffer += chunk.toString();
        // Split on BOTH \n and \r: download tools (e.g. brew) rewrite an
        // in-place progress line terminated by \r, not \n, so a \n-only split
        // would never surface their `NN.N%` updates until the download ended.
        let idx: number;
        while ((idx = buffer.search(/[\r\n]/)) >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      };
    };

    child.stdout?.on("data", makeLineHandler(false));
    child.stderr?.on("data", makeLineHandler(true));

    child.on("error", (err) => {
      // Spawn failure (e.g. ENOENT for a missing manager) — no exit event follows.
      spawnError = err.message;
      finish({ code: null, timedOut: false, lastStderr, spawnError });
    });
    child.on("close", (code) => {
      finish({ code: code ?? null, timedOut: false, lastStderr, spawnError });
    });
  });
}
