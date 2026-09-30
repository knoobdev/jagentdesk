import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type pino from "pino";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";
import type { HostCapabilityService } from "../host-capabilities/service.js";
import { extractTarGz, safeTarget } from "../skills-native/tar.js";
import {
  downloadVerified,
  resolveRelease,
  ToolInstallError,
  type HttpFetch,
  type ResolvedRelease,
} from "./release.js";
import {
  getToolDefinition,
  hostTarget,
  type ToolDefinition,
  type UserPackageManager,
} from "./registry.js";

/**
 * Platform-aware tool installer (spec 24.8, ADR-0024). Order: already installed →
 * a package manager that needs no root (brew, winget user scope, scoop) → the
 * vendor's release for this OS/arch, SHA-256 verified before extraction → manual
 * instructions. Nothing here runs sudo or asks for elevation.
 */

const PLAN_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const RELEASE_LIMITS = { maxBytes: 1024 * 1024 * 1024, maxFiles: 50_000 };

export interface ToolInstallPlan {
  planId: string;
  tool: string;
  version: string | null;
  method: "present" | "package-manager" | "release" | "manual";
  manager: UserPackageManager | null;
  command: string[] | null;
  url: string | null;
  sizeBytes: number | null;
  checksum: "sha256" | null;
  destination: string | null;
  notes: string[];
}

export interface ToolInstallProgress {
  planId: string;
  line: string;
}

export interface ToolInstallResult {
  ok: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
}

interface StoredPlan {
  plan: ToolInstallPlan;
  createdAtMs: number;
  release: ResolvedRelease | null;
}

export type ManagerRunner = (
  command: string,
  args: string[],
  onLine: (line: string) => void,
) => Promise<{ code: number | null; output: string }>;

/** Runs a package-manager command, streaming output lines; never through a shell string. */
export const defaultManagerRunner: ManagerRunner = async (command, args, onLine) => {
  try {
    const result = await execCommand(command, args, { timeout: INSTALL_TIMEOUT_MS });
    const output = `${result.stdout}\n${result.stderr}`;
    for (const line of output.split(/[\r\n]+/)) if (line.trim()) onLine(line);
    return { code: 0, output };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message ?? ""}`;
    for (const line of output.split(/[\r\n]+/)) if (line.trim()) onLine(line);
    return { code: typeof failure.code === "number" ? failure.code : 1, output };
  }
};

export interface HostToolInstallerOptions {
  jagentdeskHome: string;
  logger: pino.Logger;
  capabilities?: HostCapabilityService | null;
  fetch?: HttpFetch;
  platform?: NodeJS.Platform;
  arch?: string;
  find?: (name: string) => Promise<string | null>;
  runManager?: ManagerRunner;
  now?: () => number;
  githubToken?: string | null;
}

/** `$JAGENTDESK_HOME/tools/bin`: every tool the installer adds is reachable here. */
export function toolsBinDir(jagentdeskHome: string): string {
  return path.join(jagentdeskHome, "tools", "bin");
}

/**
 * Put the installer's bin dir (and, on Windows, the winget/scoop link dirs) on this
 * process's PATH so every spawn resolves tools installed after the daemon started.
 */
export function ensureToolDirsOnPath(
  jagentdeskHome: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = (env[key] ?? "").split(path.delimiter).filter(Boolean);
  const extra = [toolsBinDir(jagentdeskHome)];
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA;
    const profile = env.USERPROFILE;
    if (local) extra.push(path.join(local, "Microsoft", "WinGet", "Links"));
    if (profile) extra.push(path.join(profile, "scoop", "shims"));
  }
  const missing = extra.filter((dir) => !current.includes(dir));
  if (missing.length > 0) env[key] = [...missing, ...current].join(path.delimiter);
}

/**
 * Windows: winget/scoop change PATH only for new processes. Re-read the machine
 * and user PATH from the registry and merge the new directories into this process.
 */
export async function refreshWindowsPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const read = async (hive: string): Promise<string[]> => {
    try {
      const { stdout } = await execCommand("reg", ["query", hive, "/v", "Path"], {
        timeout: PROBE_TIMEOUT_MS,
      });
      const value = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(stdout)?.[1] ?? "";
      return value
        .split(";")
        .map((entry) =>
          entry.replace(/%([^%]+)%/g, (whole, name: string) => {
            const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
            return match ? (env[match] ?? whole) : whole;
          }),
        )
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const machine = await read(
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  );
  const user = await read("HKCU\\Environment");
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "Path";
  const current = (env[key] ?? "").split(";").filter(Boolean);
  const additions = [...machine, ...user].filter((dir) => !current.includes(dir));
  if (additions.length > 0) env[key] = [...current, ...additions].join(";");
}

function managerCommand(
  manager: UserPackageManager,
  tool: ToolDefinition,
): { command: string; args: string[] } | null {
  if (manager === "brew" && tool.managers.brew) {
    return { command: "brew", args: ["install", tool.managers.brew] };
  }
  if (manager === "scoop" && tool.managers.scoop) {
    return { command: "scoop", args: ["install", tool.managers.scoop] };
  }
  if (manager === "winget" && tool.managers.winget) {
    return {
      command: "winget",
      args: [
        "install",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "-e",
        "--id",
        tool.managers.winget.id,
        ...(tool.managers.winget.args ?? []),
      ],
    };
  }
  return null;
}

async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findFile(path.join(root, entry.name), name);
      if (found) return found;
    }
  }
  return null;
}

async function writeZip(data: Buffer, destination: string): Promise<void> {
  const files = unzipSync(new Uint8Array(data));
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    total += content.length;
    if (total > RELEASE_LIMITS.maxBytes) {
      throw new ToolInstallError("install_failed", "Archive is larger than allowed");
    }
    const target = safeTarget(destination, name);
    if (!target) throw new ToolInstallError("install_failed", `Unsafe path in archive: ${name}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: 0o755 });
  }
}

export class HostToolInstaller {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly find: (name: string) => Promise<string | null>;
  private readonly runManager: ManagerRunner;
  private readonly now: () => number;
  private readonly logger: pino.Logger;

  constructor(private readonly options: HostToolInstallerOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.find = options.find ?? ((name) => findExecutable(name, PROBE_TIMEOUT_MS));
    this.runManager = options.runManager ?? defaultManagerRunner;
    this.now = options.now ?? Date.now;
    this.logger = options.logger.child({ module: "host-tools" });
  }

  private managersForPlatform(): UserPackageManager[] {
    if (this.platform === "win32") return ["winget", "scoop"];
    return ["brew"];
  }

  /** What installing `tool` would do on this host; nothing is installed yet. */
  async plan(toolId: string): Promise<ToolInstallPlan> {
    const tool = getToolDefinition(toolId);
    if (!tool) throw new ToolInstallError("unknown_tool", `No installer for ${toolId}`);
    const base: ToolInstallPlan = {
      planId: randomUUID(),
      tool: tool.id,
      version: null,
      method: "manual",
      manager: null,
      command: null,
      url: null,
      sizeBytes: null,
      checksum: null,
      destination: null,
      notes: [...(tool.notes ?? [])],
    };
    let release: ResolvedRelease | null = null;
    let plan = base;
    const installed = await this.find(tool.binary);
    if (installed) {
      plan = { ...base, method: "present", destination: installed };
    } else {
      plan = (await this.managerPlan(tool, base)) ?? base;
      if (plan.method === "manual") {
        const resolved = await this.releasePlan(tool, base);
        plan = resolved.plan;
        release = resolved.release;
      }
    }
    this.plans.set(plan.planId, { plan, createdAtMs: this.now(), release });
    return plan;
  }

  private async managerPlan(
    tool: ToolDefinition,
    base: ToolInstallPlan,
  ): Promise<ToolInstallPlan | null> {
    for (const manager of this.managersForPlatform()) {
      const command = managerCommand(manager, tool);
      if (!command || !(await this.find(manager))) continue;
      return {
        ...base,
        method: "package-manager",
        manager,
        command: [command.command, ...command.args],
      };
    }
    return null;
  }

  private async releasePlan(
    tool: ToolDefinition,
    base: ToolInstallPlan,
  ): Promise<{ plan: ToolInstallPlan; release: ResolvedRelease | null }> {
    const target = hostTarget(this.platform, this.arch);
    const manual = {
      ...base,
      notes: [...base.notes, ...(tool.manualHints ?? []).map((hint) => `Run yourself: ${hint}`)],
    };
    if (!tool.release || !target || !this.options.fetch) return { plan: manual, release: null };
    try {
      const release = await resolveRelease({
        fetch: this.options.fetch,
        tool,
        target,
        githubToken: this.options.githubToken ?? null,
      });
      return {
        plan: {
          ...base,
          method: "release",
          version: release.version,
          url: release.url,
          sizeBytes: release.sizeBytes,
          checksum: "sha256",
          destination: path.join(this.options.jagentdeskHome, "tools", tool.id, release.version),
        },
        release,
      };
    } catch (error) {
      if (error instanceof ToolInstallError && error.code === "unsupported_platform") {
        return { plan: { ...manual, notes: [...manual.notes, error.message] }, release: null };
      }
      throw error;
    }
  }

  /** Carry out a plan made in the last 10 minutes. */
  async install(planId: string, onProgress: (line: string) => void): Promise<ToolInstallResult> {
    const stored = this.plans.get(planId);
    if (!stored || this.now() - stored.createdAtMs > PLAN_TTL_MS) {
      throw new ToolInstallError("plan_expired", "This install plan expired; review it again");
    }
    this.plans.delete(planId);
    const { plan } = stored;
    const tool = getToolDefinition(plan.tool)!;
    try {
      if (plan.method === "manual") {
        throw new ToolInstallError(
          "unsupported_platform",
          `${tool.id} cannot be installed automatically on this host`,
        );
      }
      if (plan.method === "package-manager") await this.installWithManager(plan, onProgress);
      if (plan.method === "release") await this.installRelease(tool, stored.release!, onProgress);
      if (this.platform === "win32") await refreshWindowsPath();
      ensureToolDirsOnPath(this.options.jagentdeskHome);
      const resolved = await this.find(tool.binary);
      if (!resolved) {
        throw new ToolInstallError(
          "install_failed",
          `${tool.binary} is still not found after install`,
        );
      }
      await this.options.capabilities?.refresh();
      const capability = this.options.capabilities?.snapshot()[tool.capability];
      return {
        ok: true,
        version: capability?.version ?? plan.version,
        path: resolved,
        error: null,
      };
    } catch (error) {
      this.logger.warn({ err: error, tool: tool.id }, "Tool install failed");
      throw error;
    }
  }

  private async installWithManager(
    plan: ToolInstallPlan,
    onProgress: (line: string) => void,
  ): Promise<void> {
    const [command, ...args] = plan.command!;
    onProgress(`$ ${plan.command!.join(" ")}`);
    const result = await this.runManager(command!, args, onProgress);
    if (result.code !== 0) {
      throw new ToolInstallError(
        "install_failed",
        `${command} exited with ${result.code ?? "an error"}`,
      );
    }
  }

  private async installRelease(
    tool: ToolDefinition,
    release: ResolvedRelease,
    onProgress: (line: string) => void,
  ): Promise<void> {
    const data = await downloadVerified(this.options.fetch!, release, onProgress);
    const toolsRoot = path.join(this.options.jagentdeskHome, "tools");
    const finalDir = path.join(toolsRoot, tool.id, release.version);
    const staging = `${finalDir}.${randomUUID()}.partial`;
    await fs.mkdir(staging, { recursive: true });
    try {
      onProgress(`Extracting ${release.asset.asset}`);
      if (release.asset.kind === "zip") await writeZip(data, staging);
      else if (release.asset.kind === "tar.gz") await extractTarGz(data, staging, RELEASE_LIMITS);
      else await fs.writeFile(path.join(staging, release.asset.binaryName), data, { mode: 0o755 });
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(staging, finalDir);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    await this.linkIntoBin(tool, release, finalDir);
    onProgress(`Installed ${tool.id} ${release.version} in ${finalDir}`);
  }

  /** Expose the tool as `$JAGENTDESK_HOME/tools/bin/<binary>` (a copy or a launcher). */
  private async linkIntoBin(
    tool: ToolDefinition,
    release: ResolvedRelease,
    installDir: string,
  ): Promise<void> {
    const binDir = toolsBinDir(this.options.jagentdeskHome);
    await fs.mkdir(binDir, { recursive: true });
    const windows = this.platform === "win32";
    const launcher = tool.release?.launcher;
    if (launcher) {
      const target = path.join(installDir, windows ? launcher.windows : launcher.unix);
      if (windows) {
        await fs.writeFile(
          path.join(binDir, `${tool.binary}.cmd`),
          `@echo off\r\n"${target}" %*\r\n`,
        );
      } else {
        await fs.chmod(target, 0o755);
        await fs.writeFile(path.join(binDir, tool.binary), `#!/bin/sh\nexec "${target}" "$@"\n`, {
          mode: 0o755,
        });
      }
      return;
    }
    const binary = await findFile(installDir, release.asset.binaryName);
    if (!binary) {
      throw new ToolInstallError(
        "install_failed",
        `${release.asset.binaryName} not found in the archive`,
      );
    }
    const destination = path.join(binDir, release.asset.binaryName);
    await fs.rm(destination, { force: true });
    await fs.copyFile(binary, destination);
    if (!windows) await fs.chmod(destination, 0o755);
  }
}
