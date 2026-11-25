import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SkillDirectoryStatus } from "@jagentdesk/protocol/native-skills";
import { NativeSkillsError } from "./errors.js";
import { indexEntryTarget } from "./remote-listing.js";
import { LIST_CACHE_TTL_MS, type FetchLike } from "./remote-sources.js";
import type { DirectoryProvider } from "./directory-hosts.js";

/**
 * Searchable skill directories (ADR-0023, spec 22.5). A directory is an `index`
 * source whose host has an adapter here. It has no full listing: each page the
 * user views is one search request, and results point at a GitHub skill folder
 * that is installed through the existing GitHub path.
 */

export const DIRECTORY_PAGE_SIZE = 20;
const SEARCH_TIMEOUT_MS = 20_000;

export type { DirectoryProvider } from "./directory-hosts.js";
export { directoryProviderFor } from "./directory-hosts.js";
type DirectoryQuota = NonNullable<SkillDirectoryStatus["quota"]>;

export interface DirectorySearchResult {
  name: string;
  description: string;
  author: string | null;
  stars: number | null;
  /** GitHub folder of the skill: `https://github.com/<owner>/<repo>/tree/<ref>/<path>`. */
  githubUrl: string;
  /** Skill directory inside the repository (the catalog `itemId`). */
  dir: string;
}

export interface DirectorySearchPage {
  results: DirectorySearchResult[];
  hasMore: boolean;
}

// ── SkillsMP (https://skillsmp.com/docs/api) ────────────────────────────────
const SKILLSMP_SEARCH_URL = "https://skillsmp.com/api/v1/skills/search";

const SkillsMpSearchResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    skills: z.array(
      z
        .object({
          name: z.string(),
          description: z.string().nullable().optional(),
          author: z.string().nullable().optional(),
          githubUrl: z.string(),
          stars: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
    pagination: z
      .object({ hasNext: z.boolean().optional(), totalPages: z.number().optional() })
      .passthrough()
      .optional(),
  }),
});

const SkillsMpErrorSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough(),
});

function headerNumber(headers: { get(name: string): string | null }, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Daily quota from X-RateLimit-Daily-Limit / -Remaining (observed 2026-09-30). The site sends
 * no reset header today; one is read if it appears (epoch seconds or ms).
 */
function readQuota(headers: { get(name: string): string | null }): DirectoryQuota | null {
  const limit = headerNumber(headers, "x-ratelimit-daily-limit");
  const remaining = headerNumber(headers, "x-ratelimit-daily-remaining");
  const reset = headerNumber(headers, "x-ratelimit-daily-reset");
  if (limit === null && remaining === null) return null;
  let resetAtMs: number | null = null;
  if (reset !== null) resetAtMs = reset < 1e12 ? reset * 1000 : reset;
  return { limit, remaining, resetAtMs };
}

function rateLimitMessage(
  code: string | undefined,
  retryAfterSeconds: number | null,
  hasApiKey: boolean,
): string {
  const keyHint = hasApiKey ? "" : " Add a SkillsMP API key to raise the limit.";
  if (code === "DAILY_QUOTA_EXCEEDED") {
    return `SkillsMP daily search limit reached.${keyHint}`;
  }
  const wait = retryAfterSeconds === null ? "shortly" : `in ${retryAfterSeconds} s`;
  return `SkillsMP rate limit reached; try again ${wait}.${keyHint}`;
}

async function searchSkillsMp(input: {
  fetch: FetchLike;
  query: string;
  page: number;
  apiKey: string | null;
}): Promise<{ page: DirectorySearchPage; quota: DirectoryQuota | null }> {
  const url = new URL(SKILLSMP_SEARCH_URL);
  url.searchParams.set("q", input.query);
  url.searchParams.set("page", String(input.page));
  url.searchParams.set("limit", String(DIRECTORY_PAGE_SIZE));
  url.searchParams.set("sortBy", "stars");
  const headers: Record<string, string> = {
    "User-Agent": "jagentdesk-daemon",
    Accept: "application/json",
  };
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  const response = await input.fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const quota = readQuota(response.headers);
  if (response.status === 429) {
    const body = SkillsMpErrorSchema.safeParse(await response.json().catch(() => null));
    throw new NativeSkillsError(
      "source_fetch_failed",
      rateLimitMessage(
        body.success ? body.data.error.code : undefined,
        headerNumber(response.headers, "retry-after"),
        input.apiKey !== null,
      ),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new NativeSkillsError(
      "source_fetch_failed",
      "SkillsMP rejected the API key; update or remove it in Sources.",
    );
  }
  if (!response.ok) {
    throw new NativeSkillsError(
      "source_fetch_failed",
      `SkillsMP search failed (${response.status})`,
    );
  }
  const parsed = SkillsMpSearchResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new NativeSkillsError("source_fetch_failed", "SkillsMP returned an unexpected response");
  }
  const results: DirectorySearchResult[] = [];
  for (const skill of parsed.data.data.skills) {
    const target = indexEntryTarget(skill.githubUrl, undefined);
    if (!target || target.spec.kind !== "github") continue;
    results.push({
      name: skill.name,
      description: skill.description ?? "",
      author: skill.author ?? null,
      stars: skill.stars ?? null,
      githubUrl: skill.githubUrl,
      dir: target.dir,
    });
  }
  const pagination = parsed.data.data.pagination;
  const hasMore =
    pagination?.hasNext ??
    (pagination?.totalPages !== undefined ? input.page < pagination.totalPages : false);
  return { page: { results, hasMore }, quota };
}

// ── API keys: $JAGENTDESK_HOME/skills/credentials.json (0600) ───────────────
const CredentialsFileSchema = z.object({
  version: z.literal(1),
  apiKeys: z.record(z.string(), z.string()),
});

/**
 * Directory API keys by source id. Kept apart from sources.json, owner-only
 * permissions, and never returned to apps (they only see `hasApiKey`).
 */
export class DirectoryCredentialsStore {
  private readonly filePath: string;
  private keys: Record<string, string> | null = null;

  constructor(skillsHome: string) {
    this.filePath = path.join(skillsHome, "credentials.json");
  }

  async get(sourceId: string): Promise<string | null> {
    return (await this.load())[sourceId] ?? null;
  }

  async set(sourceId: string, apiKey: string | null): Promise<void> {
    const keys = { ...(await this.load()) };
    if (apiKey === null) delete keys[sourceId];
    else keys[sourceId] = apiKey.trim();
    await this.write(keys);
    this.keys = keys;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.keys) return this.keys;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      this.keys = CredentialsFileSchema.parse(raw).apiKeys;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.keys = {};
    }
    return this.keys;
  }

  private async write(keys: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, apiKeys: keys }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temp, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }
}

// ── Search with a 10-minute cache (matches the site's s-maxage=600) ─────────
export interface DirectorySearchOptions {
  fetch: FetchLike;
  now: () => number;
  credentials: DirectoryCredentialsStore;
}

export class DirectorySearch {
  private readonly cache = new Map<string, { at: number; page: DirectorySearchPage }>();
  private readonly quotas = new Map<string, DirectoryQuota>();

  constructor(private readonly options: DirectorySearchOptions) {}

  async search(input: {
    sourceId: string;
    provider: DirectoryProvider;
    query: string;
    page: number;
    refresh?: boolean;
  }): Promise<DirectorySearchPage> {
    const query = input.query.trim();
    if (!query) return { results: [], hasMore: false };
    const apiKey = await this.options.credentials.get(input.sourceId);
    const key = JSON.stringify([input.sourceId, query.toLowerCase(), input.page, apiKey !== null]);
    const cached = this.cache.get(key);
    if (!input.refresh && cached && this.options.now() - cached.at < LIST_CACHE_TTL_MS) {
      return cached.page;
    }
    const { page, quota } = await searchSkillsMp({
      fetch: this.options.fetch,
      query,
      page: input.page,
      apiKey,
    });
    if (quota) this.quotas.set(input.sourceId, quota);
    this.cache.set(key, { at: this.options.now(), page });
    return page;
  }

  async status(sourceId: string, provider: DirectoryProvider): Promise<SkillDirectoryStatus> {
    return {
      provider,
      hasApiKey: (await this.options.credentials.get(sourceId)) !== null,
      quota: this.quotas.get(sourceId) ?? null,
    };
  }

  /** A new key changes the limits: forget cached pages and the old quota. */
  forget(sourceId: string): void {
    this.quotas.delete(sourceId);
    for (const key of this.cache.keys()) {
      if (key.startsWith(`[${JSON.stringify(sourceId)},`)) this.cache.delete(key);
    }
  }
}
