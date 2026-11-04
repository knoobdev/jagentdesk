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
  /** Name in `tools/bin` when it differs from `binaryName` (go-ios ships `ios-amd64`). */
  installAs?: string;
}

export type ChecksumSource =
  /** A sha256sum-format file (`<hex>  <file>`) published with the release. */
  | { kind: "sha256-list"; file: string }
  /** `<asset URL><suffix>` holds the hex digest (optionally followed by the file name). */
  | { kind: "sha256-sidecar"; suffix: string }
  /** The `digest` field GitHub's releases API reports for each asset. */
  | { kind: "github-digest" }
  /** Digests reviewed and pinned in this registry, per asset name. */
  | { kind: "pinned"; sha256: Record<string, string> };

export type ReleaseSource =
  | { kind: "github"; repo: string }
  | { kind: "gitlab"; project: string }
  | { kind: "gitea"; host: string; repo: string }
  /** helm: version from `versionUrl`, assets under `baseUrl`. */
  | { kind: "direct"; versionUrl: string; baseUrl: string }
  /** One reviewed GitHub release, never "latest" (sideload helpers, spec 26 / ADR-0032). */
  | { kind: "github-pinned"; repo: string; tag: string };

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

// Sideload helpers (spec 26.5, ADR-0032 §6): both MIT, run as separate processes, pinned to
// reviewed releases with their published SHA-256 (checked 2026-11-04).
const ZSIGN_SHA256: Record<string, string> = {
  "zsign-macos-arm64.tar.gz": "2790ec58a55db5f4282843d0cdbb0b587d19b972331b5285aee2de67f4ab705e",
  "zsign-linux-musl-static.tar.gz":
    "323533d2deb04c84149820f6123fa037adb3c2849d3c213833f9a212da219cad",
  "zsign-linux-aarch64.tar.gz": "cc6f82b351c2f2e136cb08119a50546d8fff797e7d9dda9c0c307ba059dff7e8",
  "zsign-windows-x64.zip": "6fb5e12a5b7179cfe7e729aa471b35ccf86474eba33d8203df119bf62bad77f7",
};
const GO_IOS_SHA256: Record<string, string> = {
  "go-ios-mac.zip": "100f225bfdd039081bcbdaf45029df3e67032673f3e0ca1fa3c050898c230c57",
  "go-ios-linux.zip": "a55fdb4c507391c0548252e01d1deb6ae3c7fd99cfbce842c6f80569cc125604",
  "go-ios-win.zip": "939c6bcaafed183a92afb9f79cc11b1f935fa6389bfc94d3902e3f52c4dff3fe",
};

function zsignAsset(target: HostTarget): ReleaseAssetSpec | null {
  if (target.os === "windows") {
    return target.arch === "amd64"
      ? { asset: "zsign-windows-x64.zip", kind: "zip", binaryName: "zsign.exe" }
      : null;
  }
  if (target.os === "linux") {
    // The amd64 build is static (no libssl on the host needed); arm64 links the system OpenSSL 3.
    if (target.arch === "amd64") {
      return {
        asset: "zsign-linux-musl-static.tar.gz",
        kind: "tar.gz",
        binaryName: "zsign-musl",
        installAs: "zsign",
      };
    }
    return { asset: "zsign-linux-aarch64.tar.gz", kind: "tar.gz", binaryName: "zsign" };
  }
  // The macOS build is arm64 only and links Homebrew's openssl@3; brew installs it with that.
  return target.arch === "arm64"
    ? { asset: "zsign-macos-arm64.tar.gz", kind: "tar.gz", binaryName: "zsign" }
    : null;
}

function goIosAsset(target: HostTarget): ReleaseAssetSpec {
  if (target.os === "windows")
    return { asset: "go-ios-win.zip", kind: "zip", binaryName: "ios.exe" };
  if (target.os === "linux") {
    return {
      asset: "go-ios-linux.zip",
      kind: "zip",
      binaryName: `ios-${target.arch}`,
      installAs: "ios",
    };
  }
  return { asset: "go-ios-mac.zip", kind: "zip", binaryName: "ios" };
}

TOOL_REGISTRY.zsign = {
  id: "zsign",
  binary: "zsign",
  capability: "iosSideload",
  managers: { brew: "zsign" },
  release: {
    source: { kind: "github-pinned", repo: "zhlynn/zsign", tag: "v1.1.3" },
    checksum: { kind: "pinned", sha256: ZSIGN_SHA256 },
    assetFor: zsignAsset,
  },
  notes: ["zsign signs sideloaded IPAs (MIT, runs as a separate process)."],
};

TOOL_REGISTRY["go-ios"] = {
  id: "go-ios",
  binary: "ios",
  capability: "iosSideload",
  managers: {},
  release: {
    source: { kind: "github-pinned", repo: "danielpaulus/go-ios", tag: "v1.3.2" },
    checksum: { kind: "pinned", sha256: GO_IOS_SHA256 },
    assetFor: goIosAsset,
  },
  notes: [
    "go-ios lists and installs apps on iPhones and iPads over USB or Wi-Fi (MIT).",
    "Windows needs Apple Mobile Device Support (iTunes from apple.com); Linux needs usbmuxd.",
  ],
  manualHints: ["sudo apt install usbmuxd", "sudo dnf install usbmuxd"],
};

export function getToolDefinition(tool: string): ToolDefinition | null {
  return Object.hasOwn(TOOL_REGISTRY, tool) ? (TOOL_REGISTRY[tool] ?? null) : null;
}
