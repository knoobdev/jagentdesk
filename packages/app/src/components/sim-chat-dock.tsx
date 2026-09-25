import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackHandler, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
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
import { SimDraftChat, SIM_AGENT_LABEL } from "@/components/sim-draft-chat";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSimChatStore, SIM_CHAT_MIN_WIDTH, SIM_CHAT_MAX_WIDTH } from "@/stores/sim-chat-store";
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

/** Most recently active, non-archived agent created for this host's fleet. */
function findLatestSimAgent(
  agents: Map<string, Agent> | undefined,
  serverId: string,
): Agent | null {
  if (!agents) return null;
  let latest: Agent | null = null;
  for (const agent of agents.values()) {
    if (agent.archivedAt) continue;
    if (agent.labels?.[SIM_AGENT_LABEL] !== serverId) continue;
    if (!latest || agent.lastActivityAt > latest.lastActivityAt) latest = agent;
  }
  return latest;
}

/** All non-archived fleet agents for this host, most-recently-active first. */
function listSimAgents(agents: Map<string, Agent> | undefined, serverId: string): Agent[] {
  if (!agents) return [];
  const out: Agent[] = [];
  for (const agent of agents.values()) {
    if (agent.archivedAt) continue;
    if (agent.labels?.[SIM_AGENT_LABEL] !== serverId) continue;
    out.push(agent);
  }
  return out.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

function workspaceLabel(ws: WorkspaceDescriptor): string {
  return ws.projectCustomName || ws.projectDisplayName || ws.name || "Project";
}

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

interface SimChatProject {
  key: string;
  label: string;
  rootPath: string;
}

function ProjectItem({
  project,
  active,
  onSelect,
}: {
  project: SimChatProject;
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
 * What the chat still needs before it can run, worded to name only what is
 * actually missing — never nag about enabling a provider when one already is.
 */
function disabledChatHint(hasProvider: boolean, hasProject: boolean): string {
  if (!hasProject && !hasProvider) {
    return "open a project (sidebar → Add project) and turn on an AI provider in Host settings.";
  }
  if (!hasProject) {
    return "open a project (sidebar → Add project) — the agent runs inside a project's workspace.";
  }
  return "turn on an AI provider in Host settings.";
}

/** Renders the created agent's conversation, or the entry composer before one exists. */
function SimChatBody({
  agentId,
  ready,
  hasProvider,
  hasProject,
  paneValue,
  focusValue,
  entryComposer,
}: {
  agentId: string | null;
  ready: boolean;
  hasProvider: boolean;
  hasProject: boolean;
  paneValue: PaneContextValue;
  focusValue: ReturnType<typeof createPaneFocusContextValue>;
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
    return <View style={styles.entryBody}>{entryComposer}</View>;
  }
  return (
    <View style={styles.center}>
      <Text style={styles.centerTitle}>Drive your simulators with an agent</Text>
      <Text style={styles.centerText}>
        The chat runs an agent with the simulator tools. To enable it,{" "}
        {disabledChatHint(hasProvider, hasProject)}
      </Text>
    </View>
  );
}

/**
 * The chat surface for the SimFleet screen — a right sidebar, open by default on desktop. The
 * composer is the REAL agent composer; the fleet agent is created only when the user sends a
 * message (seeded with the fleet system prompt + label, titled from that message). Mirrors
 * DatabaseChatDock.
 */
// eslint-disable-next-line complexity
export function SimChatDock({
  serverId,
  devices,
  selected,
}: {
  serverId: string;
  devices: readonly SimDevice[];
  selected: SimDevice | null;
}) {
  const open = useSimChatStore((s) => s.open);
  const agentId = useSimChatStore((s) => s.agentId);
  const workspaceId = useSimChatStore((s) => s.workspaceId);
  const width = useSimChatStore((s) => s.width);
  const hideChat = useSimChatStore((s) => s.hideChat);
  const showChat = useSimChatStore((s) => s.showChat);
  const setWidth = useSimChatStore((s) => s.setWidth);
  const openChat = useSimChatStore((s) => s.openChat);
  const startNewChat = useSimChatStore((s) => s.startNewChat);
  const draft = useSimChatStore((s) => s.draft);

  const client = useHostRuntimeClient(serverId);
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const projects = useSessionStore((state) => state.sessions[serverId]?.projects);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const provider = providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const pickedWorkspaceId = useSimChatStore((s) => s.pickedWorkspaceId);
  const setPickedWorkspaceId = useSimChatStore((s) => s.setPickedWorkspaceId);

  const projectOptions = useMemo<SimChatProject[]>(() => {
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

  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const timelineSourceId = `sim-chat:${serverId}`;
  useEffect(() => {
    if (!viewedTimelineSync) return;
    const visible = open && agentId ? [agentId] : [];
    viewedTimelineSync.replaceVisibleAgentIds(timelineSourceId, visible);
    return () => viewedTimelineSync.replaceVisibleAgentIds(timelineSourceId, []);
  }, [viewedTimelineSync, timelineSourceId, open, agentId]);

  // NEVER auto-create a blank agent just because the dock is visible. Opening the
  // dock reopens the fleet's most recent conversation; otherwise leave agentId
  // null so the entry composer creates the agent on the first real message.
  const createdForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || agentId || !ready || !client || !provider || !cwd) return;
    if (draft) return;
    if (createdForRef.current === serverId) return;
    createdForRef.current = serverId;
    const existing = findLatestSimAgent(agents, serverId);
    if (existing) {
      openChat({ serverId, agentId: existing.id, workspaceId: existing.workspaceId ?? null });
    }
  }, [open, agentId, ready, client, provider, cwd, serverId, openChat, agents, draft]);

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
            SIM_CHAT_MIN_WIDTH,
            Math.min(SIM_CHAT_MAX_WIDTH, startWidthRef.current - event.translationX),
          );
          w.value = next;
          runOnJS(setWidth)(next);
        }),
    [width, setWidth, w],
  );

  const handleClose = useCallback(() => hideChat(), [hideChat]);
  const handleOpen = useCallback(() => showChat(), [showChat]);

  // On phones the chat fills the screen. Android hardware/gesture back would
  // otherwise leave the SimFleet screen; while the
  // chat is open, consume back to just close the overlay, leaving the user on
  // the fleet they came from.
  useEffect(() => {
    if (!open || !isCompact) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      hideChat();
      return true;
    });
    return () => handler.remove();
  }, [open, isCompact, hideChat]);

  const innerStyle = useMemo(() => [styles.inner, { width: target }], [target]);

  const simAgents = useMemo(() => listSimAgents(agents, serverId), [agents, serverId]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const handleToggleHistory = useCallback(() => setHistoryOpen((v) => !v), []);
  const handleSelectAgent = useCallback(
    (a: Agent) => {
      createdForRef.current = serverId;
      openChat({ serverId, agentId: a.id, workspaceId: a.workspaceId ?? null });
      setHistoryOpen(false);
    },
    [serverId, openChat],
  );
  const handleSelectWorkspace = useCallback(
    (id: string) => setPickedWorkspaceId(id),
    [setPickedWorkspaceId],
  );
  const handleNewChat = useCallback(() => {
    if (!client || !provider || !cwd) {
      setHistoryOpen(true);
      return;
    }
    setHistoryOpen(false);
    createdForRef.current = serverId;
    startNewChat();
  }, [client, provider, cwd, serverId, startNewChat]);

  const entryComposer = useMemo(
    () =>
      cwd ? (
        <SimDraftChat
          serverId={serverId}
          devices={devices}
          selected={selected}
          cwd={cwd}
          isPaneFocused={open}
          onCreated={openChat}
        />
      ) : null,
    [serverId, devices, selected, cwd, open, openChat],
  );

  const paneValue = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId: workspaceId ?? "",
      tabId: `sim-chat-${agentId ?? "none"}`,
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

  // Closed. On desktop the dock is toggled from the SimFleet header's "Agent"
  // button, so render nothing. On phones the fleet fills the screen and there's no persistent
  // toolbar beside it, so surface a floating button that opens the full-width
  // chat panel — otherwise the agent is unreachable on mobile. Mirrors
  // ClusterChatDock's compact FAB.
  if (!open) {
    if (isCompact) {
      return (
        <Pressable
          style={styles.fab}
          onPress={handleOpen}
          accessibilityLabel="Ask AI"
          testID="sim-chat-fab"
        >
          <ThemedMessageSquare size={22} uniProps={fabIconColor} />
        </Pressable>
      );
    }
    return null;
  }

  return (
    <Animated.View style={[styles.dock, animStyle]}>
      {isCompact ? null : (
        <SidebarResizeHandle edge="left" gesture={resizeGesture} testID="sim-chat-resize" />
      )}
      <View style={innerStyle}>
        <View style={styles.header}>
          <ThemedMessageSquare size={15} uniProps={mutedColor} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            Simulator agent
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
          <SimChatBody
            agentId={agentId}
            ready={ready}
            hasProvider={Boolean(provider)}
            hasProject={Boolean(cwd)}
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
                    Add a project (sidebar → Add project) to chat with the simulator agent.
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
                {simAgents.length === 0 ? (
                  <Text style={styles.historyEmpty}>No previous simulator chats.</Text>
                ) : (
                  simAgents.map((a) => (
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
  centerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
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
