import type { ArgoCdAppRef, ArgoCdAppSummary } from "@jagentdesk/protocol/argocd/rpc-schemas";

// Applications list model (spec 30.3): merging `argocd.apps.changed` pushes into the snapshot
// and the filter bar. Facets combine like the Argo CD web UI: values inside one facet are
// OR-ed, facets are AND-ed, an empty facet matches everything.

export interface ArgoCdAppsChange {
  upserts: ArgoCdAppSummary[];
  deletes: ArgoCdAppRef[];
  reset: boolean;
}

export type ArgoCdAutoSyncFilter = "any" | "on" | "off";

export interface ArgoCdAppFilters {
  query: string;
  sync: string[];
  health: string[];
  projects: string[];
  labels: string[]; // `key=value`
  clusters: string[];
  namespaces: string[];
  repos: string[];
  operations: string[]; // operation phase, or NO_OPERATION
  autoSync: ArgoCdAutoSyncFilter;
}

export type ArgoCdFacet = Exclude<keyof ArgoCdAppFilters, "query" | "autoSync">;

export const NO_OPERATION = "None";

export const EMPTY_APP_FILTERS: ArgoCdAppFilters = {
  query: "",
  sync: [],
  health: [],
  projects: [],
  labels: [],
  clusters: [],
  namespaces: [],
  repos: [],
  operations: [],
  autoSync: "any",
};

export function appKey(app: ArgoCdAppRef): string {
  return `${app.appNamespace ?? ""}/${app.name}`;
}

function compareApps(a: ArgoCdAppSummary, b: ArgoCdAppSummary): number {
  return a.name.localeCompare(b.name) || (a.appNamespace ?? "").localeCompare(b.appNamespace ?? "");
}

export function sortApps(apps: ArgoCdAppSummary[]): ArgoCdAppSummary[] {
  return [...apps].sort(compareApps);
}

export function applyAppsChange(
  current: ArgoCdAppSummary[],
  change: ArgoCdAppsChange,
): ArgoCdAppSummary[] {
  const byKey = new Map<string, ArgoCdAppSummary>();
  if (!change.reset) {
    for (const app of current) byKey.set(appKey(app), app);
  }
  for (const ref of change.deletes) byKey.delete(appKey(ref));
  for (const app of change.upserts) byKey.set(appKey(app), app);
  return sortApps([...byKey.values()]);
}

const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";

/** Destination cluster as Argo CD shows it: the cluster name, `in-cluster`, else the server URL. */
export function appCluster(app: ArgoCdAppSummary): string {
  if (app.destName) return app.destName;
  if (app.destServer === IN_CLUSTER_SERVER) return "in-cluster";
  return app.destServer ?? "";
}

export function appLabels(app: ArgoCdAppSummary): string[] {
  return Object.entries(app.labels).map(([key, value]) => `${key}=${value}`);
}

export function appRepos(app: ArgoCdAppSummary): string[] {
  return app.sources.map((source) => source.repoURL);
}

export function appOperation(app: ArgoCdAppSummary): string {
  return app.operationPhase ?? NO_OPERATION;
}

const GIT_SHA = /^[0-9a-f]{40}$/;

/** Git revisions shortened to 7 characters; chart versions and tags stay whole. */
export function shortRevision(revision: string | null): string | null {
  if (!revision) return null;
  return GIT_SHA.test(revision) ? revision.slice(0, 7) : revision;
}

function facetValues(app: ArgoCdAppSummary, facet: ArgoCdFacet): string[] {
  switch (facet) {
    case "sync":
      return [app.sync];
    case "health":
      return [app.health];
    case "projects":
      return [app.project];
    case "labels":
      return appLabels(app);
    case "clusters":
      return [appCluster(app)];
    case "namespaces":
      return [app.destNamespace ?? ""];
    case "repos":
      return appRepos(app);
    case "operations":
      return [appOperation(app)];
  }
}

export const APP_FACETS: readonly ArgoCdFacet[] = [
  "sync",
  "health",
  "projects",
  "labels",
  "clusters",
  "namespaces",
  "repos",
  "operations",
];

function matchesFacet(app: ArgoCdAppSummary, facet: ArgoCdFacet, selected: string[]): boolean {
  if (selected.length === 0) return true;
  return facetValues(app, facet).some((value) => selected.includes(value));
}

function matchesAutoSync(app: ArgoCdAppSummary, filter: ArgoCdAutoSyncFilter): boolean {
  if (filter === "any") return true;
  return app.autoSync === (filter === "on");
}

export function filterApps(
  apps: ArgoCdAppSummary[],
  filters: ArgoCdAppFilters,
): ArgoCdAppSummary[] {
  const query = filters.query.trim().toLowerCase();
  return apps.filter((app) => {
    if (query && !app.name.toLowerCase().includes(query)) return false;
    if (!matchesAutoSync(app, filters.autoSync)) return false;
    return APP_FACETS.every((facet) => matchesFacet(app, facet, filters[facet]));
  });
}

export type ArgoCdFacetOptions = Record<ArgoCdFacet, string[]>;

function facetOptions(apps: ArgoCdAppSummary[], facet: ArgoCdFacet): string[] {
  const values = new Set<string>();
  for (const app of apps) {
    for (const value of facetValues(app, facet)) {
      if (value) values.add(value);
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** The values present in the current apps, per facet, sorted — the filter menus' options. */
export function collectFacetOptions(apps: ArgoCdAppSummary[]): ArgoCdFacetOptions {
  return {
    sync: facetOptions(apps, "sync"),
    health: facetOptions(apps, "health"),
    projects: facetOptions(apps, "projects"),
    labels: facetOptions(apps, "labels"),
    clusters: facetOptions(apps, "clusters"),
    namespaces: facetOptions(apps, "namespaces"),
    repos: facetOptions(apps, "repos"),
    operations: facetOptions(apps, "operations"),
  };
}

export function toggleFacetValue(
  filters: ArgoCdAppFilters,
  facet: ArgoCdFacet,
  value: string,
): ArgoCdAppFilters {
  const current = filters[facet];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return { ...filters, [facet]: next };
}

export function countActiveFilters(filters: ArgoCdAppFilters): number {
  const facetCount = APP_FACETS.reduce((sum, facet) => sum + filters[facet].length, 0);
  return facetCount + (filters.autoSync === "any" ? 0 : 1);
}
