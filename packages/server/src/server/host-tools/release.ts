import { createHash } from "node:crypto";
import type { ChecksumSource, HostTarget, ReleaseAssetSpec, ToolDefinition } from "./registry.js";

/**
 * Resolves a tool's latest official release for this host and verifies downloads
 * (spec 24.8). Only the release APIs named in the registry are contacted.
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type HttpFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponse>;

const API_TIMEOUT_MS = 20_000;

export class ToolInstallError extends Error {
  constructor(
    readonly code:
      | "unknown_tool"
      | "plan_expired"
      | "unsupported_platform"
      | "checksum_mismatch"
      | "download_failed"
      | "install_failed",
    message: string,
  ) {
    super(message);
    this.name = "ToolInstallError";
  }
}

export interface ResolvedRelease {
  version: string;
  asset: ReleaseAssetSpec;
  url: string;
  sizeBytes: number | null;
  /** Expected SHA-256 (hex), resolved before any download. */
  sha256: string;
}

interface ReleaseAssetInfo {
  name: string;
  url: string;
  size: number | null;
  digest: string | null;
}

interface ReleaseInfo {
  version: string;
  assets: ReleaseAssetInfo[];
}

function stripV(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

async function getJson(fetch: HttpFetch, url: string, token?: string | null): Promise<unknown> {
  const headers: Record<string, string> = {
    "User-Agent": "jagentdesk-daemon",
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!response.ok) {
    throw new ToolInstallError(
      "download_failed",
      `Release lookup failed (${response.status}): ${url}`,
    );
  }
  return response.json();
}

async function getText(fetch: HttpFetch, url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "jagentdesk-daemon" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ToolInstallError("download_failed", `Download failed (${response.status}): ${url}`);
  }
  return response.text();
}

interface GithubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size?: number;
    digest?: string | null;
  }>;
}

interface GitlabRelease {
  tag_name: string;
  assets?: { links?: Array<{ name: string; url: string; direct_asset_url?: string }> };
}

interface GiteaRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string; size?: number }>;
}

async function latestRelease(
  fetch: HttpFetch,
  tool: ToolDefinition,
  githubToken: string | null,
): Promise<ReleaseInfo> {
  const source = tool.release!.source;
  switch (source.kind) {
    case "github": {
      const release = (await getJson(
        fetch,
        `https://api.github.com/repos/${source.repo}/releases/latest`,
        githubToken,
      )) as GithubRelease;
      return {
        version: stripV(release.tag_name.replace(/^cli-/, "")),
        assets: release.assets.map((asset) => ({
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size ?? null,
          digest: asset.digest ?? null,
        })),
      };
    }
    case "gitlab": {
      const project = encodeURIComponent(source.project);
      const release = (await getJson(
        fetch,
        `https://gitlab.com/api/v4/projects/${project}/releases/permalink/latest`,
      )) as GitlabRelease;
      return {
        version: stripV(release.tag_name),
        assets: (release.assets?.links ?? []).map((link) => ({
          name: link.name,
          url: link.direct_asset_url ?? link.url,
          size: null,
          digest: null,
        })),
      };
    }
    case "gitea": {
      const release = (await getJson(
        fetch,
        `https://${source.host}/api/v1/repos/${source.repo}/releases/latest`,
      )) as GiteaRelease;
      return {
        version: stripV(release.tag_name),
        assets: release.assets.map((asset) => ({
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size ?? null,
          digest: null,
        })),
      };
    }
    case "direct": {
      const version = stripV(await getText(fetch, source.versionUrl));
      return { version, assets: [] };
    }
  }
}

/** `<hex>  <file>` lines → the digest for `name`. */
export function findSha256(list: string, name: string): string | null {
  for (const line of list.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2]?.trim() === name) return match[1]!.toLowerCase();
  }
  return null;
}

async function expectedSha256(
  fetch: HttpFetch,
  checksum: ChecksumSource,
  release: ReleaseInfo,
  asset: ReleaseAssetInfo,
): Promise<string> {
  switch (checksum.kind) {
    case "github-digest": {
      const digest = asset.digest?.replace(/^sha256:/, "").toLowerCase() ?? null;
      if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new ToolInstallError(
          "download_failed",
          `No SHA-256 digest published for ${asset.name}`,
        );
      }
      return digest;
    }
    case "sha256-list": {
      const fileName = checksum.file.replace("{version}", release.version);
      const listAsset = release.assets.find((candidate) => candidate.name === fileName);
      if (!listAsset) {
        throw new ToolInstallError("download_failed", `Checksum file ${fileName} is missing`);
      }
      const digest = findSha256(await getText(fetch, listAsset.url), asset.name);
      if (!digest) {
        throw new ToolInstallError("download_failed", `${fileName} does not list ${asset.name}`);
      }
      return digest;
    }
    case "sha256-sidecar": {
      const text = await getText(fetch, `${asset.url}${checksum.suffix}`);
      const digest = /[a-f0-9]{64}/i.exec(text)?.[0]?.toLowerCase();
      if (!digest) {
        throw new ToolInstallError(
          "download_failed",
          `No SHA-256 in ${asset.url}${checksum.suffix}`,
        );
      }
      return digest;
    }
  }
}

/** The latest release asset for this host with its expected SHA-256 (no binary download). */
export async function resolveRelease(input: {
  fetch: HttpFetch;
  tool: ToolDefinition;
  target: HostTarget;
  githubToken?: string | null;
}): Promise<ResolvedRelease> {
  const spec = input.tool.release;
  if (!spec)
    throw new ToolInstallError("unsupported_platform", `${input.tool.id} has no release download`);
  const release = await latestRelease(input.fetch, input.tool, input.githubToken ?? null);
  const assetSpec = spec.assetFor(input.target, release.version);
  if (!assetSpec) {
    throw new ToolInstallError(
      "unsupported_platform",
      `${input.tool.id} has no build for ${input.target.os} ${input.target.arch}`,
    );
  }
  let asset = release.assets.find((candidate) => candidate.name === assetSpec.asset) ?? null;
  if (!asset && spec.source.kind === "direct") {
    asset = {
      name: assetSpec.asset,
      url: `${spec.source.baseUrl}/${assetSpec.asset}`,
      size: null,
      digest: null,
    };
  }
  if (!asset) {
    throw new ToolInstallError(
      "unsupported_platform",
      `${input.tool.id} ${release.version} has no ${assetSpec.asset}`,
    );
  }
  const sha256 = await expectedSha256(input.fetch, spec.checksum, release, asset);
  return {
    version: release.version,
    asset: assetSpec,
    url: asset.url,
    sizeBytes: asset.size,
    sha256,
  };
}

/** Download and verify; throws `checksum_mismatch` before anything is written. */
export async function downloadVerified(
  fetch: HttpFetch,
  release: ResolvedRelease,
  onProgress?: (line: string) => void,
): Promise<Buffer> {
  onProgress?.(`Downloading ${release.url}`);
  const response = await fetch(release.url, { headers: { "User-Agent": "jagentdesk-daemon" } });
  if (!response.ok) {
    throw new ToolInstallError(
      "download_failed",
      `Download failed (${response.status}): ${release.url}`,
    );
  }
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== release.sha256) {
    throw new ToolInstallError(
      "checksum_mismatch",
      `SHA-256 of ${release.asset.asset} is ${actual}, expected ${release.sha256}`,
    );
  }
  onProgress?.(`Verified SHA-256 ${actual}`);
  return data;
}
