import { getDesktopHost } from "@/desktop/host";
import {
  removeBrowserWebviewElement,
  removeResidentBrowserWebview,
} from "@/desktop/browser/resident-webviews";
import { useBrowserStore } from "@/desktop/browser/store";
import {
  getLastWorkspaceSelection,
  navigateToWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { selectIsFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, findPaneContainingTab } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import type { BrowserTabRow } from "./model";

function findServerWithWorkspace(workspaceId: string): string | null {
  for (const [serverId, session] of Object.entries(useSessionStore.getState().sessions)) {
    if (resolveWorkspaceMapKeyByIdentity({ workspaces: session.workspaces, workspaceId })) {
      return serverId;
    }
  }
  return null;
}

/**
 * The workspace an orphan webview gets a tab in: the one it was opened or registered in, or the
 * open workspace when that one is unknown (spec 04 §27d.1, Show).
 */
function resolveOrphanWorkspace(
  row: BrowserTabRow,
): { serverId: string; workspaceId: string } | null {
  const home = row.homeWorkspace;
  if (home) {
    const serverId = home.serverId ?? findServerWithWorkspace(home.workspaceId);
    const workspaces = serverId ? useSessionStore.getState().sessions[serverId]?.workspaces : null;
    if (
      serverId &&
      resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: home.workspaceId })
    ) {
      return { serverId, workspaceId: home.workspaceId };
    }
  }
  return getLastWorkspaceSelection();
}

/** Opens the row's workspace and selects its tab; an orphan gets a new tab first. */
export function showBrowserTab(row: BrowserTabRow): boolean {
  const browserId = row.browserId;
  if (!browserId) return false;
  const destination = row.placement ?? resolveOrphanWorkspace(row);
  if (!destination) return false;
  if (!row.placement) {
    useBrowserStore.getState().ensureBrowser({ browserId, url: row.url, title: row.title });
  }
  navigateToWorkspace({
    serverId: destination.serverId,
    workspaceId: destination.workspaceId,
    target: { kind: "browser", browserId },
  });
  if (!showInMainPane({ ...destination, browserId })) {
    revealInspectorPane({ ...destination, browserId });
  }
  return true;
}

function findBrowserTabId(workspaceKey: string, browserId: string): string | null {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  if (!layout) return null;
  const tab = collectAllTabs(layout.root).find(
    (candidate) => candidate.target.kind === "browser" && candidate.target.browserId === browserId,
  );
  return tab?.tabId ?? null;
}

/**
 * Agent tabs open in the inspector (spec 04 §27b.3); Show moves the same webview to the
 * workspace's main pane when it has one (spec 38 §4.5), so the page gets the full width.
 */
function showInMainPane(input: {
  serverId: string;
  workspaceId: string;
  browserId: string;
}): boolean {
  const workspaceKey = `${input.serverId}:${input.workspaceId}`;
  const tabId = findBrowserTabId(workspaceKey, input.browserId);
  if (!tabId) return false;
  return useWorkspaceLayoutStore.getState().moveTabToMainPane(workspaceKey, tabId);
}

/**
 * A workspace without a main pane keeps the tab in the inspector, which only shows while the file
 * explorer is open. Open it so the selected tab is on screen, as plugin navigation does.
 */
function revealInspectorPane(input: { serverId: string; workspaceId: string; browserId: string }) {
  const workspaceKey = `${input.serverId}:${input.workspaceId}`;
  const layoutStore = useWorkspaceLayoutStore.getState();
  const layout = layoutStore.layoutByWorkspace[workspaceKey];
  const explorerPaneId = layoutStore.explorerPaneIdByWorkspace[workspaceKey];
  if (!layout || !explorerPaneId) return;
  const tab = collectAllTabs(layout.root).find(
    (candidate) =>
      candidate.target.kind === "browser" && candidate.target.browserId === input.browserId,
  );
  if (!tab || findPaneContainingTab(layout.root, tab.tabId)?.id !== explorerPaneId) return;
  const workspaces = useSessionStore.getState().sessions[input.serverId]?.workspaces;
  const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: input.workspaceId });
  const workspace = key ? workspaces?.get(key) : null;
  if (!workspace?.workspaceDirectory) return;
  if (selectIsFileExplorerOpen(usePanelStore.getState(), { isCompact: false })) return;
  refocusWhenLayoutSettles(workspaceKey, input.browserId);
  usePanelStore.getState().openFileExplorerForCheckout({
    isCompact: false,
    checkout: {
      serverId: input.serverId,
      cwd: workspace.workspaceDirectory,
      isGit: workspace.projectKind === "git",
    },
  });
}

const LAYOUT_SETTLE_MS = 150;
const LAYOUT_SETTLE_LIMIT_MS = 2000;

/**
 * Opening the inspector runs its own effect a render later, which focuses its default tab
 * (Files or Changes). Select the browser tab again once the layout stops changing.
 */
function refocusWhenLayoutSettles(workspaceKey: string, browserId: string): void {
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const refocus = () => {
    unsubscribe();
    clearTimeout(limitTimer);
    if (settleTimer) clearTimeout(settleTimer);
    const store = useWorkspaceLayoutStore.getState();
    const layout = store.layoutByWorkspace[workspaceKey];
    const tab = layout
      ? collectAllTabs(layout.root).find(
          (candidate) =>
            candidate.target.kind === "browser" && candidate.target.browserId === browserId,
        )
      : null;
    if (tab) store.focusTab(workspaceKey, tab.tabId);
  };
  const unsubscribe = useWorkspaceLayoutStore.subscribe(() => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(refocus, LAYOUT_SETTLE_MS);
  });
  const limitTimer = setTimeout(refocus, LAYOUT_SETTLE_LIMIT_MS);
}

/** Closes the row's tab and destroys its webview. */
export async function closeBrowserTab(row: BrowserTabRow): Promise<void> {
  const browserId = row.browserId;
  if (browserId) {
    // The record goes first: a pane unmounting after its tab closes parks the webview only while
    // the record still exists.
    useBrowserStore.getState().removeBrowser(browserId);
    removeResidentBrowserWebview(browserId);
    if (row.placement) {
      useWorkspaceLayoutStore.getState().closeTab(row.placement.workspaceKey, row.placement.tabId);
    }
  }
  removeBrowserWebviewElement({ browserId, webContentsId: row.webContentsId });
  if (browserId) {
    await getDesktopHost()?.browser?.unregisterWorkspaceBrowser?.(browserId);
  }
}

export async function closeAllBrowserTabs(rows: readonly BrowserTabRow[]): Promise<void> {
  await Promise.all(rows.map((row) => closeBrowserTab(row)));
}
