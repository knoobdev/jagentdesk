import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Puzzle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useBuiltinInspectorTabs } from "@/plugins/builtin/surfaces";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/**
 * The agent an inspector tab describes: the focused pane's agent, else the agent shown in any
 * pane (focusing the inspector itself moves pane focus away from the chat).
 */
export function resolveInspectedAgentId(layout: WorkspaceLayout | undefined): string | null {
  if (!layout) return null;
  const tabs = collectAllTabs(layout.root);
  const agentOf = (tabId: string | null | undefined) => {
    const tab = tabs.find((candidate) => candidate.tabId === tabId);
    return tab?.target.kind === "agent" ? tab.target.agentId : null;
  };
  const focused = agentOf(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId);
  if (focused) return focused;
  // Focus is on the inspector itself: the agent each chat pane shows, in layout order.
  for (const pane of collectAllPanes(layout.root)) {
    const shown = agentOf(pane.focusedTabId);
    if (shown) return shown;
  }
  return null;
}

export function useInspectedAgentId(serverId: string, workspaceId: string | null | undefined) {
  const key = workspaceId ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId }) : null;
  const layout = useWorkspaceLayoutStore((state) =>
    key ? state.layoutByWorkspace[key] : undefined,
  );
  return useMemo(() => resolveInspectedAgentId(layout), [layout]);
}

function BuiltinInspectorPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const tabs = useBuiltinInspectorTabs(serverId);
  const agentId = useInspectedAgentId(serverId, workspaceId);
  const tab =
    target.kind === "builtin_inspector" ? tabs.find((entry) => entry.id === target.tabId) : null;
  if (!tab) return <View />;
  if (!agentId)
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>{t("builtinPlugins.inspectorNoAgent")}</Text>
      </View>
    );
  const Component = tab.component;
  return <Component serverId={serverId} agentId={agentId} />;
}

function useBuiltinInspectorDescriptor(
  target: Extract<
    import("@/workspace-tabs/model").WorkspaceTabTarget,
    { kind: "builtin_inspector" }
  >,
  context: { serverId: string },
) {
  const tab = useBuiltinInspectorTabs(context.serverId).find((entry) => entry.id === target.tabId);
  const label = tab?.title ?? target.tabId;
  return {
    label,
    subtitle: label,
    tooltip: label,
    titleState: "ready" as const,
    icon: tab?.icon ?? Puzzle,
    statusBucket: null,
  };
}

export const builtinInspectorPanelRegistration: PanelRegistration<"builtin_inspector"> = {
  kind: "builtin_inspector",
  component: BuiltinInspectorPanel,
  useDescriptor: useBuiltinInspectorDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  empty: { flex: 1, padding: theme.spacing[4] },
  emptyText: { fontSize: 14, color: theme.colors.foregroundMuted },
}));
