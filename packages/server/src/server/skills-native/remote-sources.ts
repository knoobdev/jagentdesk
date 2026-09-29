import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NativeSkillsError } from "./errors.js";
import { extractTarGz } from "./tar.js";

/**
 * Remote skill sources of spec 22.5: a GitHub repository (optionally a
 * sub-path) or an npm package. Parsing, cache keys and the npm package cache
 * live here; listing is in `remote-listing.ts`. No model is ever called. The
 * network is reached through an injected `fetch` so tests never touch it.
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export type RemoteSource =
  | { kind: "github"; owner: string; repo: string; ref: string | null; subpath: string | null }
  | { kind: "npm"; pkg: string };

export const LIST_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function githubSource(owner: string, repo: string, rest: string[]): RemoteSource | null {
  const cleanRepo = repo.replace(/\.git$/, "");
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(cleanRepo)) return null;
  let ref: string | null = null;
  let subpathParts = rest;
  if (rest[0] === "tree" || rest[0] === "blob") {
    ref = rest[1] ?? null;
    subpathParts = rest.slice(2);
  }
  const subpath = subpathParts.filter((part) => part && part !== "." && part !== "..").join("/");
  return { kind: "github", owner, repo: cleanRepo, ref, subpath: subpath || null };
}

function parseHttpUrl(input: string): RemoteSource | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    const [owner, repo, ...rest] = parts;
    return owner && repo ? githubSource(owner, repo, rest) : null;
  }
  if (url.hostname === "www.npmjs.com" || url.hostname === "npmjs.com") {
    if (parts[0] !== "package") return null;
    const pkg = parts[1]?.startsWith("@") ? `${parts[1]}/${parts[2] ?? ""}` : parts[1];
    return pkg && NPM_NAME.test(pkg) ? { kind: "npm", pkg } : null;
  }
  return null;
}

/**
 * Accepted forms: `owner/repo[/sub/path]`, `github:owner/repo`, a github.com
 * URL (with `/tree/<ref>/<path>`), `npm:<package>`, an npmjs.com package URL,
 * or a scoped `@scope/package`.
 */
export function parseRemoteSource(input: string): RemoteSource | null {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) return parseHttpUrl(value);
  if (value.startsWith("npm:")) {
    const pkg = value.slice(4).trim();
    return NPM_NAME.test(pkg) ? { kind: "npm", pkg } : null;
  }
  if (value.startsWith("@")) {
    return NPM_NAME.test(value) ? { kind: "npm", pkg: value } : null;
  }
  const github = value.startsWith("github:") ? value.slice(7) : value;
  const [owner, repo, ...rest] = github.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  return githubSource(owner, repo, rest);
}

export function remoteSourceLabel(source: RemoteSource): string {
  if (source.kind === "npm") return source.pkg;
  const base = `${source.owner}/${source.repo}`;
  return source.subpath ? `${base}/${source.subpath}` : base;
}

export function cacheKey(source: RemoteSource): string {
  const raw =
    source.kind === "npm"
      ? `npm-${source.pkg}`
      : `github-${source.owner}-${source.repo}-${source.ref ?? "HEAD"}`;
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_").toLowerCase();
}

const CacheMetaSchema = z.object({
  revision: z.string().nullable(),
  fetched_at_ms: z.number(),
});

export interface MaterializedSource {
  /** Root of the extracted package. */
  root: string;
  revision: string | null;
  fetchedAtMs: number;
}

export type NpmSource = Extract<RemoteSource, { kind: "npm" }>;

/**
 * Extracted npm package tarballs, used only to install a skill from an npm
 * source (npm has no per-file API). One version per package is kept; the
 * version listed is the version installed.
 */
export class NpmPackageCache {
  private readonly inflight = new Map<string, Promise<MaterializedSource>>();

  constructor(
    private readonly cacheDir: string,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  async materialize(
    source: NpmSource,
    pinned: { version: string; tarball: string },
  ): Promise<MaterializedSource> {
    const key = cacheKey(source);
    const cached = await this.readCache(key);
    if (cached && cached.revision === pinned.version) return cached;
    const flightKey = `${key}@${pinned.version}`;
    const pending = this.inflight.get(flightKey);
    if (pending) return pending;
    const next = this.download(key, pinned).finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, next);
    return next;
  }

  private async readCache(key: string): Promise<MaterializedSource | null> {
    const dir = path.join(this.cacheDir, key);
    try {
      const meta = CacheMetaSchema.parse(
        JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8")),
      );
      return {
        root: path.join(dir, "tree"),
        revision: meta.revision,
        fetchedAtMs: meta.fetched_at_ms,
      };
    } catch {
      return null;
    }
  }

  private async download(
    key: string,
    pinned: { version: string; tarball: string },
  ): Promise<MaterializedSource> {
    const response = await this.fetchImpl(pinned.tarball, {
      headers: { "User-Agent": "jagentdesk-daemon", Accept: "application/octet-stream" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new NativeSkillsError(
        "source_fetch_failed",
        `Download failed (${response.status}): ${pinned.tarball}`,
      );
    }
    const archive = Buffer.from(await response.arrayBuffer());
    const dir = path.join(this.cacheDir, key);
    const staging = path.join(this.cacheDir, `.${key}.${randomUUID()}`);
    try {
      await extractTarGz(archive, path.join(staging, "tree"));
      const fetchedAtMs = this.now();
      await fs.writeFile(
        path.join(staging, "meta.json"),
        JSON.stringify({ revision: pinned.version, fetched_at_ms: fetchedAtMs }, null, 2),
      );
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(staging, dir);
      return { root: path.join(dir, "tree"), revision: pinned.version, fetchedAtMs };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

export const SKILL_SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);
export const SKILL_SEARCH_MAX_DEPTH = 6;

/** Repo-relative (posix) directories containing a SKILL.md, below `subpath`. */
export async function findSkillDirs(root: string, subpath: string | null): Promise<string[]> {
  const start = subpath ? path.resolve(root, subpath) : root;
  const rel = path.relative(root, start);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.push(path.relative(root, dir).split(path.sep).join("/"));
      return;
    }
    if (depth >= SKILL_SEARCH_MAX_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKILL_SEARCH_SKIP_DIRS.has(entry.name)) {
        await walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  await walk(start, 0);
  return found.sort();
}
