import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowLeft, MessageSquare, Plus, X } from "lucide-react-native";
import type { ForgeRepo, ForgeRepoRef } from "@jagentdesk/protocol/messages";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  PaneProvider,
  PaneFocusProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { ForgeAssistantDraft, FORGE_ASSISTANT_LABEL } from "@/components/forge-assistant-draft";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedPlus = withUnistyles(Plus);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const noop = () => {};

/** Most recently active, non-archived Forge assistant agent for this host. */
function findLatestForgeAgent(agents: Map<string, Agent> | undefined): Agent | null {
  if (!agents) return null;
  let latest: Agent | null = null;
  for (const agent of agents.values()) {
    if (agent.archivedAt) continue;
    if (agent.labels?.[FORGE_ASSISTANT_LABEL] !== "true") continue;
    if (!latest || agent.lastActivityAt > latest.lastActivityAt) latest = agent;
  }
  return latest;
}

/** First available real working directory on the daemon host, or null. The
 *  assistant agent runs inside a project's workspace like any other agent. */
function resolveForgeAgentCwd(
  workspaces: Map<string, { workspaceDirectory: string; projectRootPath: string }> | undefined,
  projects: Map<string, { projectRootPath: string }> | undefined,
): string | null {
  if (workspaces) {
    for (const ws of workspaces.values()) {
      const dir = ws.workspaceDirectory || ws.projectRootPath;
      if (dir) return dir;
    }
  }
  if (projects) {
    for (const project of projects.values()) {
      if (project.projectRootPath) return project.projectRootPath;
    }
  }
  return null;
}

/**
 * What the assistant still needs before it can run, worded to name only what is
 * actually missing.
 */
function disabledAssistantHint(hasProvider: boolean, hasCwd: boolean): string {
  if (!hasProvider && !hasCwd) {
    return "Open a project (sidebar → Add project) and turn on an AI provider in Host settings.";
  }
  if (!hasProvider) {
    return "Turn on an AI provider in Host settings.";
  }
  return "Open a project (sidebar → Add project) — the assistant runs inside a project's workspace.";
}

/** Renders the created assistant conversation, or the entry composer before one exists. */
function ForgeAssistantBody({
  agentId,
  ready,
  hasProvider,
  hasCwd,
  paneValue,
  focusValue,
  entryComposer,
}: {
  agentId: string | null;
  ready: boolean;
  hasProvider: boolean;
  hasCwd: boolean;
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
      <Text style={styles.centerTitle}>Ask the Forge assistant</Text>
      <Text style={styles.centerText}>{disabledAssistantHint(hasProvider, hasCwd)}</Text>
    </View>
  );
}

/**
 * The embedded Forge assistant chat. A single dedicated agent per host, reused
 * across opens (identified by the FORGE_ASSISTANT_LABEL label). The composer is
 * the REAL agent composer; the agent is created only when the user sends a
 * message — seeded with the Forge system prompt + label, and the selected repo
 * baked into the prompt at creation. Rendered as a right-side dock on desktop
 * and full-screen on compact by the caller (forge-hub-screen).
 */
export function ForgeAssistantPanel({
  serverId,
  repo,
  isCompact,
  onClose,
}: {
  serverId: string;
  repo: ForgeRepo | null;
  isCompact: boolean;
  onClose: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const projects = useSessionStore((state) => state.sessions[serverId]?.projects);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);

  const provider = providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const cwd = useMemo(() => resolveForgeAgentCwd(workspaces, projects), [workspaces, projects]);
  const ready = Boolean(client && provider && cwd);

  const [agentId, setAgentId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const repoRef = useMemo<ForgeRepoRef | null>(
    () => (repo ? { forge: repo.forge, owner: repo.owner, name: repo.name } : null),
    [repo?.forge, repo?.owner, repo?.name],
  );

  const handleCreated = useCallback((input: { agentId: string; workspaceId: string | null }) => {
    setAgentId(input.agentId);
    setWorkspaceId(input.workspaceId);
  }, []);

  const handleNewChat = useCallback(() => {
    setAgentId(null);
    setWorkspaceId(null);
  }, []);

  // Reopen the most recent assistant conversation for this host once ready, so
  // opening the panel reuses the existing agent instead of showing a blank
  // composer. Never auto-create a blank agent just because the panel is open.
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (agentId || !ready) return;
    if (reopenedRef.current) return;
    reopenedRef.current = true;
    const existing = findLatestForgeAgent(agents);
    if (existing) {
      setAgentId(existing.id);
      setWorkspaceId(existing.workspaceId ?? null);
    }
  }, [agentId, ready, agents]);

  // Keep the viewed-timeline sync aware of the assistant thread so its history
  // hydrates while the panel is visible (mirrors DatabaseChatDock).
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const timelineSourceId = `forge-assistant:${serverId}`;
  useEffect(() => {
    if (!viewedTimelineSync) return;
    const visible = agentId ? [agentId] : [];
    viewedTimelineSync.replaceVisibleAgentIds(timelineSourceId, visible);
    return () => viewedTimelineSync.replaceVisibleAgentIds(timelineSourceId, []);
  }, [viewedTimelineSync, timelineSourceId, agentId]);

  const entryComposer = useMemo(
    () =>
      cwd ? (
        <ForgeAssistantDraft
          serverId={serverId}
          repo={repoRef}
          cwd={cwd}
          isPaneFocused
          onCreated={handleCreated}
        />
      ) : null,
    [serverId, repoRef, cwd, handleCreated],
  );

  const paneValue = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId: workspaceId ?? "",
      tabId: `forge-assistant-${agentId ?? "none"}`,
      target: { kind: "agent", agentId: agentId ?? "" },
      openTab: noop,
      closeCurrentTab: onClose,
      retargetCurrentTab: noop,
      openFileInWorkspace: noop,
      openImportSheet: noop,
    }),
    [serverId, workspaceId, agentId, onClose],
  );
  const focusValue = useMemo(
    () => createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true }),
    [],
  );

  const subtitle = repo ? `${repo.owner}/${repo.name}` : "All repositories";

  return (
    <View style={styles.container} testID="forge-assistant-panel">
      <View style={styles.header}>
        {isCompact ? (
          <Pressable
            style={styles.headerBtn}
            onPress={onClose}
            accessibilityLabel="Back"
            hitSlop={8}
            testID="forge-assistant-back"
          >
            <ThemedArrowLeft size={18} uniProps={mutedColor} />
          </Pressable>
        ) : (
          <ThemedMessageSquare size={15} uniProps={mutedColor} />
        )}
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Forge assistant
          </Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Pressable
          style={styles.headerBtn}
          onPress={handleNewChat}
          accessibilityLabel="New chat"
          hitSlop={8}
          testID="forge-assistant-new"
        >
          <ThemedPlus size={16} uniProps={mutedColor} />
        </Pressable>
        {isCompact ? null : (
          <Pressable
            style={styles.headerBtn}
            onPress={onClose}
            accessibilityLabel="Close assistant"
            hitSlop={8}
            testID="forge-assistant-close"
          >
            <ThemedX size={16} uniProps={mutedColor} />
          </Pressable>
        )}
      </View>
      <View style={styles.body}>
        <ForgeAssistantBody
          agentId={agentId}
          ready={ready}
          hasProvider={Boolean(provider)}
          hasCwd={Boolean(cwd)}
          paneValue={paneValue}
          focusValue={focusValue}
          entryComposer={entryComposer}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
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
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  headerSubtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  headerBtn: {
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
}));
