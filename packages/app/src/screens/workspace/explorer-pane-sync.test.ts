import { beforeEach, describe, expect, it } from "vitest";
import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllTabs,
  createWorkspaceLayoutStore,
  findPaneById,
} from "@/stores/workspace-layout-store";
import { createExplorerPaneSync } from "./explorer-pane-sync";

// Layout stores persist; each test gets its own workspace.
let workspaceCount = 0;
let WORKSPACE_KEY = "server-1:wks_0";
const CHECKOUT = { serverId: "server-1", cwd: "/tmp/alpha", isGit: false };
const GIT_CHECKOUT = { ...CHECKOUT, cwd: "/tmp/repo", isGit: true };

let layoutStore = createWorkspaceLayoutStore();
let sync = createExplorerPaneSync(() => layoutStore.getState());

/** What the workspace screen's explorer effect does after each store change. */
function render(isGit = false) {
  const panel = usePanelStore.getState();
  sync({
    workspaceKey: WORKSPACE_KEY,
    open: panel.desktop.fileExplorerOpen,
    isGit,
    explorerTab: panel.explorerTab,
    explorerTabRequest: panel.explorerTabRequest,
  });
}

function explorerPane() {
  const state = layoutStore.getState();
  const layout = state.layoutByWorkspace[WORKSPACE_KEY];
  const paneId = state.explorerPaneIdByWorkspace[WORKSPACE_KEY];
  if (!layout || !paneId) return null;
  const pane = findPaneById(layout.root, paneId);
  if (!pane) return null;
  const kinds = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab.target.kind]));
  return {
    focused: pane.focusedTabId ? kinds.get(pane.focusedTabId) : null,
    kinds: pane.tabIds.map((tabId) => kinds.get(tabId)),
  };
}

/** The agent's browser_new_tab (desktop/browser/automation/handler.ts). */
function agentOpensBrowserTab() {
  layoutStore.getState().openTabInExplorerPaneFocused(WORKSPACE_KEY, {
    target: { kind: "browser", browserId: "browser-1" },
  });
  usePanelStore.getState().openFileExplorerForCheckout({ isCompact: false, checkout: CHECKOUT });
  render();
}

function toggleInspector(checkout = CHECKOUT) {
  usePanelStore.getState().toggleFileExplorerForCheckout({ isCompact: false, checkout });
  render(checkout.isGit);
}

beforeEach(() => {
  workspaceCount += 1;
  WORKSPACE_KEY = `server-1:wks_${workspaceCount}`;
  layoutStore = createWorkspaceLayoutStore();
  sync = createExplorerPaneSync(() => layoutStore.getState());
  usePanelStore.setState((state) => ({
    desktop: { ...state.desktop, fileExplorerOpen: false },
    explorerTab: "changes",
    explorerTabByCheckout: {},
  }));
  layoutStore.getState().openTabFocused(WORKSPACE_KEY, { kind: "draft", draftId: "chat" });
  render();
});

describe("explorer pane sync", () => {
  it("keeps an agent's browser tab focused when it opens the closed inspector", () => {
    agentOpensBrowserTab();
    expect(usePanelStore.getState().desktop.fileExplorerOpen).toBe(true);
    expect(explorerPane()?.focused).toBe("browser");
    // The inspector still offers its own tabs.
    expect(explorerPane()?.kinds).toContain("files");
  });

  it("shows the last tab when the user opens the inspector with its toggle", () => {
    agentOpensBrowserTab();
    toggleInspector();
    expect(usePanelStore.getState().desktop.fileExplorerOpen).toBe(false);
    toggleInspector();
    expect(explorerPane()?.focused).toBe("browser");
  });

  it("shows a browser tab already in the closed inspector when the user opens it", () => {
    layoutStore.getState().openTabInExplorerPaneFocused(WORKSPACE_KEY, {
      target: { kind: "browser", browserId: "browser-1" },
    });
    render();
    toggleInspector();
    expect(explorerPane()?.focused).toBe("browser");
    expect(explorerPane()?.kinds).toContain("files");
  });

  it("still shows the tab a control asks for", () => {
    agentOpensBrowserTab();
    usePanelStore.getState().setExplorerTabForCheckout({ ...CHECKOUT, tab: "files" });
    render();
    expect(explorerPane()?.focused).toBe("files");
  });

  it("asks again for a tab that is already the remembered one", () => {
    toggleInspector();
    expect(explorerPane()?.focused).toBe("files");
    agentOpensBrowserTab();
    expect(explorerPane()?.focused).toBe("browser");
    // "Open directory" from the chat: Files, though explorerTab already is "files".
    usePanelStore.getState().setExplorerTabForCheckout({ ...CHECKOUT, tab: "files" });
    render();
    expect(explorerPane()?.focused).toBe("files");
  });

  it("opens a new inspector on its default tab", () => {
    toggleInspector(GIT_CHECKOUT);
    expect(explorerPane()).toEqual({ focused: "changes_tree", kinds: ["changes_tree", "files"] });
  });
});
