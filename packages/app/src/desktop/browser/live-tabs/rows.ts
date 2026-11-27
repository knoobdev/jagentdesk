import { useMemo } from "react";
import { useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { buildBrowserTabRows, type BrowserTabRow } from "./model";
import { useLiveBrowserTabsStore, useLiveBrowserTabsSync } from "./store";

function resolveWorkspaceName(serverId: string, workspaceId: string): string | null {
  const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
  const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId });
  const workspace = key ? workspaces?.get(key) : undefined;
  return workspace ? workspace.title?.trim() || workspace.name : null;
}

function resolveAgentName(serverId: string, agentId: string): string | null {
  const agent = useSessionStore.getState().sessions[serverId]?.agents.get(agentId);
  return agent ? agent.title?.trim() || agent.provider : null;
}

/** Every live browser webview of this window as list rows (spec 04 §27d.1). Electron only. */
export function useBrowserTabRows(): BrowserTabRow[] {
  useLiveBrowserTabsSync();
  const liveTabs = useLiveBrowserTabsStore((state) => state.liveTabs);
  const elements = useLiveBrowserTabsStore((state) => state.elements);
  const browsersById = useBrowserStore((state) => state.browsersById);
  const layoutByWorkspace = useWorkspaceLayoutStore((state) => state.layoutByWorkspace);
  const sheetsByWorkspace = useWorkspaceLayoutStore((state) => state.sheetsByWorkspace);
  const serverIds = useSessionStore((state) => Object.keys(state.sessions).join("\n"));
  return useMemo(
    () =>
      buildBrowserTabRows({
        liveTabs,
        elements,
        browsersById,
        layouts: { layoutByWorkspace, sheetsByWorkspace },
        serverIds: serverIds ? serverIds.split("\n") : [],
        resolveWorkspaceName,
        resolveAgentName,
      }),
    [browsersById, elements, layoutByWorkspace, liveTabs, serverIds, sheetsByWorkspace],
  );
}
