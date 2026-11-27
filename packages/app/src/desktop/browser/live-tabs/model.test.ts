import { describe, expect, it } from "vitest";
import type { DesktopLiveBrowserTab } from "@/desktop/host";
import { createBrowserRecord, type BrowserRecord } from "@/desktop/browser/store/state";
import {
  createDefaultLayout,
  openTabInLayoutFocused,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import {
  browserTabRowDetailParts,
  buildBrowserTabRows,
  filterBrowserTabRowsForAgent,
  findBrowserTabPlacement,
  summarizeBrowserTabRows,
  type BrowserTabRow,
  type BrowserTabStatus,
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

function makeRow(key: string, extra: Partial<BrowserTabRow> = {}): BrowserTabRow {
  return {
    key,
    browserId: key,
    webContentsId: 1,
    title: key,
    url: "http://localhost:3000/",
    host: "localhost:3000",
    faviconUrl: null,
    status: "ready",
    placement: null,
    workspaceName: "A",
    agentName: null,
    opener: null,
    homeWorkspace: null,
    ...extra,
  };
}

function rowsWithStatuses(statuses: BrowserTabStatus[]): BrowserTabRow[] {
  return statuses.map((status, index) => makeRow(`tab-${index}`, { status }));
}

describe("filterBrowserTabRowsForAgent", () => {
  it("keeps only the tabs the agent opened on that host", () => {
    const rows = [
      makeRow("mine-1", { opener: { serverId: SERVER, agentId: "agt_1" } }),
      makeRow("other-agent", { opener: { serverId: SERVER, agentId: "agt_2" } }),
      makeRow("same-id-other-host", { opener: { serverId: "srv_remote", agentId: "agt_1" } }),
      makeRow("user-opened"),
      makeRow("mine-2", { opener: { serverId: SERVER, agentId: "agt_1" } }),
    ];
    expect(filterBrowserTabRowsForAgent(rows, SERVER, "agt_1").map((entry) => entry.key)).toEqual([
      "mine-1",
      "mine-2",
    ]);
    expect(filterBrowserTabRowsForAgent(rows, SERVER, "agt_3")).toEqual([]);
  });

  it("carries the opener from the browser record onto the row", () => {
    const opener = { serverId: SERVER, workspaceId: WORKSPACE_A, agentId: "agt_1" };
    const rows = buildBrowserTabRows(
      input({
        liveTabs: [
          liveTab({ webContentsId: 7, browserId: "tab-1" }),
          liveTab({ webContentsId: 8, browserId: "tab-2" }),
        ],
        browsersById: { "tab-1": record("tab-1", { openedBy: opener }), "tab-2": record("tab-2") },
      }),
    );
    expect(rows.map((entry) => entry.opener)).toEqual([
      { serverId: SERVER, agentId: "agt_1" },
      null,
    ]);
    expect(filterBrowserTabRowsForAgent(rows, SERVER, "agt_1").map((entry) => entry.key)).toEqual([
      "tab-1",
    ]);
  });
});

describe("summarizeBrowserTabRows", () => {
  it("counts tabs with a muted badge when every tab is fine", () => {
    expect(summarizeBrowserTabRows(rowsWithStatuses(["ready", "loading"]))).toEqual({
      count: 2,
      badgeText: "2",
      tone: "muted",
      notResponding: 0,
      crashed: 0,
    });
  });

  it("turns the badge warning for a tab that is not responding", () => {
    expect(summarizeBrowserTabRows(rowsWithStatuses(["ready", "notResponding"]))).toMatchObject({
      tone: "warning",
      notResponding: 1,
      crashed: 0,
    });
  });

  it("turns the badge danger when a tab crashed, even with another one not responding", () => {
    expect(
      summarizeBrowserTabRows(rowsWithStatuses(["notResponding", "crashed", "notResponding"])),
    ).toMatchObject({ count: 3, tone: "danger", notResponding: 2, crashed: 1 });
  });

  it("caps the badge text at 99+", () => {
    expect(summarizeBrowserTabRows(rowsWithStatuses(Array(99).fill("ready"))).badgeText).toBe("99");
    expect(summarizeBrowserTabRows(rowsWithStatuses(Array(100).fill("ready"))).badgeText).toBe(
      "99+",
    );
  });

  it("is empty with no tabs", () => {
    expect(summarizeBrowserTabRows([])).toMatchObject({ count: 0, badgeText: "0", tone: "muted" });
  });
});

describe("browserTabRowDetailParts", () => {
  const options = { notInWorkspace: "Not in a workspace" };

  it("names host, workspace and agent in the full list", () => {
    const entry = makeRow("tab-1", { agentName: "Fix login flow" });
    expect(browserTabRowDetailParts(entry, { ...options, includeAgent: true })).toEqual([
      "localhost:3000",
      "A",
      "Fix login flow",
    ]);
  });

  it("leaves the agent out of one agent's list", () => {
    const entry = makeRow("tab-1", { agentName: "Fix login flow" });
    expect(browserTabRowDetailParts(entry, { ...options, includeAgent: false })).toEqual([
      "localhost:3000",
      "A",
    ]);
  });

  it("says Not in a workspace for an orphan and skips an empty host", () => {
    const entry = makeRow("tab-1", { workspaceName: null, host: "" });
    expect(browserTabRowDetailParts(entry, { ...options, includeAgent: true })).toEqual([
      "Not in a workspace",
    ]);
  });
});
