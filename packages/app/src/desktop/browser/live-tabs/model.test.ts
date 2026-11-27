import { describe, expect, it } from "vitest";
import type { DesktopLiveBrowserTab } from "@/desktop/host";
import { createBrowserRecord, type BrowserRecord } from "@/desktop/browser/store/state";
import {
  createDefaultLayout,
  openTabInLayoutFocused,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import {
  buildBrowserTabRows,
  findBrowserTabPlacement,
  type BuildBrowserTabRowsInput,
} from "./model";

const SERVER = "srv_local";
const WORKSPACE_A = "wks_alpha";
const WORKSPACE_KEY_A = `${SERVER}:${WORKSPACE_A}`;

function layoutWithBrowsers(browserIds: string[]): { layout: WorkspaceLayout; tabIds: string[] } {
  let layout = createDefaultLayout();
  const tabIds: string[] = [];
  for (const browserId of browserIds) {
    const result = openTabInLayoutFocused({
      layout,
      target: { kind: "browser", browserId },
      now: 1,
    });
    layout = result.layout;
    tabIds.push(result.tabId);
  }
  return { layout, tabIds };
}

function liveTab(overrides: Partial<DesktopLiveBrowserTab>): DesktopLiveBrowserTab {
  return {
    webContentsId: 1,
    browserId: null,
    workspaceId: null,
    url: "",
    title: "",
    faviconUrl: null,
    status: "ready",
    ...overrides,
  };
}

function record(browserId: string, extra: Partial<BrowserRecord> = {}): BrowserRecord {
  return { ...createBrowserRecord({ browserId, initialUrl: "about:blank", now: 1 }), ...extra };
}

function input(overrides: Partial<BuildBrowserTabRowsInput>): BuildBrowserTabRowsInput {
  return {
    liveTabs: [],
    elements: [],
    browsersById: {},
    layouts: { layoutByWorkspace: {}, sheetsByWorkspace: {} },
    serverIds: [SERVER],
    resolveWorkspaceName: (serverId, workspaceId) =>
      serverId === SERVER && workspaceId === WORKSPACE_A ? "A" : null,
    resolveAgentName: (serverId, agentId) =>
      serverId === SERVER && agentId === "agt_1" ? "Fix login flow" : null,
    ...overrides,
  };
}

describe("buildBrowserTabRows", () => {
  it("lists agent tabs with host, workspace and agent", () => {
    const { layout, tabIds } = layoutWithBrowsers(["tab-1", "tab-2"]);
    const opener = { serverId: SERVER, workspaceId: WORKSPACE_A, agentId: "agt_1" };
    const rows = buildBrowserTabRows(
      input({
        liveTabs: [
          liveTab({
            webContentsId: 7,
            browserId: "tab-1",
            workspaceId: WORKSPACE_A,
            url: "http://127.0.0.1:4173/login",
            title: "Sign in",
          }),
          liveTab({
            webContentsId: 8,
            browserId: "tab-2",
            workspaceId: WORKSPACE_A,
            url: "http://localhost:5173/",
            status: "loading",
          }),
        ],
        browsersById: {
          "tab-1": record("tab-1", { openedBy: opener }),
          "tab-2": record("tab-2", { openedBy: opener }),
        },
        layouts: { layoutByWorkspace: { [WORKSPACE_KEY_A]: layout }, sheetsByWorkspace: {} },
      }),
    );

    expect(
      rows.map((row) => [row.title, row.host, row.workspaceName, row.agentName, row.status]),
    ).toEqual([
      ["Sign in", "127.0.0.1:4173", "A", "Fix login flow", "ready"],
      ["http://localhost:5173/", "localhost:5173", "A", "Fix login flow", "loading"],
    ]);
    expect(rows[0]?.placement).toEqual({
      serverId: SERVER,
      workspaceId: WORKSPACE_A,
      workspaceKey: WORKSPACE_KEY_A,
      tabId: tabIds[0],
    });
  });

  it("keeps a parked webview without a tab as an orphan with its home workspace", () => {
    const rows = buildBrowserTabRows(
      input({
        liveTabs: [
          liveTab({ webContentsId: 9, browserId: "tab-orphan", workspaceId: WORKSPACE_A }),
        ],
        browsersById: { "tab-orphan": record("tab-orphan", { url: "http://localhost:3000/" }) },
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      browserId: "tab-orphan",
      placement: null,
      workspaceName: null,
      agentName: null,
      host: "localhost:3000",
      homeWorkspace: { serverId: null, workspaceId: WORKSPACE_A },
    });
  });

  it("names an unregistered guest from its element and adds elements main has not seen", () => {
    const rows = buildBrowserTabRows(
      input({
        liveTabs: [liveTab({ webContentsId: 12, browserId: null, url: "http://localhost:8080/" })],
        elements: [
          { browserId: "tab-unregistered", webContentsId: 12 },
          { browserId: "tab-attaching", webContentsId: null },
        ],
      }),
    );

    expect(rows.map((row) => [row.key, row.webContentsId, row.status])).toEqual([
      ["tab-unregistered", 12, "ready"],
      ["tab-attaching", null, "loading"],
    ]);
  });

  it("shows one row per browser when main and the element both report it", () => {
    const rows = buildBrowserTabRows(
      input({
        liveTabs: [liveTab({ webContentsId: 3, browserId: "tab-1", status: "crashed" })],
        elements: [{ browserId: "tab-1", webContentsId: 3 }],
      }),
    );
    expect(rows.map((row) => [row.key, row.status])).toEqual([["tab-1", "crashed"]]);
  });
});

describe("findBrowserTabPlacement", () => {
  it("finds a browser tab held in a compact sheet", () => {
    const { layout } = layoutWithBrowsers(["tab-other"]);
    const sheetTab = {
      tabId: "sheet-tab",
      target: { kind: "browser" as const, browserId: "tab-1" },
      createdAt: 1,
    };
    expect(
      findBrowserTabPlacement(
        "tab-1",
        {
          layoutByWorkspace: { [WORKSPACE_KEY_A]: layout },
          sheetsByWorkspace: { [WORKSPACE_KEY_A]: [{ tab: sheetTab }] },
        },
        [SERVER],
      ),
    ).toEqual({
      serverId: SERVER,
      workspaceId: WORKSPACE_A,
      workspaceKey: WORKSPACE_KEY_A,
      tabId: "sheet-tab",
    });
  });
});
