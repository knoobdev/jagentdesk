import type { HostCapabilityId } from "@jagentdesk/protocol/host-capabilities";

/**
 * Static tool registry of the platform-aware installer (spec 24.8, ADR-0024 decision 6).
 * Package names and download URLs live only here — never taken from a client
 * (ADR-0016 §3). Facts checked against the vendors' release APIs on 2026-09-30.
 */

export type ReleaseOs = "darwin" | "linux" | "windows";
export type ReleaseArch = "amd64" | "arm64";

export interface HostTarget {
  os: ReleaseOs;
  arch: ReleaseArch;
}

const RELEASE_OS: Partial<Record<NodeJS.Platform, ReleaseOs>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const RELEASE_ARCH: Record<string, ReleaseArch> = { x64: "amd64", arm64: "arm64" };

/** The vendor naming of this host, or null for a platform no tool ships for. */
export function hostTarget(platform: NodeJS.Platform, arch: string): HostTarget | null {
  const os = RELEASE_OS[platform];
  const releaseArch = Object.hasOwn(RELEASE_ARCH, arch) ? RELEASE_ARCH[arch] : undefined;
  return os && releaseArch ? { os, arch: releaseArch } : null;
}

/** Package managers the installer may run: user scope only, never root. */
export type UserPackageManager = "brew" | "winget" | "scoop";

export interface WingetPackage {
  id: string;
  /** Extra args that keep the install user-scoped (portable/zip, no UAC). */
  args?: string[];
}

export type ArchiveKind = "zip" | "tar.gz" | "raw";

/** How the release asset for one host is found and checked. */
export interface ReleaseAssetSpec {
  /** Asset file name for the resolved version. */
  asset: string;
  kind: ArchiveKind;
  /** File name of the binary inside the archive (searched anywhere in it). */
  binaryName: string;
}

export type ChecksumSource =
  /** A sha256sum-format file (`<hex>  <file>`) published with the release. */
  | { kind: "sha256-list"; file: string }
  /** `<asset URL><suffix>` holds the hex digest (optionally followed by the file name). */
  | { kind: "sha256-sidecar"; suffix: string }
  /** The `digest` field GitHub's releases API reports for each asset. */
  | { kind: "github-digest" };

export type ReleaseSource =
  | { kind: "github"; repo: string }
  | { kind: "gitlab"; project: string }
  | { kind: "gitea"; host: string; repo: string }
  /** helm: version from `versionUrl`, assets under `baseUrl`. */
  | { kind: "direct"; versionUrl: string; baseUrl: string };

export interface ReleaseSpec {
  source: ReleaseSource;
  checksum: ChecksumSource;
  /** Asset for a target and version (without a leading "v"); null = no build for it. */
  assetFor(target: HostTarget, version: string): ReleaseAssetSpec | null;
  /** Wrapper script instead of copying one binary (maestro: script + jars). */
  launcher?: { unix: string; windows: string };
}

export interface ToolDefinition {
  id: string;
  /** Command the tool is invoked as. */
  binary: string;
  /** Capability to re-probe after install. */
  capability: HostCapabilityId;
  managers: {
    brew?: string;
    winget?: WingetPackage;
    scoop?: string;
  };
  release?: ReleaseSpec;
  /** Shown in the plan (requirements, caveats). */
  notes?: string[];
  /** Commands for managers the installer never runs (they need root). */
  manualHints?: string[];
}

const exe = (target: HostTarget) => (target.os === "windows" ? ".exe" : "");

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  gh: {
    id: "gh",
    binary: "gh",
    capability: "forgeGh",
    managers: {
      brew: "gh",
      winget: { id: "GitHub.cli", args: ["--installer-type", "zip", "--scope", "user"] },
      scoop: "gh",
    },
    release: {
      source: { kind: "github", repo: "cli/cli" },
      checksum: { kind: "sha256-list", file: "gh_{version}_checksums.txt" },
      assetFor: (target, version) => {
        const os = target.os === "darwin" ? "macOS" : target.os;
        const kind: ArchiveKind = target.os === "linux" ? "tar.gz" : "zip";
        return {
          asset: `gh_${version}_${os}_${target.arch}.${kind}`,
          kind,
          binaryName: `gh${exe(target)}`,
        };
      },
    },
    manualHints: ["sudo apt install gh", "sudo dnf install gh", "sudo pacman -S github-cli"],
  },
  glab: {
    id: "glab",
    binary: "glab",
    capability: "forgeGlab",
    managers: {
      brew: "glab",
      winget: { id: "GLab.GLab", args: ["--scope", "user"] },
      scoop: "glab",
    },
    release: {
      source: { kind: "gitlab", project: "gitlab-org/cli" },
      checksum: { kind: "sha256-list", file: "checksums.txt" },
      assetFor: (target, version) => {
        const kind: ArchiveKind = target.os === "windows" ? "zip" : "tar.gz";
        return {
          asset: `glab_${version}_${target.os}_${target.arch}.${kind}`,
          kind,
          binaryName: `glab${exe(target)}`,
        };
      },
    },
    manualHints: ["sudo apt install glab", "sudo dnf install glab", "sudo pacman -S glab"],
  },
  tea: {
    id: "tea",
    binary: "tea",
    capability: "forgeTea",
    // Debian's `tea` package is an unrelated program: never map tea to apt.
    managers: { brew: "tea", winget: { id: "Gitea.tea" }, scoop: "tea" },
    release: {
      source: { kind: "gitea", host: "gitea.com", repo: "gitea/tea" },
      checksum: { kind: "sha256-list", file: "checksums.txt" },
      assetFor: (target, version) => ({
        asset: `tea-${version}-${target.os}-${target.arch}${exe(target)}`,
        kind: "raw",
        binaryName: `tea${exe(target)}`,
      }),
    },
  },
  helm: {
    id: "helm",
    binary: "helm",
    capability: "helm",
    managers: { brew: "helm", winget: { id: "Helm.Helm" }, scoop: "helm" },
    release: {
      // The helm 3 line: the daemon's helm client targets helm 3 behaviour.
      source: {
        kind: "direct",
        versionUrl: "https://get.helm.sh/helm3-latest-version",
        baseUrl: "https://get.helm.sh",
      },
      checksum: { kind: "sha256-sidecar", suffix: ".sha256sum" },
      assetFor: (target, version) => {
        const kind: ArchiveKind = target.os === "windows" ? "zip" : "tar.gz";
        return {
          asset: `helm-v${version}-${target.os}-${target.arch}.${kind}`,
          kind,
          binaryName: `helm${exe(target)}`,
        };
      },
    },
    manualHints: ["sudo apt install helm", "sudo pacman -S helm"],
  },
  cloudflared: {
    id: "cloudflared",
    binary: "cloudflared",
    capability: "tunnel",
    managers: {
      brew: "cloudflared",
      winget: { id: "Cloudflare.cloudflared", args: ["--installer-type", "portable"] },
      scoop: "cloudflared",
    },
    release: {
      source: { kind: "github", repo: "cloudflare/cloudflared" },
      // The release notes list wrong darwin checksums (4 releases in a row); the API digest is right.
      checksum: { kind: "github-digest" },
      assetFor: (target) => {
        if (target.os === "darwin") {
          return {
            asset: `cloudflared-darwin-${target.arch}.tgz`,
            kind: "tar.gz",
            binaryName: "cloudflared",
          };
        }
        if (target.os === "windows") {
          return target.arch === "amd64"
            ? { asset: "cloudflared-windows-amd64.exe", kind: "raw", binaryName: "cloudflared.exe" }
            : null;
        }
        return {
          asset: `cloudflared-linux-${target.arch}`,
          kind: "raw",
          binaryName: "cloudflared",
        };
      },
    },
  },
  maestro: {
    id: "maestro",
    binary: "maestro",
    capability: "maestro",
    managers: { brew: "mobile-dev-inc/tap/maestro", scoop: "maestro" },
    release: {
      source: { kind: "github", repo: "mobile-dev-inc/maestro" },
      checksum: { kind: "sha256-list", file: "checksums_sha256.txt" },
      assetFor: () => ({ asset: "maestro.zip", kind: "zip", binaryName: "maestro" }),
      launcher: { unix: "maestro/bin/maestro", windows: "maestro/bin/maestro.bat" },
    },
    notes: ["Maestro needs Java 17 or newer."],
  },
};

export function getToolDefinition(tool: string): ToolDefinition | null {
  return Object.hasOwn(TOOL_REGISTRY, tool) ? (TOOL_REGISTRY[tool] ?? null) : null;
}
