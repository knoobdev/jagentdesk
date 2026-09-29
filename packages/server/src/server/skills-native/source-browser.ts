import path from "node:path";
import {
  OFFICIAL_SKILL_REPOS,
  type SkillCatalogItem,
  type SkillCatalogItemRef,
  type SkillEntry,
  type SkillPluginInstallResult,
  type SkillScope,
  type SkillSourceInfo,
  type SkillSourceRef,
} from "@jagentdesk/protocol/native-skills";
import { execCommand } from "../../utils/spawn.js";
import { NativeSkillsError } from "./errors.js";
import { isScriptPath, listSkillFiles } from "./fs-utils.js";
import {
  listClaudeMarketplacePlugins,
  listCodexMarketplacePlugins,
  pluginToCatalogItem,
  runPluginInstall,
  type CommandRunner,
  type MarketplacePlugin,
} from "./provider-marketplace.js";
import {
  findSkillDirs,
  LIST_CACHE_TTL_MS,
  parseRemoteSource,
  RemoteSourceCache,
  remoteSourceLabel,
  type FetchLike,
  type RemoteSource,
} from "./remote-sources.js";
import { readSkillDir } from "./scanner.js";

const PLUGIN_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

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
  /** Name to install under (frontmatter name, or directory name when missing). */
  name: string;
  frontmatterName: string | null;
  source: SkillSourceInfo;
}

interface RemoteTarget {
  remote: RemoteSource;
  source: SkillSourceRef;
}

function officialTargets(repo: string | undefined): RemoteTarget[] {
  const repos = repo ? [repo] : [...OFFICIAL_SKILL_REPOS];
  return repos.map((name) => {
    if (!(OFFICIAL_SKILL_REPOS as readonly string[]).includes(name)) {
      throw new NativeSkillsError("invalid_request", `Not an official skills repository: ${name}`);
    }
    const [owner, repoName] = name.split("/");
    return {
      remote: { kind: "github", owner: owner!, repo: repoName!, ref: null, subpath: null },
      source: { kind: "official", repo: name },
    };
  });
}

function urlTarget(url: string): RemoteTarget {
  const remote = parseRemoteSource(url);
  if (!remote) {
    throw new NativeSkillsError(
      "invalid_request",
      "Use a GitHub owner/repo[/path], a github.com URL, or an npm package",
    );
  }
  return { remote, source: { kind: "url", url } };
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

function sourceInfo(remote: RemoteSource, revision: string | null): SkillSourceInfo {
  return {
    kind: remote.kind === "npm" ? "npm" : "github",
    ref: remoteSourceLabel(remote),
    revision,
  };
}

export class SkillSourceBrowser {
  private readonly cache: RemoteSourceCache;
  private readonly runCommand: CommandRunner;
  private readonly homeDir: string;
  private readonly now: () => number;
  private readonly listCache = new Map<string, { at: number; items: SkillCatalogItem[] }>();

  constructor(options: {
    cacheDir: string;
    homeDir: string;
    fetch?: FetchLike;
    runCommand?: CommandRunner;
    now: () => number;
  }) {
    this.cache = new RemoteSourceCache(
      options.cacheDir,
      options.fetch ?? defaultFetch,
      options.now,
    );
    this.runCommand = options.runCommand ?? defaultCommandRunner;
    this.homeDir = options.homeDir;
    this.now = options.now;
  }

  async browse(
    source: SkillSourceRef,
    installed: readonly SkillEntry[],
    options: { query?: string; refresh?: boolean },
  ): Promise<SkillCatalogItem[]> {
    const items = await this.listItems(source, installed, options.refresh === true);
    return items
      .map((item) => withInstalled(item, installed))
      .filter((item) => matchesQuery(item, options.query));
  }

  private async listItems(
    source: SkillSourceRef,
    installed: readonly SkillEntry[],
    refresh: boolean,
  ): Promise<SkillCatalogItem[]> {
    if (source.kind === "local") return installed.map(localItem);
    const key = JSON.stringify(source);
    const cached = this.listCache.get(key);
    if (!refresh && cached && this.now() - cached.at < LIST_CACHE_TTL_MS) return cached.items;
    const items =
      source.kind === "provider-marketplace"
        ? (await this.marketplacePlugins(source)).map(pluginToCatalogItem)
        : await this.remoteItems(this.remoteTargets(source), refresh);
    this.listCache.set(key, { at: this.now(), items });
    return items;
  }

  private remoteTargets(source: SkillSourceRef): RemoteTarget[] {
    if (source.kind === "official") return officialTargets(source.repo);
    if (source.kind === "url") return [urlTarget(source.url)];
    throw new NativeSkillsError("invalid_request", `Not a downloadable source: ${source.kind}`);
  }

  private async remoteItems(
    targets: RemoteTarget[],
    refresh: boolean,
  ): Promise<SkillCatalogItem[]> {
    const items: SkillCatalogItem[] = [];
    for (const target of targets) {
      const materialized = await this.cache.materialize(target.remote, { refresh });
      const subpath = target.remote.kind === "github" ? target.remote.subpath : null;
      for (const relative of await findSkillDirs(materialized.root, subpath)) {
        const item = await this.skillItem(
          target,
          materialized.root,
          relative,
          materialized.revision,
        );
        if (item) items.push(item);
      }
    }
    return items;
  }

  private async skillItem(
    target: RemoteTarget,
    root: string,
    relative: string,
    revision: string | null,
  ): Promise<SkillCatalogItem | null> {
    const dir = relative ? path.join(root, relative) : root;
    const info = await readSkillDir(dir);
    if (!info) return null;
    const files = await listSkillFiles(dir);
    return {
      itemId: relative || ".",
      kind: "skill",
      name: info.name ?? path.basename(dir),
      description: info.description,
      source: target.source,
      origin: remoteSourceLabel(target.remote),
      revision,
      files: files.map((file) => file.path),
      hasScripts: files.some((file) => file.isScript || isScriptPath(file.path)),
      body: info.body,
      provider: null,
      category: null,
      installCommand: null,
      installed: false,
      installedSkillId: null,
      invalidReason: info.invalidReason,
    };
  }

  /** Locate an item's directory in the cached download (same revision the user browsed). */
  async resolveSkillItem(ref: SkillCatalogItemRef): Promise<ResolvedSkillItem> {
    if (ref.source.kind === "local" || ref.source.kind === "provider-marketplace") {
      throw new NativeSkillsError("invalid_request", `Cannot copy-install from ${ref.source.kind}`);
    }
    for (const target of this.remoteTargets(ref.source)) {
      const materialized = await this.cache.materialize(target.remote, { allowStale: true });
      const dir = path.resolve(materialized.root, ref.itemId === "." ? "" : ref.itemId);
      const rel = path.relative(materialized.root, dir);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const info = await readSkillDir(dir);
      if (!info) continue;
      if (info.invalidReason && info.name === null) {
        throw new NativeSkillsError("invalid_skill", `Cannot install: ${info.invalidReason}`);
      }
      return {
        dir,
        name: info.name ?? path.basename(dir),
        frontmatterName: info.name,
        source: sourceInfo(target.remote, materialized.revision),
      };
    }
    throw new NativeSkillsError(
      "catalog_item_not_found",
      `Skill not found in source: ${ref.itemId}`,
    );
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
