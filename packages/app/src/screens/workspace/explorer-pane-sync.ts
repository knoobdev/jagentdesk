import type { ExplorerTab } from "@/stores/panel-store";
import {
  collectAllTabs,
  findPaneById,
  type useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";

type LayoutStoreState = ReturnType<typeof useWorkspaceLayoutStore.getState>;

export function resolveExplorerPanelKind(
  tab: string,
  isGit: boolean,
): "files" | "changes_tree" | "pull_request" | "ledger" {
  if (tab === "ledger") return "ledger";
  if (!isGit || tab === "files") return "files";
  return tab === "pr" ? "pull_request" : "changes_tree";
}

export interface ExplorerPaneSyncInput {
  workspaceKey: string;
  open: boolean;
  isGit: boolean;
  /** The panel store's `explorerTab`: the checkout's remembered or requested tab. */
  explorerTab: ExplorerTab;
  /** The panel store's `explorerTabRequest`: changes on each explicit request for a tab. */
  explorerTabRequest: number;
}

const DEFAULT_KINDS_GIT = ["changes_tree", "files"] as const;
const DEFAULT_KINDS = ["files"] as const;

/**
 * Keeps the inspector pane of the workspace layout in step with the panel store (the workspace
 * screen's explorer effect calls it on every change).
 *
 * - A new inspector pane gets its default tabs and shows the requested one.
 * - Opening an existing pane keeps the tab it shows: the browser tab an agent or "Show" just
 *   put there, or the tab the user left. Its default tabs are added behind it when missing.
 *   Opening alone is not a tab request, even when the checkout's remembered tab differs from
 *   the last one (that used to put Files in front of an agent's browser tab).
 * - An explicit request (explorer tab bar, "open directory", review attachment…) shows its tab.
 */
export function createExplorerPaneSync(getStore: () => LayoutStoreState) {
  let previous: { workspaceKey: string; open: boolean; request: number } | null = null;
  return function syncExplorerPane(input: ExplorerPaneSyncInput): void {
    const { workspaceKey, open, isGit, explorerTab, explorerTabRequest } = input;
    const last = previous?.workspaceKey === workspaceKey ? previous : null;
    previous = { workspaceKey, open, request: explorerTabRequest };
    const store = getStore();
    const paneId = store.explorerPaneIdByWorkspace[workspaceKey];
    if (!open) {
      if (paneId) store.hidePane(workspaceKey, paneId);
      return;
    }
    const result = store.ensureExplorerPane(workspaceKey);
    if (!result) return;
    const requestedKind = resolveExplorerPanelKind(explorerTab, isGit);
    const defaultKinds = isGit ? DEFAULT_KINDS_GIT : DEFAULT_KINDS;
    if (result.created) {
      for (const kind of defaultKinds) {
        store.openTabInExplorerPaneFocused(workspaceKey, { target: { kind } });
      }
      store.openTabInExplorerPaneFocused(workspaceKey, { target: { kind: requestedKind } });
      return;
    }
    if (!last?.open) {
      addMissingDefaultTabs(getStore, workspaceKey, result.paneId, defaultKinds);
    }
    if (last && last.request !== explorerTabRequest) {
      store.openTabInExplorerPaneFocused(workspaceKey, { target: { kind: requestedKind } });
    }
  };
}

/** Adds the inspector's default tabs it lacks without changing the tab it shows. */
function addMissingDefaultTabs(
  getStore: () => LayoutStoreState,
  workspaceKey: string,
  paneId: string,
  kinds: readonly ("changes_tree" | "files")[],
): void {
  const layout = getStore().layoutByWorkspace[workspaceKey];
  const pane = layout ? findPaneById(layout.root, paneId) : null;
  if (!layout || !pane) return;
  const present = new Set(
    collectAllTabs(layout.root)
      .filter((tab) => pane.tabIds.includes(tab.tabId))
      .map((tab) => tab.target.kind),
  );
  const missing = kinds.filter((kind) => !present.has(kind));
  if (missing.length === 0) return;
  for (const kind of missing) {
    getStore().openTabInExplorerPaneFocused(workspaceKey, { target: { kind } });
  }
  if (pane.focusedTabId) getStore().focusTab(workspaceKey, pane.focusedTabId);
}
