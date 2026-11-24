import type { JsonValue } from "@jagentdesk/protocol/agent-types";
import type { PluginTab } from "@jagentdesk/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { usePaneContext } from "@/panels/pane-context";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

export function usePluginPanelTab(): { tab: PluginTab; revision: number } {
  const { serverId, workspaceId, tabId, fileNavigationRevision } = usePaneContext();
  const workspaceKey = `${serverId}:${workspaceId}`;
  const state = useWorkspaceLayoutStore(
    (store) => store.panelStateByWorkspace[workspaceKey]?.[tabId],
  );
  const panelRevision = useWorkspaceLayoutStore(
    (store) => store.panelRevisionByWorkspace[workspaceKey]?.[tabId] ?? 0,
  );
  const [modified, setModified] = useState(false);
  const attributes = useMemo(() => ({ modified }), [modified]);
  usePublishPanelInstanceAttributes(attributes);
  const setState = useCallback(
    (value: JsonValue) =>
      useWorkspaceLayoutStore.getState().setTabState(workspaceKey, tabId, value),
    [workspaceKey, tabId],
  );
  const tab = useMemo(() => ({ state, setState, setModified }), [state, setState]);
  return { tab, revision: Math.max(panelRevision, fileNavigationRevision ?? 0) };
}
