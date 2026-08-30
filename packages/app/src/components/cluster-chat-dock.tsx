import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { Check, History, MessageSquare, Plus, X } from "lucide-react-native";
import { formatTimeAgo } from "@/utils/time";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  PaneProvider,
  PaneFocusProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { askAgentAboutResource } from "@/components/cluster-ask-agent";
import { ClusterDraftChat } from "@/components/cluster-draft-chat";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { resolveSkillInjectedText } from "@/skills/skill-injection";
import type { ClusterComposerResource } from "@/components/cluster-composer";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
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
const ThemedCheck = withUnistyles(Check);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
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
    text: resolveSkillInjectedText(agentId, message),
    attachments: [],
    encodeImages: async () => undefined,
    submission: createMessageSubmissionWriter(serverId),
  }).catch(() => {});
}

/** Create the cluster agent seeded with a queued "Ask AI" question (titles it). */
function createClusterAgent(params: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  serverId: string;
  clusterId: string;
  clusterName: string;
  ask: ClusterChatPendingAsk;
  resource?: ClusterComposerResource;
  provider: string;
  cwd: string;
  onOpen: (input: { clusterId: string; agentId: string; workspaceId: string | null }) => void;
}): void {
  const { client, serverId, clusterId, clusterName, ask, resource, provider, cwd, onOpen } = params;
  void askAgentAboutResource({
    client,
    serverId,
    clusterId,
    clusterName,
    kind: ask.kind ?? resource?.kind ?? "cluster",
    namespace: ask.namespace ?? resource?.namespace,
    name: ask.name,
    yaml: ask.yaml,
    logs: ask.logs,
    provider,
    cwd,
    message: ask.message,
    onCreated: ({ id, workspaceId: ws }) => onOpen({ clusterId, agentId: id, workspaceId: ws }),
  });
}

/** Display name for a project in the picker. */
function workspaceLabel(ws: WorkspaceDescriptor): string {
  return ws.projectCustomName || ws.projectDisplayName || ws.name || "Project";
}

/** One representative workspace per distinct project — the user picks a project,
 *  not each per-agent worktree (which all share the project directory). */
function distinctProjects(list: WorkspaceDescriptor[]): WorkspaceDescriptor[] {
  const seen = new Set<string>();
  const out: WorkspaceDescriptor[] = [];
  for (const ws of list) {
    const key = ws.projectId || ws.projectRootPath || ws.workspaceDirectory || ws.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ws);
  }
  return out;
}

/** A project the cluster chat can run in (agent cwd). */
interface ClusterChatProject {
  key: string;
  label: string;
  rootPath: string;
}

/** One selectable project row in the cluster chat history overlay. */
function ProjectItem({
  project,
  active,
  onSelect,
}: {
  project: ClusterChatProject;
  active: boolean;
  onSelect: (key: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(project.key), [onSelect, project.key]);
  return (
    <Pressable
      style={active ? [styles.historyItem, styles.historyItemActive] : styles.historyItem}
      onPress={handlePress}
    >
      <View style={styles.wsText}>
        <Text style={styles.historyTitle} numberOfLines={1}>
          {project.label}
        </Text>
        {project.rootPath ? (
          <Text style={styles.wsDir} numberOfLines={1}>
            {project.rootPath}
          </Text>
        ) : null}
      </View>
      {active ? <ThemedCheck size={16} uniProps={accentColor} /> : null}
    </Pressable>
  );
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
function ClusterChatBody({
  agentId,
  ready,
  paneValue,
  focusValue,
  entryComposer,
}: {
  agentId: string | null;
  ready: boolean;
  paneValue: PaneContextValue;
  focusValue: ReturnType<typeof createPaneFocusContextValue>;
  /** Shown before any agent exists: the user creates the agent by sending here. */
  entryComposer: ReactNode;
}) {
  if (agentId) {
    return (
      <PaneProvider value={paneValue}>
        <PaneFocusProvider value={focusValue}>
          <AgentConversationPanel />
        </PaneFocusProvider>
      </PaneProvider>
    );
  }
  if (ready) {
    // No agent yet — do NOT auto-create one. The user types a real question here
    // and only then is the agent created (titled from that message + cluster).
    return <View style={styles.entryBody}>{entryComposer}</View>;
  }
  return (
    <View style={styles.center}>
      <Text style={styles.centerText}>Connect a host & add a project to chat with an agent</Text>
    </View>
  );
}

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
  const startNewChat = useClusterChatStore((s) => s.startNewChat);
  const draft = useClusterChatStore((s) => s.draft);

  const client = useHostRuntimeClient(serverId);
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const projects = useSessionStore((state) => state.sessions[serverId]?.projects);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const provider = providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const pickedWorkspaceId = useClusterChatStore((s) => s.pickedWorkspaceId);
  const setPickedWorkspaceId = useClusterChatStore((s) => s.setPickedWorkspaceId);

  // A cluster chat runs an agent inside a project directory (its cwd). Build the
  // pickable project list from the flat workspaces map when present, but fall
  // back to session.projects — on the cluster route the workspaces map can be
  // empty while projects (what the sidebar shows) is populated, which previously
  // left New chat with no project, a null cwd, and a dead button.
  const projectOptions = useMemo<ClusterChatProject[]>(() => {
    const wsList = workspaces ? Array.from(workspaces.values()) : [];
    const fromWs = distinctProjects(wsList)
      .map((w) => ({
        key: w.projectId || w.projectRootPath || w.workspaceDirectory || w.id,
        label: workspaceLabel(w),
        rootPath: w.workspaceDirectory || w.projectRootPath || "",
      }))
      .filter((p) => p.rootPath);
    if (fromWs.length > 0) return fromWs;
    const projList = projects ? Array.from(projects.values()) : [];
    return projList
      .map((p) => ({
        key: p.projectId,
        label: p.projectCustomName || p.projectDisplayName || p.projectRootPath,
        rootPath: p.projectRootPath,
      }))
      .filter((p) => p.rootPath);
  }, [workspaces, projects]);
  const chosenProject = useMemo(() => {
    const picked = pickedWorkspaceId
      ? projectOptions.find((p) => p.key === pickedWorkspaceId)
      : undefined;
    return picked ?? projectOptions[0] ?? null;
  }, [pickedWorkspaceId, projectOptions]);
  const cwd = chosenProject?.rootPath || null;
  const chosenProjectKey = chosenProject?.key;
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

  // NEVER auto-create a blank agent just because the dock is visible — that was
  // the bug that spawned anonymous "Cluster chat" duplicates, one per opened
  // workloads view. Instead:
  //   • a queued "Ask AI" question is a real chat action → reuse or create+seed;
  //   • opening the dock reopens the cluster's most recent conversation (no
  //     creation), so continuity is kept;
  //   • otherwise leave agentId null → the entry composer is shown and the agent
  //     is created only when the user actually sends a message.
  const pendingAsk = useClusterChatStore((s) => s.pendingAsk);
  const clearPendingAsk = useClusterChatStore((s) => s.clearPendingAsk);
  const createdForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || agentId || !ready || !client || !provider || !cwd) return;

    const ask = pendingAsk;
    if (ask) {
      clearPendingAsk();
      createdForRef.current = clusterId;
      const existing = findLatestClusterAgent(agents, clusterId);
      if (existing) {
        openChat({ clusterId, agentId: existing.id, workspaceId: existing.workspaceId ?? null });
        deliverPendingAsk(client, serverId, existing.id, ask.message);
      } else {
        createClusterAgent({
          client,
          serverId,
          clusterId,
          clusterName,
          ask,
          resource,
          provider,
          cwd,
          onOpen: openChat,
        });
      }
      return;
    }

    // The user explicitly asked for a fresh chat: show the entry composer and
    // create nothing until they send.
    if (draft) return;

    // First reveal of this cluster's dock: reopen the last conversation if any.
    if (createdForRef.current === clusterId) return;
    createdForRef.current = clusterId;
    const existing = findLatestClusterAgent(agents, clusterId);
    if (existing) {
      openChat({ clusterId, agentId: existing.id, workspaceId: existing.workspaceId ?? null });
    }
    // else: no prior chat → leave agentId null; the entry composer handles creation.
  }, [
    open,
    agentId,
    ready,
    client,
    provider,
    cwd,
    clusterId,
    clusterName,
    resource,
    serverId,
    openChat,
    agents,
    pendingAsk,
    clearPendingAsk,
    draft,
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
  const handleSelectWorkspace = useCallback(
    (id: string) => setPickedWorkspaceId(id),
    [setPickedWorkspaceId],
  );
  const handleNewChat = useCallback(() => {
    if (!client || !provider || !cwd) {
      // Never a silent no-op: open the panel so the user can pick a project (or
      // see why a chat can't start) instead of clicking into nothing.
      setHistoryOpen(true);
      return;
    }
    setHistoryOpen(false);
    // Show the entry composer for a blank chat; the agent is created only when the
    // user sends a message (titled from it). createdForRef stops the open-effect
    // from immediately reopening the last conversation instead.
    createdForRef.current = clusterId;
    startNewChat();
  }, [client, provider, cwd, clusterId, startNewChat]);

  // The pre-agent composer: the FULL agent composer with no agent created yet.
  // Sending here creates the cluster agent (seeded with the cluster system prompt
  // + labels, titled from the message + cluster) and opens it. Shared desktop +
  // mobile. `cwd` is only truthy when `ready`, which is when this is rendered.
  const entryComposer = useMemo(
    () =>
      cwd ? (
        <ClusterDraftChat
          serverId={serverId}
          clusterId={clusterId}
          clusterName={clusterName}
          resource={resource}
          cwd={cwd}
          isPaneFocused={open}
          onCreated={openChat}
        />
      ) : null,
    [serverId, clusterId, clusterName, resource, cwd, open, openChat],
  );

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
            style={styles.closeBtn}
            onPress={handleNewChat}
            accessibilityLabel="New chat"
            hitSlop={8}
          >
            <ThemedPlus size={16} uniProps={mutedColor} />
          </Pressable>
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
          <ClusterChatBody
            agentId={agentId}
            ready={ready}
            paneValue={paneValue}
            focusValue={focusValue}
            entryComposer={entryComposer}
          />
          {historyOpen ? (
            <View style={styles.historyOverlay}>
              <ScrollView>
                {projectOptions.length >= 1 ? (
                  <>
                    <Text style={styles.historySectionLabel}>PROJECT FOR NEW CHATS</Text>
                    {projectOptions.map((p) => (
                      <ProjectItem
                        key={p.key}
                        project={p}
                        active={p.key === chosenProjectKey}
                        onSelect={handleSelectWorkspace}
                      />
                    ))}
                    <Text style={styles.historySectionLabel}>CHATS</Text>
                  </>
                ) : (
                  <Text style={styles.historyEmpty}>
                    Add a project (sidebar → Add project) to chat about this cluster.
                  </Text>
                )}
                {!provider ? (
                  <Text style={styles.historyEmpty}>
                    Enable an AI provider in Host settings to start a chat.
                  </Text>
                ) : null}
                <Pressable style={styles.historyNew} onPress={handleNewChat}>
                  <ThemedPlus size={16} uniProps={mutedColor} />
                  <Text style={styles.historyNewText}>New chat</Text>
                </Pressable>
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
  entryBody: {
    flex: 1,
    justifyContent: "flex-end",
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
  historySectionLabel: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
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
  wsText: {
    flex: 1,
    minWidth: 0,
  },
  wsDir: {
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
