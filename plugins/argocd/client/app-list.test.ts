import { describe, expect, it } from "vitest";
import type { ArgoCdAppSummary } from "@jagentdesk/protocol/argocd/rpc-schemas";
import {
  applyAppsChange,
  collectFacetOptions,
  countActiveFilters,
  EMPTY_APP_FILTERS,
  filterApps,
  shortRevision,
  toggleFacetValue,
} from "./app-list";

function app(overrides: Partial<ArgoCdAppSummary> & { name: string }): ArgoCdAppSummary {
  return {
    appNamespace: null,
    project: "default",
    health: "Healthy",
    sync: "Synced",
    syncRevision: null,
    sources: [
      {
        repoURL: "https://git.example.invalid/a.git",
        path: "a",
        chart: null,
        targetRevision: "HEAD",
      },
    ],
    destServer: "https://kubernetes.default.svc",
    destName: null,
    destNamespace: "default",
    labels: {},
    autoSync: false,
    operationPhase: null,
    operationStartedAt_ms: null,
    lastSyncAt_ms: null,
    createdAt_ms: null,
    deleting: false,
    ...overrides,
  };
}

const guestbook = app({ name: "guestbook", sync: "OutOfSync", health: "Missing" });
const auto = app({
  name: "guestbook-auto",
  autoSync: true,
  labels: { team: "web" },
  destName: "prod",
});
const broken = app({
  name: "guestbook-broken",
  health: "Degraded",
  project: "apps",
  destNamespace: "broken",
  operationPhase: "Running",
  sources: [
    {
      repoURL: "https://git.example.invalid/b.git",
      path: "b",
      chart: null,
      targetRevision: "main",
    },
  ],
});
const all = [guestbook, auto, broken];

function names(apps: ArgoCdAppSummary[]): string[] {
  return apps.map((entry) => entry.name);
}

describe("applyAppsChange", () => {
  it("upserts, deletes and keeps the list sorted by name", () => {
    const next = applyAppsChange([broken, guestbook], {
      upserts: [auto, { ...guestbook, sync: "Synced" }],
      deletes: [{ name: "guestbook-broken", appNamespace: null }],
      reset: false,
    });
    expect(next).toEqual([{ ...guestbook, sync: "Synced" }, auto]);
  });

  it("replaces everything on reset", () => {
    const next = applyAppsChange(all, { upserts: [broken], deletes: [], reset: true });
    expect(next).toEqual([broken]);
  });

  it("keys apps by namespace and name", () => {
    const other = app({ name: "guestbook", appNamespace: "team-a" });
    const next = applyAppsChange([guestbook], { upserts: [other], deletes: [], reset: false });
    expect(next).toEqual([guestbook, other]);
  });
});

describe("filterApps", () => {
  it("matches the name query case-insensitively", () => {
    expect(names(filterApps(all, { ...EMPTY_APP_FILTERS, query: "AUTO" }))).toEqual([
      "guestbook-auto",
    ]);
  });

  it("ORs values inside a facet and ANDs facets", () => {
    const filters = { ...EMPTY_APP_FILTERS, health: ["Missing", "Degraded"], projects: ["apps"] };
    expect(names(filterApps(all, filters))).toEqual(["guestbook-broken"]);
  });

  it("filters by label, cluster, repo, operation and auto-sync", () => {
    expect(names(filterApps(all, { ...EMPTY_APP_FILTERS, labels: ["team=web"] }))).toEqual([
      "guestbook-auto",
    ]);
    expect(names(filterApps(all, { ...EMPTY_APP_FILTERS, clusters: ["prod"] }))).toEqual([
      "guestbook-auto",
    ]);
    expect(
      names(
        filterApps(all, { ...EMPTY_APP_FILTERS, repos: ["https://git.example.invalid/b.git"] }),
      ),
    ).toEqual(["guestbook-broken"]);
    expect(names(filterApps(all, { ...EMPTY_APP_FILTERS, operations: ["None"] }))).toEqual([
      "guestbook",
      "guestbook-auto",
    ]);
    expect(names(filterApps(all, { ...EMPTY_APP_FILTERS, autoSync: "off" }))).toEqual([
      "guestbook",
      "guestbook-broken",
    ]);
  });
});

describe("facets", () => {
  it("collects the present values per facet", () => {
    expect(collectFacetOptions(all)).toEqual({
      sync: ["OutOfSync", "Synced"],
      health: ["Degraded", "Healthy", "Missing"],
      projects: ["apps", "default"],
      labels: ["team=web"],
      clusters: ["in-cluster", "prod"],
      namespaces: ["broken", "default"],
      repos: ["https://git.example.invalid/a.git", "https://git.example.invalid/b.git"],
      operations: ["None", "Running"],
    });
  });

  it("toggles a value and counts active filters", () => {
    const on = toggleFacetValue({ ...EMPTY_APP_FILTERS, autoSync: "on" }, "sync", "Synced");
    expect(on.sync).toEqual(["Synced"]);
    expect(countActiveFilters(on)).toBe(2);
    expect(toggleFacetValue(on, "sync", "Synced").sync).toEqual([]);
  });
});

describe("shortRevision", () => {
  it("shortens git SHAs and keeps other revisions", () => {
    expect(shortRevision("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
    expect(shortRevision("1.2.3")).toBe("1.2.3");
    expect(shortRevision(null)).toBeNull();
  });
});
