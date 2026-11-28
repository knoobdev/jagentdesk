import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { selectIsFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

interface WorkspaceRef {
  serverId: string;
  workspaceId: string;
}

/**
 * Opens the desktop inspector (the right sidebar) for a workspace so a tab just put in its pane is
 * on screen. The inspector keeps showing that tab: opening it is not a request for Files or Changes
 * (screens/workspace/explorer-pane-sync.ts).
 */
export function openWorkspaceInspector(input: WorkspaceRef): boolean {
  const workspaces = useSessionStore.getState().sessions[input.serverId]?.workspaces;
  const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: input.workspaceId });
  const workspace = key ? workspaces?.get(key) : null;
  if (!workspace?.workspaceDirectory) return false;
  if (selectIsFileExplorerOpen(usePanelStore.getState(), { isCompact: false })) return true;
  usePanelStore.getState().openFileExplorerForCheckout({
    isCompact: false,
    checkout: {
      serverId: input.serverId,
      cwd: workspace.workspaceDirectory,
      isGit: workspace.projectKind === "git",
    },
  });
  return true;
}

/** True when the workspace is the one the window shows (or showed last). */
export function isShownWorkspace(input: WorkspaceRef): boolean {
  const shown = getLastWorkspaceSelection();
  return shown?.serverId === input.serverId && shown.workspaceId === input.workspaceId;
}
