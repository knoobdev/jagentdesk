import type { StorageValue } from "zustand/middleware";
import { describe, expect, it } from "vitest";
import {
  GUMLOOP_SIDEBAR_WIDTH,
  resolveSidebarDrillIn,
  toolsInitiallyCollapsed,
  useGumloopSidebarState,
} from "./sidebar-state";
import { composeWorkspaceStructure } from "@/stores/session-store-hooks/selectors";
import { builtinPluginEnabled } from "@/plugins/builtin/registry";

const PERSISTED = { state: { toolsCollapsed: true, projectsCollapsed: false }, version: 0 };

describe("Gumloop sidebar model", () => {
  it("has one fixed-width sidebar and chooses the default Tools fold by destination count", () => {
    expect(GUMLOOP_SIDEBAR_WIDTH).toBe(324);
    expect(toolsInitiallyCollapsed(6)).toBe(false);
    expect(toolsInitiallyCollapsed(7)).toBe(true);
  });
  it("restores the client's explicit group folds through hydration", async () => {
    let saved: StorageValue<unknown> = PERSISTED;
    useGumloopSidebarState.persist.setOptions({
      storage: {
        getItem: () => saved,
        setItem: (_key, value) => {
          saved = { ...value, version: 0 };
        },
        removeItem: () => {},
      },
    });
    await useGumloopSidebarState.persist.rehydrate();
    expect(useGumloopSidebarState.getState().toolsCollapsed).toBe(true);
    useGumloopSidebarState.getState().setToolsCollapsed(false);
    useGumloopSidebarState.getState().toggleProjects();
    expect(saved.state).toEqual({ toolsCollapsed: false, projectsCollapsed: true });
    await useGumloopSidebarState.persist.rehydrate();
    expect(useGumloopSidebarState.getState().projectsCollapsed).toBe(true);
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
  it.each([
    "bots",
    "docker",
    "database/db",
    "cluster/c",
    "servers",
    "figma",
    "jira",
    "argocd",
    "plugin/p/surface/s",
  ])("drills into /%s and keeps its owning host", (path) => {
    expect(
      resolveSidebarDrillIn(`/h/host%20one/${path}`, [
        { routeSegment: "docker", title: "Docker" },
        { routeSegment: "cluster", title: "Clusters" },
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
