import type { PluginSidebarViewProps, WorkspaceRef } from "@jagentdesk/plugin/client";
import { router } from "expo-router";
import { useCallback, useMemo, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { queryClient } from "@/data/query-client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  useActiveWorkspaceSelection,
  navigateToWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import type { ListTerminalsPayload } from "@/screens/workspace/terminals/state";
import type { Theme } from "@/styles/theme";
import { useInstalledPlugins } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { sidebarViews, type SidebarViewEntry } from "./catalog";
import { SidebarViewFrame } from "./frame";
import { useSidebarViewSelection } from "./selection";

export function SidebarViewSlot({
  children,
  dismiss,
}: {
  children: ReactNode;
  dismiss: () => void;
}) {
  const installed = useInstalledPlugins();
  const { state, reload, setSelection, pending, error } = useSidebarViewSelection();
  const restoreDefault = useCallback(() => setSelection("default"), [setSelection]);
  const renderError = useCallback(
    () => (
      <View style={styles.failure}>
        <Text style={styles.text}>The sidebar view failed.</Text>
        <Button onPress={restoreDefault} disabled={pending}>
          Use Projects
        </Button>
        {error ? <Text style={styles.text}>{error.message}</Text> : null}
      </View>
    ),
    [error, pending, restoreDefault],
  );
  const entry =
    state.status === "ready"
      ? sidebarViews(installed).find((view) => view.id === state.selection)
      : undefined;
  const view = entry ? (
    <View style={styles.content} testID="plugin-sidebar-view">
      <SurfaceErrorBoundary
        installation={entry.plugin}
        Surface={entry.view.Component}
        renderError={renderError}
      >
        <ThemedSidebarView entry={entry} dismiss={dismiss} />
      </SurfaceErrorBoundary>
    </View>
  ) : null;
  return (
    <SidebarViewFrame state={state} fallback={children} reload={reload}>
      {view}
    </SidebarViewFrame>
  );
}

function SidebarView({
  entry,
  dismiss,
  theme,
}: {
  entry: SidebarViewEntry;
  dismiss: () => void;
  theme: PluginSidebarViewProps["theme"];
}) {
  const client = useHostRuntimeClient(entry.plugin.serverId);
  const compact = useIsCompactFormFactor();
  const selection = useActiveWorkspaceSelection();
  const focusedAgentId = useSessionStore((state) =>
    selection ? (state.sessions[selection.serverId]?.focusedAgentId ?? null) : null,
  );
  const toast = useToast();
  const active = useMemo<PluginSidebarViewProps["active"]>(() => {
    if (!selection) return { workspace: null, agent: null };
    const workspace: WorkspaceRef = {
      kind: "workspace",
      hostId: selection.serverId,
      id: selection.workspaceId,
      key: `${selection.serverId}:${selection.workspaceId}`,
    };
    const agent = focusedAgentId
      ? {
          kind: "agent" as const,
          hostId: selection.serverId,
          id: focusedAgentId,
          key: `${selection.serverId}:${focusedAgentId}`,
        }
      : null;
    return { workspace, agent };
  }, [focusedAgentId, selection]);
  const navigation = useMemo<PluginSidebarViewProps["navigation"]>(
    () => ({
      openWorkspace(ref) {
        navigateToWorkspace({ serverId: ref.hostId, workspaceId: ref.id });
        dismiss();
      },
      openAgent(ref) {
        navigateToAgent({ serverId: ref.hostId, agentId: ref.id });
        dismiss();
      },
      openTerminal(ref) {
        const entries = queryClient.getQueriesData<ListTerminalsPayload>({
          queryKey: ["terminals", ref.hostId],
        });
        for (const [key, payload] of entries) {
          const workspaceId = key[3];
          if (
            typeof workspaceId === "string" &&
            payload?.terminals.some((terminal) => terminal.id === ref.id)
          ) {
            navigateToWorkspace({
              serverId: ref.hostId,
              workspaceId,
              target: { kind: "terminal", terminalId: ref.id },
            });
            dismiss();
            return;
          }
        }
        toast.error("Terminal is unavailable. Open its workspace to refresh terminals.");
      },
      openProject(ref) {
        const project = useSessionStore.getState().sessions[ref.hostId]?.projects.get(ref.id);
        if (!project) {
          toast.error("Project is unavailable.");
          return;
        }
        router.push(
          buildNewWorkspaceRoute({
            serverId: ref.hostId,
            projectId: ref.id,
            sourceDirectory: project.projectRootPath,
          }),
        );
        dismiss();
      },
    }),
    [dismiss, toast],
  );
  const layout = useMemo(() => {
    let platform: "ios" | "android" | "web" = "web";
    if (Platform.OS === "ios") platform = "ios";
    if (Platform.OS === "android") platform = "android";
    return { compact, platform };
  }, [compact]);
  const Component = entry.view.Component;
  if (!client) return <Text style={styles.text}>Plugin host is offline.</Text>;
  return (
    <PluginRuntimeBoundary plugin={entry.plugin} client={client}>
      <Component
        theme={theme}
        layout={layout}
        active={active}
        navigation={navigation}
        dismiss={dismiss}
      />
    </PluginRuntimeBoundary>
  );
}
const ThemedSidebarView = withUnistyles(SidebarView, (theme: Theme) => ({
  theme: toPluginTheme(theme),
}));
const styles = StyleSheet.create((theme) => ({
  content: { flex: 1 },
  failure: { padding: 16, gap: 12 },
  text: { color: theme.colors.foreground },
}));
