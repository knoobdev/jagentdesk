import pLimit from "p-limit";
import { z } from "zod";
import { NativeSkillsError } from "./errors.js";
import {
  SKILL_SEARCH_MAX_DEPTH,
  SKILL_SEARCH_SKIP_DIRS,
  type FetchLike,
  type FetchResponseLike,
  type RemoteSource,
} from "./remote-sources.js";

/**
 * GitHub listing without downloading the repository (spec 22.5): one
 * `git/trees/<ref>?recursive=1` API call per repository gives every path, size
 * and mode plus the resolved commit; file bytes come from
 * raw.githubusercontent.com pinned to that commit (not counted against the API
 * rate limit). A tree too large for one response (`truncated`) is walked with
 * the contents API, only as deep as needed to find SKILL.md files.
 */
export type GithubSource = Extract<RemoteSource, { kind: "github" }>;

export interface TreeBlob {
  /** Repo-relative posix path. */
  path: string;
  mode: string;
  sha: string;
  size: number;
}

export interface TreeSkill {
  /** Repo-relative directory holding SKILL.md ("" for the repository root). */
  dir: string;
  skillMd: TreeBlob;
  /** Files below `dir` (symlinks and submodules excluded). */
  files: TreeBlob[];
}

export type TreeResult =
  | { status: "not-modified" }
  | {
      status: "ok";
      revision: string;
      etag: string | null;
      truncated: boolean;
      blobs: TreeBlob[];
    };

const API_TIMEOUT_MS = 30_000;
const RAW_TIMEOUT_MS = 30_000;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SYMLINK_MODE = "120000";
export const EXECUTABLE_MODE = "100755";
/** Contents API calls one truncated-tree walk may spend (60/h unauthenticated). */
export const CONTENTS_WALK_MAX_CALLS = 40;
const CONTENTS_WALK_CONCURRENCY = 4;

const TreeResponseSchema = z.object({
  sha: z.string(),
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().optional(),
    }),
  ),
});

const ContentsResponseSchema = z.array(
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.string(),
    sha: z.string(),
    size: z.number().optional(),
  }),
);

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function repoLabel(source: GithubSource): string {
  return `${source.owner}/${source.repo}`;
}

export function rawFileUrl(source: GithubSource, revision: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${revision}/${encodePath(filePath)}`;
}

export function treeApiUrl(source: GithubSource): string {
  const ref = encodePath(source.ref ?? "HEAD");
  return `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${ref}?recursive=1`;
}

export function contentsApiUrl(source: GithubSource, dir: string, revision: string): string {
  const suffix = dir ? `/${encodePath(dir)}` : "";
  return `https://api.github.com/repos/${source.owner}/${source.repo}/contents${suffix}?ref=${revision}`;
}

function rateLimitMessage(
  source: GithubSource,
  response: FetchResponseLike,
  now: () => number,
): string | null {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryHeader = response.headers.get("retry-after");
  const retryAfter = retryHeader ? Number(retryHeader) : Number.NaN;
  const limited =
    response.status === 429 ||
    (response.status === 403 && (remaining === "0" || Number.isFinite(retryAfter)));
  if (!limited) return null;
  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  let resetAtMs: number | null = null;
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) resetAtMs = resetSeconds * 1000;
  else if (Number.isFinite(retryAfter) && retryAfter > 0) resetAtMs = now() + retryAfter * 1000;
  const when = resetAtMs
    ? ` It resets at ${new Date(resetAtMs).toISOString()} (in ${Math.max(1, Math.ceil((resetAtMs - now()) / 60_000))} min).`
    : "";
  return (
    `GitHub API rate limit reached while listing ${repoLabel(source)}.${when}` +
    " Set GITHUB_TOKEN or GH_TOKEN for the daemon to raise the limit."
  );
}

export class GithubTreeClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    /** Sent to api.github.com only (never logged); null = unauthenticated. */
    private readonly token: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  private async api(
    source: GithubSource,
    url: string,
    etag: string | null = null,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "User-Agent": "jagentdesk-daemon",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (etag) headers["If-None-Match"] = etag;
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const response = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.ok || (response.status === 304 && etag)) return response;
    const limited = rateLimitMessage(source, response, this.now);
    if (limited) throw new NativeSkillsError("source_fetch_failed", limited);
    const reason = response.status === 404 ? "not found (or private)" : `error ${response.status}`;
    throw new NativeSkillsError(
      "source_fetch_failed",
      `GitHub ${reason} while listing ${repoLabel(source)}`,
    );
  }

  /**
   * The recursive tree of `source.ref` (default branch when null). With `etag`
   * the request is conditional: an unchanged tree answers 304, which GitHub
   * does not count against the rate limit.
   */
  async tree(source: GithubSource, etag: string | null): Promise<TreeResult> {
    const response = await this.api(source, treeApiUrl(source), etag);
    if (response.status === 304) return { status: "not-modified" };
    const parsed = TreeResponseSchema.safeParse(await response.json());
    // For a commit-ish path (branch, HEAD, tag, commit) GitHub answers with the
    // resolved commit sha, which pins every later raw download.
    if (!parsed.success || !COMMIT_SHA.test(parsed.data.sha)) {
      throw new NativeSkillsError(
        "source_fetch_failed",
        `Unexpected GitHub tree response for ${repoLabel(source)}`,
      );
    }
    const blobs = parsed.data.tree
      .filter((entry) => entry.type === "blob" && entry.mode !== SYMLINK_MODE)
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        sha: entry.sha,
        size: entry.size ?? 0,
      }));
    return {
      status: "ok",
      revision: parsed.data.sha,
      etag: response.headers.get("etag"),
      truncated: parsed.data.truncated === true,
      blobs,
    };
  }

  /** Entries of one directory at a pinned commit (contents API). */
  async contents(source: GithubSource, dir: string, revision: string): Promise<ContentsEntry[]> {
    const response = await this.api(source, contentsApiUrl(source, dir, revision));
    const parsed = ContentsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new NativeSkillsError(
        "source_fetch_failed",
        `Unexpected GitHub contents response for ${repoLabel(source)}/${dir}`,
      );
    }
    return parsed.data.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type,
      sha: entry.sha,
      size: entry.size ?? 0,
    }));
  }

  /** One file at a pinned commit. */
  async raw(source: GithubSource, revision: string, filePath: string): Promise<Buffer> {
    const url = rawFileUrl(source, revision, filePath);
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": "jagentdesk-daemon" },
      signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new NativeSkillsError(
        "source_fetch_failed",
        `Download failed (${response.status}): ${url}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export interface ContentsEntry {
  name: string;
  path: string;
  /** "file" | "dir" | "symlink" | "submodule". */
  type: string;
  sha: string;
  size: number;
}

function contentsBlob(entry: ContentsEntry): TreeBlob {
  return { path: entry.path, mode: "100644", sha: entry.sha, size: entry.size };
}

class CallBudget {
  private used = 0;

  constructor(
    private readonly source: GithubSource,
    private readonly max: number,
  ) {}

  spend(): void {
    this.used += 1;
    if (this.used > this.max) {
      throw new NativeSkillsError(
        "source_fetch_failed",
        `${repoLabel(this.source)} is too large to list without downloading it; ` +
          "add the source with the sub-path that holds the skills",
      );
    }
  }
}

/**
 * Skill directories of a repository whose tree is truncated: breadth-first
 * contents calls below `subpath`, stopping at directories holding SKILL.md and
 * at the search depth. The skill's own top-level entries are its file list
 * (sub-directories are resolved when installing).
 */
export async function walkContentsForSkills(
  client: GithubTreeClient,
  source: GithubSource,
  revision: string,
): Promise<TreeSkill[]> {
  const start = source.subpath ?? "";
  const budget = new CallBudget(source, CONTENTS_WALK_MAX_CALLS);
  const limit = pLimit(CONTENTS_WALK_CONCURRENCY);
  const skills: TreeSkill[] = [];
  let level = [start];
  for (let depth = 0; depth <= SKILL_SEARCH_MAX_DEPTH && level.length > 0; depth += 1) {
    const listed = await Promise.all(
      level.map((dir) =>
        limit(async () => {
          budget.spend();
          return { dir, entries: await client.contents(source, dir, revision) };
        }),
      ),
    );
    const next: string[] = [];
    for (const { dir, entries } of listed) {
      const skillMd = entries.find((entry) => entry.type === "file" && entry.name === "SKILL.md");
      if (skillMd) {
        const files = entries.filter((entry) => entry.type === "file").map(contentsBlob);
        skills.push({ dir, skillMd: contentsBlob(skillMd), files });
        continue;
      }
      for (const entry of entries) {
        if (entry.type === "dir" && !SKILL_SEARCH_SKIP_DIRS.has(entry.name)) next.push(entry.path);
      }
    }
    level = depth < SKILL_SEARCH_MAX_DEPTH ? next : [];
  }
  return skills.sort((a, b) => Number(a.dir > b.dir) - Number(a.dir < b.dir));
}

/** Every file below a directory via the contents API (a skill folder, for install). */
export async function walkContentsFiles(
  client: GithubTreeClient,
  source: GithubSource,
  revision: string,
  dir: string,
): Promise<TreeBlob[]> {
  const budget = new CallBudget(source, CONTENTS_WALK_MAX_CALLS);
  const files: TreeBlob[] = [];
  let level = [dir];
  while (level.length > 0) {
    const next: string[] = [];
    for (const current of level) {
      budget.spend();
      for (const entry of await client.contents(source, current, revision)) {
        if (entry.type === "file") files.push(contentsBlob(entry));
        else if (entry.type === "dir") next.push(entry.path);
      }
    }
    level = next;
  }
  return files;
}

function parentDir(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}

function relativeTo(start: string, dir: string): string | null {
  if (start === "") return dir;
  if (dir === start) return "";
  return dir.startsWith(`${start}/`) ? dir.slice(start.length + 1) : null;
}

/** Same rule as a disk walk: within the depth limit, not below .git / node_modules. */
function isSearchable(start: string, dir: string): boolean {
  const relative = relativeTo(start, dir);
  if (relative === null) return false;
  const segments = relative ? relative.split("/") : [];
  return (
    segments.length <= SKILL_SEARCH_MAX_DEPTH &&
    !segments.some((segment) => SKILL_SEARCH_SKIP_DIRS.has(segment))
  );
}

function hasSkillAncestor(dir: string, start: string, found: ReadonlySet<string>): boolean {
  let current = dir;
  while (current !== start && current !== "") {
    current = parentDir(current);
    if (found.has(current)) return true;
  }
  return false;
}

function filesBelow(blobs: readonly TreeBlob[], dir: string): TreeBlob[] {
  if (dir === "") return [...blobs];
  const prefix = `${dir}/`;
  return blobs.filter((blob) => blob.path.startsWith(prefix));
}

/**
 * Skill directories of a file list below `subpath`, matching `findSkillDirs`
 * on disk: a directory holding SKILL.md is a skill and its own
 * sub-directories are not searched further.
 */
export function selectTreeSkills(blobs: readonly TreeBlob[], subpath: string | null): TreeSkill[] {
  const start = subpath ?? "";
  const candidates = blobs
    .filter((blob) => blob.path === "SKILL.md" || blob.path.endsWith("/SKILL.md"))
    .map((blob) => ({ dir: parentDir(blob.path), blob }))
    .filter(({ dir }) => isSearchable(start, dir))
    .sort((a, b) => Number(a.dir > b.dir) - Number(a.dir < b.dir));
  const found = new Set<string>();
  const skills: TreeSkill[] = [];
  for (const { dir, blob } of candidates) {
    if (hasSkillAncestor(dir, start, found)) continue;
    found.add(dir);
    skills.push({ dir, skillMd: blob, files: filesBelow(blobs, dir) });
  }
  return skills;
}
