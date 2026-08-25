import { useCallback, useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { MessageSquare, X } from "lucide-react-native";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  PaneProvider,
  PaneFocusProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { askAgentAboutResource } from "@/components/cluster-ask-agent";
import type { ClusterComposerResource } from "@/components/cluster-composer";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  useClusterChatStore,
  CLUSTER_CHAT_MIN_WIDTH,
  CLUSTER_CHAT_MAX_WIDTH,
} from "@/stores/cluster-chat-store";
import type { Theme } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const noop = () => {};

const CLUSTER_AGENT_LABEL = "jagentdesk.cluster.id";

/** Most recently active, non-archived agent that was created for this cluster. */
function findLatestClusterAgent(
  agents: Map<string, Agent> | undefined,
  clusterId: string,
): Agent | null {
  if (!agents) return null;
  let latest: Agent | null = null;
  for (const agent of agents.values()) {
    if (agent.archivedAt) continue;
    if (agent.labels?.[CLUSTER_AGENT_LABEL] !== clusterId) continue;
    if (!latest || agent.lastActivityAt > latest.lastActivityAt) latest = agent;
  }
  return latest;
}

/**
 * The chat surface for the cluster view — the ONLY place chat lives, a right
 * sidebar that is open by default. So the composer is the REAL agent composer
 * (model / thinking / permission / @files / commands / subagents), it eagerly
 * spins up one idle agent per cluster with the cluster context baked in
 * (clusterId, kubectl tools, "wait for the user's question") and renders the
 * agent conversation. The k8s content stays on the left the whole time.
 */
export function ClusterChatDock({
  serverId,
  clusterId,
  clusterName,
  resource,
}: {
  serverId: string;
  clusterId: string;
  clusterName: string;
  resource?: ClusterComposerResource;
}) {
  const open = useClusterChatStore((s) => s.open);
  const agentId = useClusterChatStore((s) => s.agentId);
  const workspaceId = useClusterChatStore((s) => s.workspaceId);
  const width = useClusterChatStore((s) => s.width);
  const hideChat = useClusterChatStore((s) => s.hideChat);
  const showChat = useClusterChatStore((s) => s.showChat);
  const setWidth = useClusterChatStore((s) => s.setWidth);
  const openChat = useClusterChatStore((s) => s.openChat);

  const client = useHostRuntimeClient(serverId);
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const firstWorkspace = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces.values().next().value,
  );
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const provider = providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const cwd = firstWorkspace?.workspaceDirectory ?? null;
  const ready = Boolean(client && provider && cwd);

  // Open ONE agent per cluster: reuse the existing one if the user already chatted
  // with this cluster (so their conversation + the model's response are still
  // there), and only create a fresh agent when none exists. Previously the dock
  // created a brand-new agent every time the workloads view mounted, which spawned
  // duplicate "main" agents and could show an empty agent instead of the one that
  // actually replied.
  const createdForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || agentId || !ready || !client || !provider || !cwd) return;
    if (createdForRef.current === clusterId) return;

    const existing = findLatestClusterAgent(agents, clusterId);
    if (existing) {
      createdForRef.current = clusterId;
      openChat({ clusterId, agentId: existing.id, workspaceId: existing.workspaceId ?? null });
      return;
    }

    createdForRef.current = clusterId;
    void askAgentAboutResource({
      client,
      serverId,
      clusterId,
      kind: resource?.kind ?? "cluster",
      namespace: resource?.namespace,
      provider,
      cwd,
      onCreated: ({ id, workspaceId: ws }) => openChat({ clusterId, agentId: id, workspaceId: ws }),
    });
  }, [
    open,
    agentId,
    ready,
    client,
    provider,
    cwd,
    clusterId,
    resource,
    serverId,
    openChat,
    agents,
  ]);

  const isCompact = useIsCompactFormFactor();
  const { width: screenWidth } = useWindowDimensions();
  const target = isCompact ? screenWidth : width;

  const w = useSharedValue(open ? target : 0);
  const prevOpen = useRef(open);
  useEffect(() => {
    const toggled = prevOpen.current !== open;
    prevOpen.current = open;
    const to = open ? target : 0;
    w.value = toggled ? withTiming(to, { duration: 220 }) : to;
  }, [open, target, w]);
  const animStyle = useAnimatedStyle(() => ({ width: w.value }));

  const startWidthRef = useRef(width);
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          startWidthRef.current = width;
        })
        .onUpdate((event) => {
          const next = Math.max(
            CLUSTER_CHAT_MIN_WIDTH,
            Math.min(CLUSTER_CHAT_MAX_WIDTH, startWidthRef.current - event.translationX),
          );
          w.value = next;
          runOnJS(setWidth)(next);
        }),
    [width, setWidth, w],
  );

  const handleClose = useCallback(() => hideChat(), [hideChat]);
  const handleOpen = useCallback(() => showChat(), [showChat]);
  const innerStyle = useMemo(() => [styles.inner, { width: target }], [target]);

  const paneValue = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId: workspaceId ?? "",
      tabId: `cluster-chat-${agentId ?? "none"}`,
      target: { kind: "agent", agentId: agentId ?? "" },
      openTab: noop,
      closeCurrentTab: hideChat,
      retargetCurrentTab: noop,
      openFileInWorkspace: noop,
      openImportSheet: noop,
    }),
    [serverId, workspaceId, agentId, hideChat],
  );
  const focusValue = useMemo(
    () => createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true }),
    [],
  );

  let body;
  if (agentId) {
    body = (
      <PaneProvider value={paneValue}>
        <PaneFocusProvider value={focusValue}>
          <AgentConversationPanel />
        </PaneFocusProvider>
      </PaneProvider>
    );
  } else if (ready) {
    body = (
      <View style={styles.center}>
        <ThemedActivityIndicator uniProps={mutedColor} />
        <Text style={styles.centerText}>Starting chat…</Text>
      </View>
    );
  } else {
    body = (
      <View style={styles.center}>
        <Text style={styles.centerText}>Connect a host & add a project to chat with an agent</Text>
      </View>
    );
  }

  if (!open) {
    return (
      <Pressable style={styles.handle} onPress={handleOpen} accessibilityLabel="Open chat">
        <ThemedMessageSquare size={18} uniProps={mutedColor} />
      </Pressable>
    );
  }

  return (
    <Animated.View style={[styles.dock, animStyle]}>
      {isCompact ? null : (
        <SidebarResizeHandle edge="left" gesture={resizeGesture} testID="cluster-chat-resize" />
      )}
      <View style={innerStyle}>
        <View style={styles.header}>
          <ThemedMessageSquare size={15} uniProps={mutedColor} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {clusterName}
          </Text>
          <Pressable
            style={styles.closeBtn}
            onPress={handleClose}
            accessibilityLabel="Collapse chat"
            hitSlop={8}
          >
            <ThemedX size={16} uniProps={mutedColor} />
          </Pressable>
        </View>
        <View style={styles.body}>{body}</View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  handle: {
    width: 48,
    height: "100%",
    alignItems: "center",
    paddingTop: theme.spacing[3],
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  dock: {
    height: "100%",
    overflow: "hidden",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  inner: {
    flex: 1,
    minHeight: 0,
    height: "100%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  centerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
