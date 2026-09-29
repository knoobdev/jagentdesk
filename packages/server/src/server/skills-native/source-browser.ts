import path from "node:path";
import pLimit from "p-limit";
import {
  OFFICIAL_SKILL_REPOS,
  type SkillCatalogItem,
  type SkillCatalogItemRef,
  type SkillEntry,
  type SkillPluginInstallResult,
  type SkillScope,
  type SkillSourceInfo,
  type SkillSourceRef,
  type SkillSourceSpec,
  type SkillSourceStatus,
} from "@jagentdesk/protocol/native-skills";
import { execCommand } from "../../utils/spawn.js";
import { NativeSkillsError } from "./errors.js";
import { parseSkillMarkdown, readSkillMetadata } from "./frontmatter.js";
import {
  listClaudeMarketplacePlugins,
  listCodexMarketplacePlugins,
  pluginToCatalogItem,
  runPluginInstall,
  type CommandRunner,
  type MarketplacePlugin,
} from "./provider-marketplace.js";
import { RemoteListingCache, type ListedSkill, type RemoteListing } from "./remote-listing.js";
import { LIST_CACHE_TTL_MS, parseRemoteSource, type FetchLike } from "./remote-sources.js";
import { readSkillDir } from "./scanner.js";
import {
  isBuiltinSource,
  normalizeSpec,
  officialSpecs,
  parseSourceInput,
  SkillSourcesStore,
  specLabel,
  type ConfiguredSource,
} from "./source-config.js";

const PLUGIN_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LISTED_FILES = 2000;
/** Sources listed at once in a merged browse. */
const SOURCE_CONCURRENCY = 4;

/** Token for api.github.com when the daemon user has one (raises the 60/h limit). */
function githubTokenFromEnv(): string | null {
  const token = process.env["GITHUB_TOKEN"]?.trim() || process.env["GH_TOKEN"]?.trim();
  return token || null;
}

export const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, { headers: init?.headers, signal: init?.signal });
  return response;
};

export const defaultCommandRunner: CommandRunner = async (command, args, options) => {
  try {
    const result = await execCommand(command, args, {
      cwd: options.cwd ?? undefined,
      timeout: PLUGIN_INSTALL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
};

export interface ResolvedSkillItem {
  dir: string;
  /** Name to install under (frontmatter name). */
  name: string;
  frontmatterName: string | null;
  source: SkillSourceInfo;
}

/** One source to list, with how its items are labelled and referenced. */
interface BrowseTarget {
  spec: SkillSourceSpec;
  ref: SkillSourceRef;
  origin: string;
  sourceId: string | null;
  sourceLabel: string | null;
}

function officialTargets(repo: string | undefined): BrowseTarget[] {
  if (repo && !(OFFICIAL_SKILL_REPOS as readonly string[]).includes(repo)) {
    throw new NativeSkillsError("invalid_request", `Not an official skills repository: ${repo}`);
  }
  return officialSpecs()
    .filter((spec) => !repo || `${spec.owner}/${spec.repo}` === repo)
    .map((spec) => ({
      spec,
      ref: { kind: "official", repo: `${spec.owner}/${spec.repo}` },
      origin: specLabel(spec),
      sourceId: null,
      sourceLabel: null,
    }));
}

function urlTarget(url: string): BrowseTarget {
  const remote = parseRemoteSource(url);
  if (!remote) {
    throw new NativeSkillsError(
      "invalid_request",
      "Use a GitHub owner/repo[/path], a github.com URL, or an npm package",
    );
  }
  return {
    spec: remote,
    ref: { kind: "url", url },
    origin: specLabel(remote),
    sourceId: null,
    sourceLabel: null,
  };
}

function configuredTarget(source: ConfiguredSource): BrowseTarget {
  const label = source.label ?? specLabel(source.spec);
  return {
    spec: source.spec,
    ref: { kind: "configured", sourceId: source.sourceId },
    origin: specLabel(source.spec),
    sourceId: source.sourceId,
    sourceLabel: label,
  };
}

function matchesQuery(item: SkillCatalogItem, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return [item.name, item.description, item.category ?? "", item.origin]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

function withInstalled(item: SkillCatalogItem, installed: readonly SkillEntry[]): SkillCatalogItem {
  if (item.kind !== "skill" || item.source.kind === "local") return item;
  const match = installed.find((entry) => entry.scope === "global" && entry.name === item.name);
  return { ...item, installed: Boolean(match), installedSkillId: match?.skillId ?? null };
}

export interface SourceBrowserOptions {
  cacheDir: string;
  skillsHome: string;
  homeDir: string;
  fetch?: FetchLike;
  runCommand?: CommandRunner;
  now: () => number;
  githubToken?: string | null;
  onBackgroundError?: (error: unknown, spec: SkillSourceSpec) => void;
}

export class SkillSourceBrowser {
  private readonly listings: RemoteListingCache;
  private readonly sources: SkillSourcesStore;
  private readonly runCommand: CommandRunner;
  private readonly homeDir: string;
  private readonly now: () => number;
  /** Provider marketplace lists (local manifest reads). */
  private readonly listCache = new Map<string, { at: number; items: SkillCatalogItem[] }>();

  constructor(options: SourceBrowserOptions) {
    this.listings = new RemoteListingCache({
      cacheDir: options.cacheDir,
      fetch: options.fetch ?? defaultFetch,
      now: options.now,
      // Only the real network gets the environment token; injected fetches never do.
      githubToken: options.githubToken ?? (options.fetch ? null : githubTokenFromEnv()),
      onBackgroundError: options.onBackgroundError,
    });
    this.sources = new SkillSourcesStore(options.skillsHome, options.now);
    this.runCommand = options.runCommand ?? defaultCommandRunner;
    this.homeDir = options.homeDir;
    this.now = options.now;
  }

  /** Settles when background listing refreshes are done (tests). */
  idle(): Promise<void> {
    return this.listings.idle();
  }

  /**
   * Catalog items of `source`; without `source`, of the configured sources
   * (`sourceId` alone, or every enabled one merged and de-duplicated).
   */
  async browse(
    source: SkillSourceRef | undefined,
    installed: readonly SkillEntry[],
    options: { sourceId?: string; query?: string; refresh?: boolean },
  ): Promise<SkillCatalogItem[]> {
    const items = await this.listItems(source, installed, options);
    return items
      .map((item) => withInstalled(item, installed))
      .filter((item) => matchesQuery(item, options.query));
  }

  private async listItems(
    source: SkillSourceRef | undefined,
    installed: readonly SkillEntry[],
    options: { sourceId?: string; refresh?: boolean },
  ): Promise<SkillCatalogItem[]> {
    const refresh = options.refresh === true;
    if (!source) {
      if (options.sourceId) {
        return this.targetItems(
          [configuredTarget(await this.sources.find(options.sourceId))],
          refresh,
          false,
        );
      }
      const enabled = (await this.sources.list()).filter((candidate) => candidate.enabled);
      return this.targetItems(enabled.map(configuredTarget), refresh, true);
    }
    if (source.kind === "local") return installed.map(localItem);
    if (source.kind === "provider-marketplace") return this.marketplaceItems(source, refresh);
    return this.targetItems(await this.targetsFor(source), refresh, false);
  }

  private async marketplaceItems(
    source: Extract<SkillSourceRef, { kind: "provider-marketplace" }>,
    refresh: boolean,
  ): Promise<SkillCatalogItem[]> {
    const key = JSON.stringify(source);
    const cached = this.listCache.get(key);
    if (!refresh && cached && this.now() - cached.at < LIST_CACHE_TTL_MS) return cached.items;
    const items = (await this.marketplacePlugins(source)).map(pluginToCatalogItem);
    this.listCache.set(key, { at: this.now(), items });
    return items;
  }

  private async targetsFor(source: SkillSourceRef): Promise<BrowseTarget[]> {
    switch (source.kind) {
      case "official":
        return officialTargets(source.repo);
      case "url":
        return [urlTarget(source.url)];
      case "configured":
        return [configuredTarget(await this.sources.find(source.sourceId))];
      default:
        throw new NativeSkillsError("invalid_request", `Not a downloadable source: ${source.kind}`);
    }
  }

  /**
   * Items of every target, listed in parallel (bounded), de-duplicated by
   * source + skill path. A merged browse skips failing sources (their status
   * carries the error) unless every source failed.
   */
  private async targetItems(
    targets: BrowseTarget[],
    refresh: boolean,
    tolerateFailures: boolean,
  ): Promise<SkillCatalogItem[]> {
    const limit = pLimit(SOURCE_CONCURRENCY);
    const results = await Promise.allSettled(
      targets.map((target) =>
        limit(async () => ({
          target,
          listing: await this.listings.list(target.spec, { refresh }),
        })),
      ),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0 && (!tolerateFailures || failures.length === results.length)) {
      throw (failures[0] as PromiseRejectedResult).reason;
    }
    const seen = new Set<string>();
    const items: SkillCatalogItem[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { target, listing } = result.value;
      for (const skill of listing.skills) {
        if (seen.has(skill.identity)) continue;
        seen.add(skill.identity);
        items.push(skillItem(target, skill, listing));
      }
    }
    return items;
  }

  /**
   * Local directory of a listed skill at the revision the user browsed. Only
   * that skill's files are downloaded (npm: the listed version's tarball).
   */
  async resolveSkillItem(ref: SkillCatalogItemRef): Promise<ResolvedSkillItem> {
    if (ref.source.kind === "local" || ref.source.kind === "provider-marketplace") {
      throw new NativeSkillsError("invalid_request", `Cannot copy-install from ${ref.source.kind}`);
    }
    for (const target of await this.targetsFor(ref.source)) {
      const found = await this.listings.skillDir(target.spec, ref.itemId);
      if (!found) continue;
      const info = await readSkillDir(found.dir);
      if (!info) continue;
      if (info.invalidReason && info.name === null) {
        throw new NativeSkillsError("invalid_skill", `Cannot install: ${info.invalidReason}`);
      }
      return {
        dir: found.dir,
        name: info.name ?? path.basename(found.dir),
        frontmatterName: info.name,
        source: found.source,
      };
    }
    throw new NativeSkillsError(
      "catalog_item_not_found",
      `Skill not found in source: ${ref.itemId}`,
    );
  }

  // ── configured sources ─────────────────────────────────────────────────────
  async listSources(): Promise<SkillSourceStatus[]> {
    const sources = await this.sources.list();
    return Promise.all(sources.map((source) => this.statusOf(source)));
  }

  /** Parse and validate a new source by listing it once (at least one skill). */
  async validateSource(input: string | SkillSourceSpec): Promise<SkillSourceSpec> {
    const spec =
      typeof input === "string"
        ? parseSourceInput(input, this.homeDir)
        : normalizeSpec(input, this.homeDir);
    const listing = await this.listings.list(spec, { refresh: true });
    if (listing.skills.length === 0) {
      throw new NativeSkillsError("invalid_request", `No SKILL.md found in ${specLabel(spec)}`);
    }
    return spec;
  }

  async storeSource(spec: SkillSourceSpec, label?: string): Promise<SkillSourceStatus> {
    return this.statusOf(await this.sources.upsert(spec, label?.trim() || null));
  }

  async removeSource(sourceId: string): Promise<void> {
    await this.sources.remove(sourceId);
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<SkillSourceStatus> {
    return this.statusOf(await this.sources.setEnabled(sourceId, enabled));
  }

  private async statusOf(source: ConfiguredSource): Promise<SkillSourceStatus> {
    const status = await this.listings.status(source.spec);
    return {
      sourceId: source.sourceId,
      spec: source.spec,
      label: source.label ?? specLabel(source.spec),
      customLabel: source.label,
      builtin: isBuiltinSource(source.spec),
      enabled: source.enabled,
      addedAtMs: source.added_at_ms,
      ...status,
    };
  }

  private async marketplacePlugins(
    source: Extract<SkillSourceRef, { kind: "provider-marketplace" }>,
  ): Promise<MarketplacePlugin[]> {
    const lists = await Promise.all([
      source.provider === "codex" ? [] : listClaudeMarketplacePlugins(this.homeDir),
      source.provider === "claude" ? [] : listCodexMarketplacePlugins(this.homeDir),
    ]);
    return lists
      .flat()
      .filter((plugin) => !source.marketplace || plugin.marketplace === source.marketplace);
  }

  async installPlugin(
    ref: SkillCatalogItemRef,
    scope: SkillScope,
    projectRoot: string | null,
  ): Promise<SkillPluginInstallResult> {
    if (ref.source.kind !== "provider-marketplace") {
      throw new NativeSkillsError("invalid_request", "Not a provider marketplace item");
    }
    const plugin = (await this.marketplacePlugins(ref.source)).find(
      (candidate) => `${candidate.name}@${candidate.marketplace}` === ref.itemId,
    );
    if (!plugin) {
      throw new NativeSkillsError("catalog_item_not_found", `Plugin not found: ${ref.itemId}`);
    }
    if (scope === "project" && plugin.provider === "codex") {
      throw new NativeSkillsError(
        "invalid_request",
        "Codex plugins can only be installed globally",
      );
    }
    const result = await runPluginInstall(
      this.runCommand,
      plugin.provider,
      ref.itemId,
      scope,
      scope === "project" ? projectRoot : null,
    );
    this.listCache.clear();
    return result;
  }
}

function fallbackName(target: BrowseTarget, skill: ListedSkill): string {
  if (skill.dir) return path.posix.basename(skill.dir);
  switch (target.spec.kind) {
    case "github":
      return target.spec.repo;
    case "npm":
      return target.spec.pkg.split("/").pop() ?? target.spec.pkg;
    default:
      return path.basename(target.origin);
  }
}

function skillItem(
  target: BrowseTarget,
  skill: ListedSkill,
  listing: RemoteListing,
): SkillCatalogItem {
  const parsed = skill.content === null ? null : parseSkillMarkdown(skill.content);
  const meta = parsed
    ? readSkillMetadata(parsed.frontmatter)
    : readSkillMetadata({ name: skill.name ?? "", description: skill.description ?? "" });
  return {
    itemId: skill.itemId,
    kind: "skill",
    name: meta.name ?? fallbackName(target, skill),
    description: meta.description,
    source: target.ref,
    origin: target.origin,
    revision: listing.revision,
    files: skill.files.slice(0, MAX_LISTED_FILES).map((file) => file.path),
    hasScripts: skill.files.some((file) => file.isScript),
    body: parsed?.body ?? null,
    provider: null,
    category: null,
    installCommand: null,
    installed: false,
    installedSkillId: null,
    invalidReason: meta.invalidReason,
    sourceId: target.sourceId,
    sourceLabel: target.sourceLabel,
  };
}

function localItem(entry: SkillEntry): SkillCatalogItem {
  return {
    itemId: entry.skillId,
    kind: "skill",
    name: entry.name,
    description: entry.description,
    source: { kind: "local" },
    origin: entry.realPath,
    revision: entry.source.revision,
    files: [],
    hasScripts: entry.hasScripts,
    body: null,
    provider: null,
    category: null,
    installCommand: null,
    installed: true,
    installedSkillId: entry.skillId,
    invalidReason: entry.invalidReason,
  };
}
