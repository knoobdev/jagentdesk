import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type pino from "pino";
import type {
  HostCapabilities,
  HostCapability,
  HostCapabilityId,
} from "@jagentdesk/protocol/host-capabilities";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";

/**
 * Probes what this host can run (spec 24.2, ADR-0024). Every probe is a short
 * `--version`-style command with a timeout; probing never blocks daemon start and
 * never installs anything. Results are broadcast through `server_info`.
 */

const PROBE_TIMEOUT_MS = 5_000;

export interface CommandRunner {
  find(name: string): Promise<string | null>;
  run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export const defaultCommandRunner: CommandRunner = {
  find: (name) => findExecutable(name, PROBE_TIMEOUT_MS),
  run: async (command, args) => {
    try {
      const result = await execCommand(command, args, { timeout: PROBE_TIMEOUT_MS });
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  },
};

export interface HostEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  jagentdeskHome: string;
  exists: (target: string) => boolean;
}

function defaultEnvironment(jagentdeskHome: string): HostEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: os.homedir(),
    jagentdeskHome,
    exists: existsSync,
  };
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

function osName(platform: NodeJS.Platform): string {
  return OS_NAMES[platform] ?? platform;
}

function available(version: string | null): HostCapability {
  return { state: "available", reason: "", version, installable: [] };
}

function missing(reason: string, installable: string[] = []): HostCapability {
  return { state: "missing_tool", reason, version: null, installable };
}

function unsupported(reason: string): HostCapability {
  return { state: "unsupported_os", reason, version: null, installable: [] };
}

/** First `N.N[.N]` in a version banner. */
export function parseVersion(text: string): string | null {
  return /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0] ?? null;
}

/** Candidate Android SDK roots in priority order (env, IDE defaults, JAgentDesk-installed). */
export function androidSdkCandidates(host: HostEnvironment): string[] {
  const candidates = [host.env.ANDROID_HOME, host.env.ANDROID_SDK_ROOT];
  if (host.platform === "darwin") candidates.push(path.join(host.homeDir, "Library/Android/sdk"));
  if (host.platform === "win32") {
    const local = host.env.LOCALAPPDATA ?? path.join(host.homeDir, "AppData", "Local");
    candidates.push(path.join(local, "Android", "Sdk"));
  }
  if (host.platform === "linux") candidates.push(path.join(host.homeDir, "Android", "Sdk"));
  candidates.push(path.join(host.jagentdeskHome, "tools", "android-sdk"));
  return candidates.filter((value): value is string => Boolean(value && value.trim()));
}

/** The Android emulator ships for macOS arm64/x64, Windows x64 and Linux x64 only. */
export function androidEmulatorSupported(platform: NodeJS.Platform, arch: string): boolean {
  if (platform === "darwin") return arch === "arm64" || arch === "x64";
  if (platform === "win32" || platform === "linux") return arch === "x64";
  return false;
}

export interface StaticHostSupport {
  iosSimulators: boolean;
  androidDevices: boolean;
  proxySystemCapture: boolean;
}

/** Capabilities that depend only on the OS/arch (their `unsupported_os` state). */
export function staticHostSupport(platform: NodeJS.Platform, arch: string): StaticHostSupport {
  return {
    iosSimulators: platform === "darwin",
    androidDevices: androidEmulatorSupported(platform, arch),
    proxySystemCapture: platform === "darwin",
  };
}

export class HostCapabilityService {
  private snapshotValue: HostCapabilities = {};
  private readonly listeners = new Set<(capabilities: HostCapabilities) => void>();
  private inflight: Promise<HostCapabilities> | null = null;
  private readonly host: HostEnvironment;
  private readonly runner: CommandRunner;
  private readonly logger: pino.Logger;

  constructor(options: {
    jagentdeskHome: string;
    logger: pino.Logger;
    host?: HostEnvironment;
    runner?: CommandRunner;
  }) {
    this.host = options.host ?? defaultEnvironment(options.jagentdeskHome);
    this.runner = options.runner ?? defaultCommandRunner;
    this.logger = options.logger.child({ module: "host-capabilities" });
  }

  snapshot(): HostCapabilities {
    return this.snapshotValue;
  }

  onChange(listener: (capabilities: HostCapabilities) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Probe everything again; concurrent callers share one probe. */
  refresh(): Promise<HostCapabilities> {
    if (!this.inflight) {
      this.inflight = this.probeAll().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async probeAll(): Promise<HostCapabilities> {
    const probes: Record<HostCapabilityId, () => Promise<HostCapability>> = {
      iosSimulators: () => this.probeIosSimulators(),
      androidDevices: () => this.probeAndroid(),
      docker: () => this.probeDocker(),
      helm: () => this.probeVersioned("helm", ["version", "--short"], ["helm"]),
      proxySystemCapture: () => this.probeSystemProxy(),
      frida: () => this.probeVersioned("frida", ["--version"], []),
      tunnel: () => this.probeVersioned("cloudflared", ["--version"], ["cloudflared"]),
      maestro: () => this.probeVersioned("maestro", ["--version"], ["maestro"]),
      java: () => this.probeJava(),
      forgeGh: () => this.probeVersioned("gh", ["--version"], ["gh"]),
      forgeGlab: () => this.probeVersioned("glab", ["--version"], ["glab"]),
      forgeTea: () => this.probeVersioned("tea", ["--version"], ["tea"]),
    };
    const entries = await Promise.all(
      Object.entries(probes).map(async ([id, probe]) => {
        try {
          return [id, await probe()] as const;
        } catch (error) {
          this.logger.warn({ err: error, id }, "Host capability probe failed");
          return [id, missing("Could not check this tool on the host")] as const;
        }
      }),
    );
    const next: HostCapabilities = Object.fromEntries(entries);
    const changed = JSON.stringify(next) !== JSON.stringify(this.snapshotValue);
    this.snapshotValue = next;
    if (changed) for (const listener of this.listeners) listener(next);
    return next;
  }

  private async probeVersioned(
    binary: string,
    args: string[],
    installable: string[],
  ): Promise<HostCapability> {
    const resolved = await this.runner.find(binary);
    if (!resolved) return missing(`${binary} is not installed on this host`, installable);
    const result = await this.runner.run(resolved, args);
    if (!result.ok) return missing(`${binary} is installed but does not run`, installable);
    return available(parseVersion(`${result.stdout}\n${result.stderr}`));
  }

  private async probeIosSimulators(): Promise<HostCapability> {
    if (this.host.platform !== "darwin") {
      return unsupported(
        `iOS simulators need a macOS host; this host runs ${osName(this.host.platform)}`,
      );
    }
    const xcrun = await this.runner.find("xcrun");
    if (!xcrun) return missing("Install Xcode to use iOS simulators");
    const result = await this.runner.run(xcrun, ["simctl", "help"]);
    if (!result.ok) {
      return missing("Install Xcode and select it with xcode-select to use iOS simulators");
    }
    return available(null);
  }

  private androidSdkRoot(): string | null {
    for (const root of androidSdkCandidates(this.host)) {
      const adb = path.join(
        root,
        "platform-tools",
        this.host.platform === "win32" ? "adb.exe" : "adb",
      );
      if (this.host.exists(adb)) return root;
    }
    return null;
  }

  private async probeAndroid(): Promise<HostCapability> {
    if (!androidEmulatorSupported(this.host.platform, this.host.arch)) {
      return unsupported(
        `The Android emulator does not run on ${osName(this.host.platform)} ${this.host.arch}`,
      );
    }
    const root = this.androidSdkRoot();
    if (!root) return missing("The Android SDK is not installed on this host", ["android-sdk"]);
    const exe = this.host.platform === "win32" ? ".exe" : "";
    const emulator = path.join(root, "emulator", `emulator${exe}`);
    if (!this.host.exists(emulator)) {
      return missing("The Android emulator is not installed in the SDK", ["android-sdk"]);
    }
    const adb = path.join(root, "platform-tools", `adb${exe}`);
    const result = await this.runner.run(adb, ["version"]);
    if (!result.ok) return missing("adb is installed but does not run", ["android-sdk"]);
    return available(parseVersion(result.stdout));
  }

  private async probeDocker(): Promise<HostCapability> {
    const docker = await this.runner.find("docker");
    if (!docker) {
      return missing(
        "Docker is not installed on this host. Install Docker Desktop or Docker Engine.",
      );
    }
    const result = await this.runner.run(docker, ["info", "--format", "{{.ServerVersion}}"]);
    if (!result.ok || !result.stdout.trim()) {
      return {
        state: "not_running",
        reason: "Docker is installed but its engine is not running. Start Docker.",
        version: null,
        installable: [],
      };
    }
    return available(parseVersion(result.stdout));
  }

  private async probeSystemProxy(): Promise<HostCapability> {
    if (this.host.platform !== "darwin") {
      return unsupported(
        `Capturing through the system proxy needs a macOS host; use per-device capture on ${osName(this.host.platform)}`,
      );
    }
    const networksetup = await this.runner.find("networksetup");
    return networksetup ? available(null) : missing("networksetup is not available on this host");
  }

  private async probeJava(): Promise<HostCapability> {
    const java = await this.runner.find("java");
    if (!java) return missing("Java 17 or newer is not installed on this host", ["java"]);
    // `java -version` prints to stderr: `openjdk version "17.0.12" …`.
    const result = await this.runner.run(java, ["-version"]);
    const version = parseVersion(`${result.stderr}\n${result.stdout}`);
    const major = version ? Number.parseInt(version.split(".")[0] ?? "", 10) : Number.NaN;
    if (!result.ok || !Number.isFinite(major)) {
      return missing("Java is installed but does not run", ["java"]);
    }
    if (major < 17)
      return missing(`Java ${version} is too old; Java 17 or newer is needed`, ["java"]);
    return available(version);
  }
}
