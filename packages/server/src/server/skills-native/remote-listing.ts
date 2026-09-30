import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { z } from "zod";
import {
  SkillsIndexFileSchema,
  type SkillSourceInfo,
  type SkillSourceSpec,
} from "@jagentdesk/protocol/native-skills";
import { NativeSkillsError } from "./errors.js";
import { isScriptPath, listSkillFiles } from "./fs-utils.js";
import {
  EXECUTABLE_MODE,
  GithubTreeClient,
  selectTreeSkills,
  walkContentsFiles,
  walkContentsForSkills,
  type GithubSource,
  type TreeBlob,
  type TreeSkill,
} from "./github-tree.js";
import { NpmSourceClient } from "./npm-source.js";
import {
  cacheKey,
  findSkillDirs,
  LIST_CACHE_TTL_MS,
  NpmPackageCache,
  parseRemoteSource,
  remoteSourceLabel,
  type FetchLike,
  type NpmSource,
} from "./remote-sources.js";
import { canonicalSource } from "./source-config.js";
import { DEFAULT_LIMITS, safeTarget, type ExtractLimits } from "./tar.js";

/**
 * Listing cache of skill sources (spec 22.5, cache 10 minutes).
 *
 * Listing reads metadata only: per skill its SKILL.md text and file list
 * (GitHub: one tree API call + raw SKILL.md files; npm: registry metadata + CDN
 * file list + SKILL.md files; index: the index JSON; local: the directory).
 * Listings live in memory and on disk (`<cacheDir>/<key>.listing.json`) and
 * are served stale-while-revalidate: older than 10 minutes → returned at once
 * and refreshed in the background. Install downloads only the chosen skill's
 * files, pinned to the listed revision (npm: the listed version's tarball).
 */
export const RAW_FETCH_CONCURRENCY = 16;

const ListedFileSchema = z.object({
  /** Relative to the skill directory. */
  path: z.string(),
  size: z.number(),
  isScript: z.boolean(),
  executable: z.boolean(),
});

const ListedSkillSchema = z.object({
  /** Catalog item id: the directory ("." for the root) or, for an index, its entry key. */
  itemId: z.string(),
  /** Directory inside the source ("" for the root). */
  dir: z.string(),
  /** Identity for de-duplicating the same skill across sources. */
  identity: z.string(),
  /** SKILL.md text; null for index entries (metadata only). */
  content: z.string().nullable(),
  /** Blob hash of SKILL.md, to skip unchanged files on refresh. */
  contentSha: z.string().nullable(),
  /** Index metadata (content === null). */
  name: z.string().nullable(),
  description: z.string().nullable(),
  files: z.array(ListedFileSchema),
  /** False when only the skill's top-level files are known (truncated GitHub tree). */
  filesComplete: z.boolean(),
  /** Index entries: the entry's `source`. */
  target: z.string().nullable(),
});

const RemoteListingSchema = z.object({
  revision: z.string().nullable(),
  fetchedAtMs: z.number(),
  via: z.enum(["github-tree", "github-contents", "npm", "index", "local"]),
  etag: z.string().nullable(),
  npmTarball: z.string().nullable(),
  skills: z.array(ListedSkillSchema),
});

export type ListedFile = z.infer<typeof ListedFileSchema>;
export type ListedSkill = z.infer<typeof ListedSkillSchema>;
export type RemoteListing = z.infer<typeof RemoteListingSchema>;

export interface ListingStatus {
  lastRefreshMs: number | null;
  itemCount: number | null;
  revision: string | null;
  error: string | null;
}

export interface ResolvedSkillDir {
  dir: string;
  source: SkillSourceInfo;
}

export interface RemoteListingCacheOptions {
  cacheDir: string;
  fetch: FetchLike;
  now: () => number;
  /** GitHub API token (GITHUB_TOKEN / GH_TOKEN); null = unauthenticated. */
  githubToken?: string | null;
  limits?: ExtractLimits;
  onBackgroundError?: (error: unknown, spec: SkillSourceSpec) => void;
}

const INDEX_TIMEOUT_MS = 30_000;
const INDEX_MAX_BYTES = 5 * 1024 * 1024;

function listingKey(spec: SkillSourceSpec): string {
  const canonical = canonicalSource(spec);
  const readable = canonical.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${readable}-${hash}`.toLowerCase();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return Number(a.path > b.path) - Number(a.path < b.path);
}

function listedFile(blob: TreeBlob, dir: string): ListedFile {
  const relative = dir ? blob.path.slice(dir.length + 1) : blob.path;
  const executable = blob.mode === EXECUTABLE_MODE;
  return {
    path: relative,
    size: blob.size,
    isScript: isScriptPath(relative) || executable,
    executable,
  };
}

function joinDir(base: string | null, child: string | undefined): string {
  return [base ?? "", child ?? ""]
    .flatMap((part) => part.split("/"))
    .filter((part) => part && part !== ".")
    .join("/");
}

/** Identity of a skill directory inside a GitHub/npm source. */
function remoteIdentity(spec: GithubSource | NpmSource, dir: string): string {
  if (spec.kind === "npm") return `npm:${spec.pkg}:${dir}`;
  const ref = spec.ref && spec.ref !== "HEAD" ? `@${spec.ref}` : "";
  return `github:${spec.owner.toLowerCase()}/${spec.repo.toLowerCase()}${ref}:${dir}`;
}

/** The GitHub/npm source and skill directory an index entry points at. */
export function indexEntryTarget(
  target: string,
  entryPath: string | undefined,
): { spec: GithubSource | NpmSource; dir: string } | null {
  const parsed = parseRemoteSource(target);
  if (!parsed) return null;
  if (parsed.kind === "npm") return { spec: parsed, dir: joinDir(null, entryPath) };
  const dir = joinDir(parsed.subpath, entryPath);
  return { spec: { ...parsed, subpath: dir || null }, dir };
}

export class RemoteListingCache {
  private readonly github: GithubTreeClient;
  private readonly npm: NpmSourceClient;
  private readonly packages: NpmPackageCache;
  private readonly memory = new Map<string, RemoteListing>();
  private readonly errors = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<RemoteListing>>();
  private readonly downloads = new Map<string, Promise<string>>();
  private readonly background = new Set<Promise<void>>();
  private readonly limits: ExtractLimits;

  constructor(private readonly options: RemoteListingCacheOptions) {
    this.github = new GithubTreeClient(options.fetch, options.githubToken ?? null, options.now);
    this.npm = new NpmSourceClient(options.fetch);
    this.packages = new NpmPackageCache(options.cacheDir, options.fetch, options.now);
    this.limits = options.limits ?? DEFAULT_LIMITS;
  }

  /**
   * Listing of a source. Cached listings are returned at once (a stale one is
   * revalidated in the background); `refresh` waits for a fresh listing.
   */
  async list(spec: SkillSourceSpec, options: { refresh?: boolean } = {}): Promise<RemoteListing> {
    const key = listingKey(spec);
    if (spec.kind === "local") return this.track(key, this.localListing(spec));
    const cached = await this.cachedListing(key);
    if (options.refresh || !cached) return this.revalidate(spec, key, cached);
    if (this.options.now() - cached.fetchedAtMs >= LIST_CACHE_TTL_MS) {
      this.revalidateInBackground(spec, key, cached);
    }
    return cached;
  }

  /** Last known listing state of a source (no network). */
  async status(spec: SkillSourceSpec): Promise<ListingStatus> {
    const key = listingKey(spec);
    const listing = spec.kind === "local" ? this.memory.get(key) : await this.cachedListing(key);
    return {
      lastRefreshMs: listing?.fetchedAtMs ?? null,
      itemCount: listing?.skills.length ?? null,
      revision: listing?.revision ?? null,
      error: this.errors.get(key) ?? null,
    };
  }

  /** Settles when no background revalidation is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.all(this.background);
    }
  }

  /**
   * Local directory holding one listed skill at the listed revision, or null
   * when the source has no such item. Only that skill's files are downloaded.
   */
  async skillDir(spec: SkillSourceSpec, itemId: string): Promise<ResolvedSkillDir | null> {
    const listing = await this.list(spec);
    const skill = listing.skills.find((candidate) => candidate.itemId === itemId);
    if (!skill) return null;
    switch (spec.kind) {
      case "github":
        return this.githubSkillDir(spec, listing, skill);
      case "npm":
        return this.npmSkillDir(spec, listing, skill);
      case "local": {
        const dir = skill.dir ? safeTarget(spec.path, skill.dir) : spec.path;
        return dir ? { dir, source: { kind: "local", ref: dir, revision: null } } : null;
      }
      case "index":
        return this.indexSkillDir(skill);
    }
  }

  // ── listing ────────────────────────────────────────────────────────────────
  private async track(key: string, listing: Promise<RemoteListing>): Promise<RemoteListing> {
    try {
      const result = await listing;
      this.memory.set(key, result);
      this.errors.delete(key);
      return result;
    } catch (error) {
      this.errors.set(key, describe(error));
      throw error;
    }
  }

  private async cachedListing(key: string): Promise<RemoteListing | null> {
    const inMemory = this.memory.get(key);
    if (inMemory) return inMemory;
    try {
      const file = path.join(this.options.cacheDir, `${key}.listing.json`);
      const listing = RemoteListingSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      this.memory.set(key, listing);
      return listing;
    } catch {
      return null;
    }
  }

  private revalidateInBackground(
    spec: Exclude<SkillSourceSpec, { kind: "local" }>,
    key: string,
    previous: RemoteListing,
  ): void {
    const task = this.revalidate(spec, key, previous).then(
      () => undefined,
      (error: unknown) => this.options.onBackgroundError?.(error, spec),
    );
    this.background.add(task);
    void task.finally(() => this.background.delete(task));
  }

  private revalidate(
    spec: Exclude<SkillSourceSpec, { kind: "local" }>,
    key: string,
    previous: RemoteListing | null,
  ): Promise<RemoteListing> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const next = this.track(key, this.fetchListing(spec, previous))
      .then(async (listing) => {
        await this.writeListing(key, listing);
        return listing;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, next);
    return next;
  }

  private async writeListing(key: string, listing: RemoteListing): Promise<void> {
    const file = path.join(this.options.cacheDir, `${key}.listing.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(this.options.cacheDir, { recursive: true });
      await fs.writeFile(temp, JSON.stringify(listing));
      await fs.rename(temp, file);
    } catch {
      // The in-memory listing still serves; the disk copy is only a warm start.
      await fs.rm(temp, { force: true });
    }
  }

  private fetchListing(
    spec: Exclude<SkillSourceSpec, { kind: "local" }>,
    previous: RemoteListing | null,
  ): Promise<RemoteListing> {
    switch (spec.kind) {
      case "github":
        return this.githubListing(spec, previous);
      case "npm":
        return this.npmListing(spec, previous);
      case "index":
        return this.indexListing(spec, previous);
    }
  }

  private async githubListing(
    spec: GithubSource,
    previous: RemoteListing | null,
  ): Promise<RemoteListing> {
    const reusable = previous?.via.startsWith("github-") ? previous : null;
    const result = await this.github.tree(spec, reusable?.etag ?? null);
    if (result.status === "not-modified") {
      return { ...reusable!, fetchedAtMs: this.options.now() };
    }
    const treeSkills = result.truncated
      ? await walkContentsForSkills(this.github, spec, result.revision)
      : selectTreeSkills(result.blobs, spec.subpath);
    const skills = await this.readSkillFiles(spec, treeSkills, {
      previous: reusable,
      filesComplete: !result.truncated,
      download: (file) => this.github.raw(spec, result.revision, file),
    });
    return {
      revision: result.revision,
      fetchedAtMs: this.options.now(),
      via: result.truncated ? "github-contents" : "github-tree",
      etag: result.etag,
      npmTarball: null,
      skills,
    };
  }

  /** npm versions are immutable: an unchanged `latest` keeps the listing. */
  private async npmListing(
    spec: NpmSource,
    previous: RemoteListing | null,
  ): Promise<RemoteListing> {
    const latest = await this.npm.latest(spec.pkg);
    if (previous?.via === "npm" && previous.revision === latest.version) {
      return { ...previous, fetchedAtMs: this.options.now() };
    }
    const blobs = await this.npm.files(spec.pkg, latest.version);
    const skills = await this.readSkillFiles(spec, selectTreeSkills(blobs, null), {
      previous: null,
      filesComplete: true,
      download: (file) => this.npm.file(spec.pkg, latest.version, file),
    });
    return {
      revision: latest.version,
      fetchedAtMs: this.options.now(),
      via: "npm",
      etag: null,
      npmTarball: latest.tarball,
      skills,
    };
  }

  /** SKILL.md of every skill (bounded concurrency; unchanged blobs reused). */
  private async readSkillFiles(
    spec: GithubSource | NpmSource,
    treeSkills: TreeSkill[],
    options: {
      previous: RemoteListing | null;
      filesComplete: boolean;
      download: (filePath: string) => Promise<Buffer>;
    },
  ): Promise<ListedSkill[]> {
    const known = new Map<string, string>();
    for (const skill of options.previous?.skills ?? []) {
      if (skill.contentSha && skill.content !== null) known.set(skill.contentSha, skill.content);
    }
    const limit = pLimit(RAW_FETCH_CONCURRENCY);
    return Promise.all(
      treeSkills.map((skill) =>
        limit(async () => ({
          itemId: skill.dir || ".",
          dir: skill.dir,
          identity: remoteIdentity(spec, skill.dir),
          content:
            (skill.skillMd.sha ? known.get(skill.skillMd.sha) : undefined) ??
            (await options.download(skill.skillMd.path)).toString("utf8"),
          contentSha: skill.skillMd.sha || null,
          name: null,
          description: null,
          files: skill.files.map((blob) => listedFile(blob, skill.dir)).sort(byPath),
          filesComplete: options.filesComplete,
          target: null,
        })),
      ),
    );
  }

  private async indexListing(
    spec: Extract<SkillSourceSpec, { kind: "index" }>,
    previous: RemoteListing | null,
  ): Promise<RemoteListing> {
    const headers: Record<string, string> = {
      "User-Agent": "jagentdesk-daemon",
      Accept: "application/json",
    };
    if (previous?.etag) headers["If-None-Match"] = previous.etag;
    const response = await this.options.fetch(spec.url, {
      headers,
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
    if (response.status === 304 && previous) {
      return { ...previous, fetchedAtMs: this.options.now() };
    }
    if (!response.ok) {
      throw new NativeSkillsError(
        "source_fetch_failed",
        `Index download failed (${response.status}): ${spec.url}`,
      );
    }
    const text = await response.text();
    if (text.length > INDEX_MAX_BYTES) {
      throw new NativeSkillsError("source_fetch_failed", `Index is too large: ${spec.url}`);
    }
    return {
      revision: null,
      fetchedAtMs: this.options.now(),
      via: "index",
      etag: response.headers.get("etag"),
      npmTarball: null,
      skills: parseIndex(text, spec.url),
    };
  }

  private async localListing(
    spec: Extract<SkillSourceSpec, { kind: "local" }>,
  ): Promise<RemoteListing> {
    const stats = await fs.stat(spec.path).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new NativeSkillsError("invalid_request", `Not a directory: ${spec.path}`);
    }
    const dirs = await findSkillDirs(spec.path, null);
    const skills = await Promise.all(
      dirs.map(async (relative): Promise<ListedSkill | null> => {
        const dir = relative ? path.join(spec.path, relative) : spec.path;
        const content = await fs.readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => null);
        if (content === null) return null;
        const files = await listSkillFiles(dir);
        return {
          itemId: relative || ".",
          dir: relative,
          identity: `local:${dir}`,
          content,
          contentSha: null,
          name: null,
          description: null,
          files: files.map((file) => ({
            path: file.path,
            size: file.size,
            isScript: file.isScript,
            executable: false,
          })),
          filesComplete: true,
          target: null,
        };
      }),
    );
    return {
      revision: null,
      fetchedAtMs: this.options.now(),
      via: "local",
      etag: null,
      npmTarball: null,
      skills: skills.filter((skill): skill is ListedSkill => skill !== null),
    };
  }

  // ── install ────────────────────────────────────────────────────────────────
  private async githubSkillDir(
    spec: GithubSource,
    listing: RemoteListing,
    skill: ListedSkill,
  ): Promise<ResolvedSkillDir> {
    const revision = listing.revision!;
    const target = await this.downloadSkill(spec, revision, skill);
    return {
      dir: target,
      source: { kind: "github", ref: remoteSourceLabel(spec), revision },
    };
  }

  private async npmSkillDir(
    spec: NpmSource,
    listing: RemoteListing,
    skill: ListedSkill,
  ): Promise<ResolvedSkillDir | null> {
    if (!listing.revision || !listing.npmTarball) return null;
    const extracted = await this.packages.materialize(spec, {
      version: listing.revision,
      tarball: listing.npmTarball,
    });
    const dir = skill.dir ? safeTarget(extracted.root, skill.dir) : extracted.root;
    return dir ? { dir, source: { kind: "npm", ref: spec.pkg, revision: listing.revision } } : null;
  }

  private async indexSkillDir(skill: ListedSkill): Promise<ResolvedSkillDir | null> {
    const resolved = skill.target ? indexEntryTarget(skill.target, skill.dir) : null;
    if (!resolved) {
      throw new NativeSkillsError(
        "invalid_request",
        `Index entry has an unsupported source: ${skill.target ?? ""}`,
      );
    }
    // A github target lists only the entry's directory; npm lists the package.
    const listing = await this.list(resolved.spec);
    const match = listing.skills.find((candidate) => candidate.dir === resolved.dir);
    return match ? this.skillDir(resolved.spec, match.itemId) : null;
  }

  private downloadSkill(spec: GithubSource, revision: string, skill: ListedSkill): Promise<string> {
    const dirHash = createHash("sha256").update(skill.dir).digest("hex").slice(0, 16);
    const target = path.join(this.options.cacheDir, `${cacheKey(spec)}.files`, revision, dirHash);
    const pending = this.downloads.get(target);
    if (pending) return pending;
    const next = this.materializeSkill(spec, revision, skill, target).finally(() =>
      this.downloads.delete(target),
    );
    this.downloads.set(target, next);
    return next;
  }

  private async materializeSkill(
    spec: GithubSource,
    revision: string,
    skill: ListedSkill,
    target: string,
  ): Promise<string> {
    if (await isDirectory(target)) return target;
    const files = skill.filesComplete
      ? skill.files
      : (await walkContentsFiles(this.github, spec, revision, skill.dir))
          .map((blob) => listedFile(blob, skill.dir))
          .sort(byPath);
    this.checkLimits(files);
    const staging = `${target}.${randomUUID()}.partial`;
    try {
      await this.fetchSkillFiles(spec, revision, skill.dir, files, staging);
      await fs.rename(staging, target).catch(async (error: unknown) => {
        // A concurrent download of the same revision won the race.
        if (!(await isDirectory(target))) throw error;
      });
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    return target;
  }

  private checkLimits(files: readonly ListedFile[]): void {
    const bytes = files.reduce((total, file) => total + file.size, 0);
    if (files.length > this.limits.maxFiles || bytes > this.limits.maxBytes) throw tooLarge();
  }

  private async fetchSkillFiles(
    spec: GithubSource,
    revision: string,
    skillDir: string,
    files: readonly ListedFile[],
    staging: string,
  ): Promise<void> {
    await fs.mkdir(staging, { recursive: true });
    const limit = pLimit(RAW_FETCH_CONCURRENCY);
    let totalBytes = 0;
    let failed = false;
    const results = await Promise.allSettled(
      files.map((file) =>
        limit(async () => {
          if (failed) return;
          try {
            const destination = safeTarget(staging, file.path);
            if (!destination) {
              throw new NativeSkillsError(
                "source_fetch_failed",
                `Skill file escapes its directory: ${file.path}`,
              );
            }
            const repoPath = skillDir ? `${skillDir}/${file.path}` : file.path;
            const data = await this.github.raw(spec, revision, repoPath);
            totalBytes += data.length;
            if (totalBytes > this.limits.maxBytes) throw tooLarge();
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, data, { mode: file.executable ? 0o755 : 0o644 });
          } catch (error) {
            failed = true;
            throw error;
          }
        }),
      ),
    );
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw (rejected as PromiseRejectedResult).reason;
  }
}

/** Entries of an index file; the first entry wins for a repeated source + path. */
function parseIndex(text: string, url: string): ListedSkill[] {
  let parsed: z.infer<typeof SkillsIndexFileSchema>;
  if (text.trimStart().startsWith("<")) {
    throw new NativeSkillsError(
      "invalid_request",
      `${url} is a web page, not a skills index. Paste a skill's GitHub link or a JSON index URL.`,
    );
  }
  try {
    parsed = SkillsIndexFileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new NativeSkillsError(
      "invalid_request",
      `${url} is not a skills index ({ "skills": [{ name, description, source, path? }] }): ${describe(error)}`,
    );
  }
  const seen = new Set<string>();
  const skills: ListedSkill[] = [];
  for (const entry of parsed.skills) {
    const target = indexEntryTarget(entry.source, entry.path);
    if (!target) continue;
    const identity = remoteIdentity(target.spec, target.dir);
    if (seen.has(identity)) continue;
    seen.add(identity);
    skills.push({
      itemId: `${entry.source}#${entry.path ?? ""}`,
      dir: entry.path ?? "",
      identity,
      content: null,
      contentSha: null,
      name: entry.name,
      description: entry.description,
      files: [],
      filesComplete: false,
      target: entry.source,
    });
  }
  return skills;
}

function tooLarge(): NativeSkillsError {
  return new NativeSkillsError(
    "source_fetch_failed",
    "Skill is larger than the allowed skill download size",
  );
}

async function isDirectory(target: string): Promise<boolean> {
  const stats = await fs.stat(target).catch(() => null);
  return stats?.isDirectory() ?? false;
}
