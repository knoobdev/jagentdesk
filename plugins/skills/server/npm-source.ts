import { z } from "zod";
import { NativeSkillsError } from "./errors.js";
import type { TreeBlob } from "./github-tree.js";
import type { FetchLike } from "./remote-sources.js";

/**
 * npm source listing without the package tarball: registry `latest` metadata
 * gives the version, jsDelivr's flat file list (unpkg `?meta` as fallback)
 * gives every path, and only the SKILL.md files are fetched from the CDN. The
 * registry tarball is used only to install (npm has no per-file API).
 */
const TIMEOUT_MS = 30_000;

const NpmLatestSchema = z.object({
  version: z.string(),
  dist: z.object({ tarball: z.string().url() }),
});

const JsdelivrFlatSchema = z.object({
  files: z.array(z.object({ name: z.string(), hash: z.string().optional(), size: z.number() })),
});

const UnpkgMetaSchema = z.object({
  files: z.array(
    z.object({ path: z.string(), integrity: z.string().optional(), size: z.number() }),
  ),
});

export interface NpmLatest {
  version: string;
  tarball: string;
}

function stripSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export class NpmSourceClient {
  constructor(private readonly fetchImpl: FetchLike) {}

  private get(url: string, accept: string) {
    return this.fetchImpl(url, {
      headers: { "User-Agent": "jagentdesk-daemon", Accept: accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async latest(pkg: string): Promise<NpmLatest> {
    const response = await this.get(
      `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`,
      "application/json",
    );
    if (!response.ok) {
      throw new NativeSkillsError("source_fetch_failed", `npm package not found: ${pkg}`);
    }
    const latest = NpmLatestSchema.parse(await response.json());
    return { version: latest.version, tarball: latest.dist.tarball };
  }

  /** Every file of `pkg@version` (package-relative paths). */
  async files(pkg: string, version: string): Promise<TreeBlob[]> {
    const jsdelivr = await this.get(
      `https://data.jsdelivr.com/v1/packages/npm/${pkg}@${version}?structure=flat`,
      "application/json",
    ).catch(() => null);
    if (jsdelivr?.ok) {
      const parsed = JsdelivrFlatSchema.safeParse(await jsdelivr.json());
      if (parsed.success) {
        return parsed.data.files.map((file) => ({
          path: stripSlash(file.name),
          mode: "100644",
          sha: file.hash ?? "",
          size: file.size,
        }));
      }
    }
    const unpkg = await this.get(`https://unpkg.com/${pkg}@${version}/?meta`, "application/json");
    const parsed = unpkg.ok ? UnpkgMetaSchema.safeParse(await unpkg.json()) : null;
    if (!parsed?.success) {
      throw new NativeSkillsError(
        "source_fetch_failed",
        `Could not list the files of ${pkg}@${version} (jsDelivr ${jsdelivr?.status ?? "unreachable"}, unpkg ${unpkg.status})`,
      );
    }
    return parsed.data.files.map((file) => ({
      path: stripSlash(file.path),
      mode: "100644",
      sha: file.integrity ?? "",
      size: file.size,
    }));
  }

  /** One file of `pkg@version` from the CDN (jsDelivr, then unpkg). */
  async file(pkg: string, version: string, filePath: string): Promise<Buffer> {
    const suffix = `${pkg}@${version}/${encodePath(filePath)}`;
    const urls = [`https://cdn.jsdelivr.net/npm/${suffix}`, `https://unpkg.com/${suffix}`];
    let lastStatus = "unreachable";
    for (const url of urls) {
      const response = await this.get(url, "*/*").catch(() => null);
      if (response?.ok) return Buffer.from(await response.arrayBuffer());
      lastStatus = String(response?.status ?? "unreachable");
    }
    throw new NativeSkillsError(
      "source_fetch_failed",
      `Download failed (${lastStatus}): ${pkg}@${version}/${filePath}`,
    );
  }
}
