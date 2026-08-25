import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { History, MessageSquare, Plus, X } from "lucide-react-native";
import { formatTimeAgo } from "@/utils/time";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  PaneProvider,
  PaneFocusProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { askAgentAboutResource } from "@/components/cluster-ask-agent";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
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
  type ClusterChatPendingAsk,
} from "@/stores/cluster-chat-store";
import type { Theme } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedHistory = withUnistyles(History);
const ThemedPlus = withUnistyles(Plus);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const fabIconColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
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

/** All non-archived agents for this cluster, most-recently-active first. */
function listClusterAgents(agents: Map<string, Agent> | undefined, clusterId: string): Agent[] {
  if (!agents) return [];
  const out: Agent[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt) continue;
    if (agent.labels?.[CLUSTER_AGENT_LABEL] !== clusterId) continue;
    out.push(agent);
  }
  return out.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

/** Send a queued Ask AI question to an already-existing cluster agent. */
function deliverPendingAsk(
  client: ReturnType<typeof useHostRuntimeClient>,
  serverId: string,
  agentId: string,
  message: string,
): void {
  if (!client) return;
  void dispatchComposerAgentMessage({
    client,
    agentId,
    text: message,
    attachments: [],
    encodeImages: async () => undefined,
    submission: createMessageSubmissionWriter(serverId),
  }).catch(() => {});
}

/** A distinct default title for an empty cluster chat (the daemon never auto-titles). */
function nextChatTitle(existingCount: number): string {
  return existingCount <= 0 ? "Cluster chat" : `Cluster chat ${existingCount + 1}`;
}

/** Spin up the single cluster agent, baking in any queued Ask AI context. */
function createClusterAgent(params: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  serverId: string;
  clusterId: string;
  ask: ClusterChatPendingAsk | null;
  resource?: ClusterComposerResource;
  provider: string;
  cwd: string;
  /** Explicit title for an empty chat; omit when a message will seed the title. */
  title?: string;
  onOpen: (input: { clusterId: string; agentId: string; workspaceId: string | null }) => void;
}): void {
  const { client, serverId, clusterId, ask, resource, provider, cwd, title, onOpen } = params;
  void askAgentAboutResource({
    client,
    serverId,
    clusterId,
    kind: ask?.kind ?? resource?.kind ?? "cluster",
    namespace: ask?.namespace ?? resource?.namespace,
    name: ask?.name,
    yaml: ask?.yaml,
    logs: ask?.logs,
    provider,
    cwd,
    message: ask?.message,
    // A message seeds the title from its first line; only title the empty ones.
    ...(ask?.message ? {} : { title }),
    onCreated: ({ id, workspaceId: ws }) => onOpen({ clusterId, agentId: id, workspaceId: ws }),
  });
}

/** One row in the cluster chat history overlay. */
function HistoryItem({
  agent,
  active,
  onSelect,
}: {
  agent: Agent;
  active: boolean;
  onSelect: (a: Agent) => void;
}) {
  const handlePress = useCallback(() => onSelect(agent), [onSelect, agent]);
  return (
    <Pressable
      style={active ? [styles.historyItem, styles.historyItemActive] : styles.historyItem}
      onPress={handlePress}
    >
      <Text style={styles.historyTitle} numberOfLines={1}>
        {agent.title || "Untitled chat"}
      </Text>
      <Text style={styles.historyTime}>{formatTimeAgo(agent.lastActivityAt)}</Text>
    </Pressable>
  );
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

  // Register the dock's agent as "visible" so the session subscribes to its
  // timeline and applies the authoritative history. Without this the panel only
  // shows the optimistic user bubble — the agent's replies (which the daemon DOES
  // produce) never sync, because only the workspace screen registered visibility.
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const timelineSourceId = `cluster-chat:${serverId}`;
  useEffect(() => {
    if (!viewedTimelineSync) return;
    const visible = open && agentId ? [agentId] : [];
    viewedTimelineSync.replaceVisibleAgentIds(timelineSourceId, visible);
    return () => viewedTimelineSync.replaceVisibleAgentIds(timelineSourceId, []);
  }, [viewedTimelineSync, timelineSourceId, open, agentId]);

  // Open ONE agent per cluster: reuse the existing one if the user already chatted
  // with this cluster (so their conversation + the model's response are still
  // there), and only create a fresh agent when none exists. Previously the dock
  // created a brand-new agent every time the workloads view mounted, which spawned
  // duplicate "main" agents and could show an empty agent instead of the one that
  // actually replied.
  const pendingAsk = useClusterChatStore((s) => s.pendingAsk);
  const clearPendingAsk = useClusterChatStore((s) => s.clearPendingAsk);
  const createdForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || agentId || !ready || !client || !provider || !cwd) return;
    // The createdForRef guard stops re-creation on re-renders, but a queued Ask AI
    // question must still be delivered even if we already created this cluster's
    // agent, so only short-circuit when there is nothing pending.
    if (createdForRef.current === clusterId && !pendingAsk) return;

    createdForRef.current = clusterId;
    const ask = pendingAsk;
    if (ask) clearPendingAsk();

    const existing = findLatestClusterAgent(agents, clusterId);
    if (existing) {
      openChat({ clusterId, agentId: existing.id, workspaceId: existing.workspaceId ?? null });
      if (ask) deliverPendingAsk(client, serverId, existing.id, ask.message);
      return;
    }

    // One agent per cluster, no race: bake the pending resource context into it.
    // This branch only runs when none exists yet, so it is the cluster's first chat.
    createClusterAgent({
      client,
      serverId,
      clusterId,
      ask,
      resource,
      provider,
      cwd,
      title: nextChatTitle(0),
      onOpen: openChat,
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
    pendingAsk,
    clearPendingAsk,
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

  // History: every non-archived agent for this cluster, so the user can switch
  // back to a past conversation or start a fresh one instead of being stuck with
  // the single reused agent.
  const clusterAgents = useMemo(() => listClusterAgents(agents, clusterId), [agents, clusterId]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const handleToggleHistory = useCallback(() => setHistoryOpen((v) => !v), []);
  const handleSelectAgent = useCallback(
    (a: Agent) => {
      createdForRef.current = clusterId;
      openChat({ clusterId, agentId: a.id, workspaceId: a.workspaceId ?? null });
      setHistoryOpen(false);
    },
    [clusterId, openChat],
  );
  const handleNewChat = useCallback(() => {
    setHistoryOpen(false);
    if (!client || !provider || !cwd) return;
    createdForRef.current = clusterId;
    createClusterAgent({
      client,
      serverId,
      clusterId,
      ask: null,
      resource,
      provider,
      cwd,
      title: nextChatTitle(clusterAgents.length),
      onOpen: openChat,
    });
  }, [client, provider, cwd, clusterId, serverId, resource, openChat, clusterAgents.length]);

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
    // On phones the closed dock is a floating action button that does NOT take
    // layout width, so the resource table (search box, namespace, AGE) gets the
    // full screen instead of being clipped by a 48px handle strip. On desktop it
    // stays a slim edge handle.
    if (isCompact) {
      return (
        <Pressable style={styles.fab} onPress={handleOpen} accessibilityLabel="Open chat">
          <ThemedMessageSquare size={22} uniProps={fabIconColor} />
        </Pressable>
      );
    }
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
            style={historyOpen ? [styles.closeBtn, styles.headerBtnActive] : styles.closeBtn}
            onPress={handleToggleHistory}
            accessibilityLabel="Chat history"
            hitSlop={8}
          >
            <ThemedHistory size={16} uniProps={mutedColor} />
          </Pressable>
          <Pressable
            style={styles.closeBtn}
            onPress={handleClose}
            accessibilityLabel="Collapse chat"
            hitSlop={8}
          >
            <ThemedX size={16} uniProps={mutedColor} />
          </Pressable>
        </View>
        <View style={styles.body}>
          {body}
          {historyOpen ? (
            <View style={styles.historyOverlay}>
              <Pressable style={styles.historyNew} onPress={handleNewChat}>
                <ThemedPlus size={16} uniProps={mutedColor} />
                <Text style={styles.historyNewText}>New chat</Text>
              </Pressable>
              <ScrollView>
                {clusterAgents.length === 0 ? (
                  <Text style={styles.historyEmpty}>No previous chats for this cluster.</Text>
                ) : (
                  clusterAgents.map((a) => (
                    <HistoryItem
                      key={a.id}
                      agent={a}
                      active={a.id === agentId}
                      onSelect={handleSelectAgent}
                    />
                  ))
                )}
              </ScrollView>
            </View>
          ) : null}
        </View>
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
  fab: {
    position: "absolute",
    right: theme.spacing[4],
    bottom: theme.spacing[6],
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    zIndex: 20,
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
  headerBtnActive: {
    backgroundColor: theme.colors.surface2,
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
  historyOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface0,
  },
  historyNew: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  historyNewText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  historyItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  historyItemActive: {
    backgroundColor: theme.colors.surface1,
  },
  historyTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  historyTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  historyEmpty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    padding: theme.spacing[4],
  },
}));
