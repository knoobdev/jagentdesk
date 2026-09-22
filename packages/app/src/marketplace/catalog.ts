import { useFetchQuery } from "@/data/query";

// Community plugin catalog served by paseo.cafe. The endpoint is public
// (access-control-allow-origin: *) and returns { plugins: MarketplacePlugin[] }
// with an octet-stream content-type, so the body is parsed as JSON by hand.
const MARKETPLACE_CATALOG_URL = "https://paseo.cafe/api/plugins";
const MARKETPLACE_STALE_TIME_MS = 5 * 60 * 1000;

// The 18 categories currently emitted by the catalog. Kept as a const tuple so
// the category filter can render a stable, ordered list without inventing hues.
export const MARKETPLACE_CATEGORIES = [
  "provider",
  "productivity",
  "monitoring",
  "orchestration",
  "git",
  "automation",
  "theme",
  "other",
  "developer-tools",
  "github",
  "azure-devops",
  "pull-requests",
  "grafana",
  "code-review",
  "docker",
  "browser",
  "timeline",
  "omp",
] as const;

export interface MarketplaceHealth {
  manifestValid: boolean;
  hasReadme: boolean;
  hasLicense: boolean;
  hasTests: boolean;
  hasTypecheckScript: boolean;
  updatedRecently: boolean;
}

export interface MarketplaceRepoMeta {
  stars: number;
  defaultBranch: string;
  pushedAt: string;
}

export interface MarketplaceNpm {
  package?: string;
  version?: string;
  downloads?: number;
  downloadsLast30Days?: number;
  publishedAt?: string;
}

// Fields vary between entries, so everything beyond the identity/display core is
// treated as optional and defensively normalized in `normalizePlugin`.
export interface MarketplacePlugin {
  id: string;
  repo: string;
  url: string;
  package?: string;
  name: string;
  description: string;
  categories: string[];
  platforms: string[];
  version: string;
  author: string;
  license: string;
  paseoVersionRequirement?: string;
  images: string[];
  themes: unknown[];
  caveats?: string;
  descriptionNodes?: unknown;
  caveatNodes?: unknown;
  readmeText?: string;
  installNotesHtml?: string;
  limitationsNotesHtml?: string;
  health: MarketplaceHealth;
  repoMeta: MarketplaceRepoMeta;
  addedAt?: string;
  owner?: string;
  npm?: MarketplaceNpm;
}

export type MarketplaceSort = "popular" | "recentlyAdded" | "recentlyReleased" | "alphabetical";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeHealth(value: unknown): MarketplaceHealth {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    manifestValid: asBoolean(source.manifestValid),
    hasReadme: asBoolean(source.hasReadme),
    hasLicense: asBoolean(source.hasLicense),
    hasTests: asBoolean(source.hasTests),
    hasTypecheckScript: asBoolean(source.hasTypecheckScript),
    updatedRecently: asBoolean(source.updatedRecently),
  };
}

function normalizeRepoMeta(value: unknown): MarketplaceRepoMeta {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    stars: asNumber(source.stars),
    defaultBranch: asString(source.defaultBranch, "main"),
    pushedAt: asString(source.pushedAt),
  };
}

function normalizeNpm(value: unknown): MarketplaceNpm | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  return {
    package: asOptionalString(source.package),
    version: asOptionalString(source.version),
    downloads: typeof source.downloads === "number" ? source.downloads : undefined,
    downloadsLast30Days:
      typeof source.downloadsLast30Days === "number" ? source.downloadsLast30Days : undefined,
    publishedAt: asOptionalString(source.publishedAt),
  };
}

function normalizePlugin(value: unknown): MarketplacePlugin | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Record<string, unknown>;
  const id = asString(source.id);
  const url = asString(source.url);
  if (!id || !url) {
    return null;
  }
  return {
    id,
    repo: asString(source.repo),
    url,
    package: asOptionalString(source.package),
    name: asString(source.name, id),
    description: asString(source.description),
    categories: asStringArray(source.categories),
    platforms: asStringArray(source.platforms),
    version: asString(source.version),
    author: asString(source.author),
    license: asString(source.license),
    paseoVersionRequirement: asOptionalString(source.paseoVersionRequirement),
    images: asStringArray(source.images),
    themes: Array.isArray(source.themes) ? source.themes : [],
    caveats: asOptionalString(source.caveats),
    descriptionNodes: source.descriptionNodes,
    caveatNodes: source.caveatNodes,
    readmeText: asOptionalString(source.readmeText),
    installNotesHtml: asOptionalString(source.installNotesHtml),
    limitationsNotesHtml: asOptionalString(source.limitationsNotesHtml),
    health: normalizeHealth(source.health),
    repoMeta: normalizeRepoMeta(source.repoMeta),
    addedAt: asOptionalString(source.addedAt),
    owner: asOptionalString(source.owner),
    npm: normalizeNpm(source.npm),
  };
}

export async function fetchMarketplacePlugins(signal?: AbortSignal): Promise<MarketplacePlugin[]> {
  const response = await fetch(MARKETPLACE_CATALOG_URL, { signal });
  if (!response.ok) {
    throw new Error(`Marketplace request failed (${response.status})`);
  }
  // Content-type is octet-stream, so read the raw text and parse it as JSON.
  const raw = await response.text();
  const parsed = JSON.parse(raw) as unknown;
  const list = (parsed as { plugins?: unknown })?.plugins;
  if (!Array.isArray(list)) {
    throw new Error("Marketplace response missing plugins array");
  }
  return list.flatMap((entry) => {
    const plugin = normalizePlugin(entry);
    return plugin ? [plugin] : [];
  });
}

export const MARKETPLACE_CATALOG_QUERY_KEY = ["marketplace", "catalog"] as const;

export function useMarketplaceCatalog() {
  return useFetchQuery({
    queryKey: MARKETPLACE_CATALOG_QUERY_KEY,
    queryFn: ({ signal }) => fetchMarketplacePlugins(signal),
    dataShape: "list",
    staleTimeMs: MARKETPLACE_STALE_TIME_MS,
  });
}

export function isThemePlugin(plugin: MarketplacePlugin): boolean {
  return plugin.categories.includes("theme") || plugin.themes.length > 0;
}

export function npmDownloads(plugin: MarketplacePlugin): number | undefined {
  const value = plugin.npm?.downloadsLast30Days ?? plugin.npm?.downloads;
  return typeof value === "number" ? value : undefined;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareBySort(a: MarketplacePlugin, b: MarketplacePlugin, sort: MarketplaceSort): number {
  if (sort === "popular") {
    return b.repoMeta.stars - a.repoMeta.stars;
  }
  if (sort === "recentlyAdded") {
    return parseTimestamp(b.addedAt) - parseTimestamp(a.addedAt);
  }
  if (sort === "recentlyReleased") {
    return parseTimestamp(b.repoMeta.pushedAt) - parseTimestamp(a.repoMeta.pushedAt);
  }
  return a.name.localeCompare(b.name);
}

export interface MarketplaceFilterInput {
  plugins: MarketplacePlugin[];
  search: string;
  categories: string[];
  platforms: string[];
  sort: MarketplaceSort;
}

function matchesSearch(plugin: MarketplacePlugin, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = `${plugin.name} ${plugin.description} ${plugin.author}`.toLowerCase();
  return haystack.includes(needle);
}

function matchesCategories(plugin: MarketplacePlugin, categories: string[]): boolean {
  return (
    categories.length === 0 || categories.some((category) => plugin.categories.includes(category))
  );
}

function matchesPlatforms(plugin: MarketplacePlugin, platforms: string[]): boolean {
  return (
    platforms.length === 0 || platforms.some((platform) => plugin.platforms.includes(platform))
  );
}

export function filterAndSortPlugins(input: MarketplaceFilterInput): MarketplacePlugin[] {
  const needle = input.search.trim().toLowerCase();
  const filtered = input.plugins.filter(
    (plugin) =>
      matchesSearch(plugin, needle) &&
      matchesCategories(plugin, input.categories) &&
      matchesPlatforms(plugin, input.platforms),
  );
  return [...filtered].sort((a, b) => compareBySort(a, b, input.sort));
}

export function collectPlatforms(plugins: MarketplacePlugin[]): string[] {
  const platforms = new Set<string>();
  for (const plugin of plugins) {
    for (const platform of plugin.platforms) {
      platforms.add(platform);
    }
  }
  return [...platforms].sort();
}

export interface CategoryCount {
  category: string;
  count: number;
}

export function categoryDistribution(plugins: MarketplacePlugin[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const plugin of plugins) {
    for (const category of plugin.categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function topPluginsByStars(
  plugins: MarketplacePlugin[],
  limit: number,
): MarketplacePlugin[] {
  return [...plugins].sort((a, b) => b.repoMeta.stars - a.repoMeta.stars).slice(0, limit);
}

// Normalize a git remote/URL to `host/owner/repo` so an installed plugin whose
// daemon-side `remote` was rewritten (protocol, trailing .git, casing) still
// matches its marketplace entry's `url`.
export function normalizeRepoUrl(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .trim()
    .toLowerCase()
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}
