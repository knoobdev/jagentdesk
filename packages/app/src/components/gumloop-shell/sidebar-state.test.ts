import type { StorageValue } from "zustand/middleware";
import { describe, expect, it } from "vitest";
import {
  GUMLOOP_SIDEBAR_STATE_VERSION,
  GUMLOOP_SIDEBAR_WIDTH,
  migrateGumloopSidebarState,
  resolveSidebarDrillIn,
  useGumloopSidebarState,
} from "./sidebar-state";
import { composeWorkspaceStructure } from "@/stores/session-store-hooks/selectors";
import { builtinPluginEnabled } from "@/plugins/builtin/registry";

function memoryStorage(initial: StorageValue<unknown> | null) {
  let saved = initial;
  return {
    read: () => saved,
    storage: {
      getItem: () => saved,
      setItem: (_key: string, value: StorageValue<unknown>) => {
        saved = value;
      },
      removeItem: () => {},
    },
  };
}

describe("Gumloop sidebar model", () => {
  it("has one fixed-width sidebar and opens Tools and Projects on a fresh client", async () => {
    expect(GUMLOOP_SIDEBAR_WIDTH).toBe(324);
    useGumloopSidebarState.persist.setOptions({ storage: memoryStorage(null).storage });
    await useGumloopSidebarState.persist.rehydrate();
    expect(useGumloopSidebarState.getState()).toMatchObject({
      toolsCollapsed: false,
      projectsCollapsed: false,
    });
  });
  it.each([
    ["a v0.10.0 auto-fold", 0, { toolsCollapsed: true, projectsCollapsed: false }, false],
    ["a v0.10.0 unset fold", 0, { toolsCollapsed: null, projectsCollapsed: false }, false],
    ["a fold saved by this version", 1, { toolsCollapsed: true, projectsCollapsed: false }, true],
  ])("migrates %s", (_name, version, state, toolsCollapsed) => {
    expect(migrateGumloopSidebarState(state, version)).toEqual({
      toolsCollapsed,
      projectsCollapsed: false,
    });
  });
  it("keeps a v0.10.0 Projects fold and tolerates a missing state", () => {
    expect(
      migrateGumloopSidebarState({ toolsCollapsed: true, projectsCollapsed: true }, 0),
    ).toEqual({ toolsCollapsed: false, projectsCollapsed: true });
    expect(migrateGumloopSidebarState(undefined, 0)).toEqual({
      toolsCollapsed: false,
      projectsCollapsed: false,
    });
  });
  it("reopens a stored v0.10.0 Tools fold once, then remembers the client's folds", async () => {
    const memory = memoryStorage({
      state: { toolsCollapsed: true, projectsCollapsed: false },
      version: 0,
    });
    useGumloopSidebarState.persist.setOptions({ storage: memory.storage });
    await useGumloopSidebarState.persist.rehydrate();
    expect(useGumloopSidebarState.getState().toolsCollapsed).toBe(false);
    expect(memory.read()?.version).toBe(GUMLOOP_SIDEBAR_STATE_VERSION);
    useGumloopSidebarState.getState().setToolsCollapsed(true);
    useGumloopSidebarState.getState().toggleProjects();
    expect(memory.read()).toEqual({
      state: { toolsCollapsed: true, projectsCollapsed: true },
      version: GUMLOOP_SIDEBAR_STATE_VERSION,
    });
    await useGumloopSidebarState.persist.rehydrate();
    expect(useGumloopSidebarState.getState()).toMatchObject({
      toolsCollapsed: true,
      projectsCollapsed: true,
    });
  });
  it("gates a destination from the pushed feature snapshot", () => {
    expect(
      builtinPluginEnabled(
        {
          serverId: "h",
          hostname: "Host",
          version: "0.9.59",
          features: { builtinPlugins: true, docker: true },
        },
        "docker",
      ),
    ).toBe(true);
    expect(
      builtinPluginEnabled(
        {
          serverId: "h",
          hostname: "Host",
          version: "0.9.59",
          features: { builtinPlugins: true, docker: false },
        },
        "docker",
      ),
    ).toBe(false);
  });
  it("keeps the root sidebar on bot pages, where the Bots section is the left panel", () => {
    expect(resolveSidebarDrillIn("/h/one/bots?botId=b")).toBeNull();
  });
  it.each([
    "docker",
    "database/db",
    "cluster/c",
    "servers",
    "jira",
    "argocd",
    "plugin/p/surface/s",
  ])("drills into /%s and keeps its owning host", (path) => {
    expect(
      resolveSidebarDrillIn(`/h/host%20one/${path}`, [
        { routeSegment: "docker", title: "Docker" },
        { routeSegment: "cluster", title: "Clusters" },
        { routeSegment: "database", title: "Data" },
        { routeSegment: "argocd", title: "Argo CD" },
        { routeSegment: "servers", title: "Servers" },
        { routeSegment: "jira", title: "Jira" },
      ]),
    ).toMatchObject({
      kind: "destination",
      serverId: "host one",
    });
  });
  it("drills into workspaces and Settings while root pages keep global navigation", () => {
    expect(resolveSidebarDrillIn("/h/host/workspace/work%20tree")).toEqual({
      kind: "workspace",
      serverId: "host",
      workspaceId: "work tree",
    });
    expect(resolveSidebarDrillIn("/settings/appearance")).toEqual({
      kind: "settings",
      title: "Settings",
    });
    expect(resolveSidebarDrillIn("/open-project")).toBeNull();
    expect(resolveSidebarDrillIn("/h/host/sessions")).toBeNull();
  });
  it("keeps manual order independent from automatic display order", () => {
    const project = {
      viewKey: "p",
      projectKey: null,
      projectName: "P",
      projectKind: "git" as const,
      iconWorkingDir: "/p",
      hosts: [],
      workspaceKeys: ["h:b", "h:a"],
    };
    const base = {
      projects: [project],
      projectOrder: ["p"],
      workspaceOrderByScope: { p: ["h:a", "h:b"] },
    };
    expect(
      composeWorkspaceStructure({ ...base, workspaceSort: "created" }).projects[0]?.workspaceKeys,
    ).toEqual(["h:b", "h:a"]);
    expect(
      composeWorkspaceStructure({ ...base, workspaceSort: "manual" }).projects[0]?.workspaceKeys,
    ).toEqual(["h:a", "h:b"]);
  });
});
