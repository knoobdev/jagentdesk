import { getForgeDefinition } from "@jagentdesk/protocol/forge-manifest";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../../utils/spawn.js";
import type { HostToolInstaller } from "../../host-tools/installer.js";
import { getToolDefinition, hostTarget } from "../../host-tools/registry.js";

/**
 * Forge Hub — CLI detect + guided auto-install (spec §19.3.5 / §19.3.6, ADR-0016,
 * ADR-0024). A host-level (NOT repo-scoped) helper: the app asks whether a forge's
 * CLI is present and drives a guided install that streams progress. Installing goes
 * through the platform-aware installer (`host-tools`): a user-scope package manager,
 * else the vendor release for this OS/arch, SHA-256 verified. Package names and URLs
 * live only in its static registry (ADR-0016 §3).
 */

const VERSION_TIMEOUT_MS = 5_000;

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
 * The platform-aware installer (spec 24.8, ADR-0024) that installs forge CLIs:
 * a user-scope package manager, else the vendor release for this OS/arch. Set by
 * bootstrap; without it nothing is auto-installable.
 */
let toolInstaller: HostToolInstaller | null = null;

export function setForgeToolInstaller(installer: HostToolInstaller | null): void {
  toolInstaller = installer;
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
  const tool = getToolDefinition(binary);
  const target = hostTarget(process.platform, process.arch);
  // A registry tool installs through a user-scope manager or its release; only a
  // host with no release build (and no manager) cannot auto-install.
  const canAutoInstall = Boolean(
    toolInstaller &&
    tool &&
    (tool.release && target ? tool.release.assetFor(target, "0.0.0") : true),
  );
  return {
    binary,
    installed: path != null,
    version,
    path,
    packageManager: null,
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

/**
 * Guided auto-install of a forge CLI through the platform-aware installer. The
 * Forge UI already asked the user, so the plan is carried out straight away. Never
 * runs sudo (spec 24.9 #6). Idempotent: an installed binary returns ok:true.
 */
export async function installCli(
  forge: string,
  emitProgress: (progress: InstallProgress) => void,
): Promise<InstallResult> {
  const status = await detectCliStatus(forge);
  const binary = status.binary;
  if (status.installed) {
    emitProgress({ phase: "verifying" });
    emitProgress({ phase: "done" });
    return { ok: true, binary, version: status.version, packageManager: null };
  }
  if (!toolInstaller || !status.canAutoInstall) {
    emitProgress({ phase: "failed", line: "unsupported" });
    return { ok: false, binary, packageManager: null, error: "unsupported" };
  }
  emitProgress({ phase: "resolving" });
  try {
    const plan = await toolInstaller.plan(binary);
    if (plan.method === "manual") {
      const line = plan.notes.join(" ") || "unsupported";
      emitProgress({ phase: "failed", line });
      return { ok: false, binary, packageManager: null, error: "unsupported" };
    }
    const result = await toolInstaller.install(plan.planId, (line) => {
      emitProgress({ phase: classifyLine(line), percent: parsePercent(line), line });
    });
    emitProgress({ phase: "verifying" });
    emitProgress({ phase: "done" });
    return {
      ok: true,
      binary,
      version: result.version ?? (result.path ? await readVersion(result.path) : null),
      packageManager: plan.manager,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitProgress({ phase: "failed", line: message });
    return { ok: false, binary, packageManager: null, error: message };
  }
}
