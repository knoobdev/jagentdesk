import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";

/** Reveals placement's actual destination, keeping the panel beneath a sheet in place. */
export function revealWorkspaceTab(workspaceKey: string, tabId: string | null): string | null {
  if (!tabId) return null;
  const store = useWorkspaceLayoutStore.getState();
  const sheet = store.sheetsByWorkspace[workspaceKey]?.find((entry) => entry.tab.tabId === tabId);
  if (sheet) return tabId;
  const layout = store.layoutByWorkspace[workspaceKey];
  if (!layout || !collectAllTabs(layout.root).some((tab) => tab.tabId === tabId)) return null;
  store.focusTab(workspaceKey, tabId);
  if (store.layoutMode === "compact") usePanelStore.getState().showMobileAgent();
  return tabId;
}
