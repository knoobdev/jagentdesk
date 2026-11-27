import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { BOT_ID_LABEL, BOT_ROLE_LABEL } from "@/bots/envelope";
import { openBot } from "@/bots/navigation";
import { MIN_EXPLORER_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import {
  ORCHESTRATION_ROLE_LABEL,
  ORCHESTRATION_ROUTE_LABEL,
} from "@jagentdesk/protocol/orchestration";
import {
  buildWorkspaceAgentsRoster,
  type WorkspaceAgentsRosterEntry,
} from "./workspace-agents-roster";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function roleLabel(role: string | undefined, route: string | undefined): string {
  if (role === "supervisor") return "Supervisor";
  if (role === "lead") return "Lead";
  if (role === "peer") return route ? `Peer · ${route}` : "Peer";
  return role ?? "Peer";
}

interface OrchestrationAgentsColumnProps {
  serverId: string;
  workspaceId: string;
  /** Full-width, height-capped layout for the mobile workspace (vs the desktop dock column). */
  compact?: boolean;
}

/**
 * Number of orchestration-role agents (Supervisor/Lead/Peer) in a workspace. The
 * workspace screen uses this to decide whether to mount the Agents column, so the
 * middle column only appears once a run exists.
 */
export function useWorkspaceOrchestrationRosterCount(
  serverId: string,
  workspaceId: string,
): number {
  const sessionAgents = useSessionStore((state) => state.sessions[serverId]?.agents);
  return useMemo(
    () =>
      sessionAgents
        ? Array.from(sessionAgents.values()).filter(
            (agent) => agent.workspaceId === workspaceId && agent.labels[ORCHESTRATION_ROLE_LABEL],
          ).length
        : 0,
    [sessionAgents, workspaceId],
  );
}

/**
 * Middle column of the orchestration workspace (Workspaces | Agents | Supervisor
 * chat). Observability-only: it lists the run's roles (role · status ·
 * provider/model) and the Lead plan, and opening a role focuses its thread in the
 * center. Sending goes through the normal composer (`/orc …` or chatting with the
 * Supervisor). Renders nothing when the workspace has no orchestration run, so
 * ordinary workspaces are unaffected.
 */
export function OrchestrationAgentsColumn({
  serverId,
  workspaceId,
  compact = false,
}: OrchestrationAgentsColumnProps) {
  const roster = useWorkspaceAgentsRoster(serverId, workspaceId);

  if (roster.length === 0) {
    return null;
  }

  return (
    <View
      style={[styles.column, compact && styles.columnCompact]}
      testID="workspace-orchestration-agents-column"
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>WORKSPACE AGENTS</Text>
        <Text style={styles.headerSubtitle}>Human → Supervisor → Lead → Peer</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <WorkspaceAgentsList serverId={serverId} workspaceId={workspaceId} roster={roster} />
      </ScrollView>
    </View>
  );
}

/** The workspace's ORC roster, with the bot chat that started its Lead (`workspace-agents-roster.ts`). */
export function useWorkspaceAgentsRoster(
  serverId: string,
  workspaceId: string,
): WorkspaceAgentsRosterEntry[] {
  const sessionAgents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const agentDetails = useSessionStore((state) => state.sessions[serverId]?.agentDetails);
  return useMemo(
    () =>
      sessionAgents
        ? buildWorkspaceAgentsRoster({
            agents: sessionAgents.values(),
            workspaceId,
            lookup: (agentId) => sessionAgents.get(agentId) ?? agentDetails?.get(agentId),
          })
        : [],
    [agentDetails, sessionAgents, workspaceId],
  );
}

/** The roster rows, shared by the desktop column and the phone's Workspace agents sheet. */
export function WorkspaceAgentsList({
  serverId,
  workspaceId,
  roster,
  onOpen,
}: {
  serverId: string;
  workspaceId: string;
  roster: readonly WorkspaceAgentsRosterEntry[];
  /** Runs before the row's chat opens, e.g. to close the sheet holding the list. */
  onOpen?: () => void;
}) {
  return (
    <>
      {roster.map((entry) => (
        <OrchestrationAgentRow
          key={entry.agent.id}
          serverId={serverId}
          workspaceId={workspaceId}
          entry={entry}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

interface OrchestrationAgentRowProps {
  serverId: string;
  workspaceId: string;
  entry: WorkspaceAgentsRosterEntry;
  onOpen?: () => void;
}

function OrchestrationAgentRow({
  serverId,
  workspaceId,
  entry,
  onOpen,
}: OrchestrationAgentRowProps) {
  const { agent, role, external } = entry;
  const route = agent.labels[ORCHESTRATION_ROUTE_LABEL];
  const openThread = useCallback(() => {
    onOpen?.();
    const botId = agent.labels[BOT_ID_LABEL];
    // A bot's Home Chat opens on the bot's page, as its row in the Bots section does.
    if (external && botId && agent.labels[BOT_ROLE_LABEL] === "home") openBot(serverId, botId);
    // Any other chat that started the worker opens where it lives.
    else if (external) navigateToAgent({ serverId, agentId: agent.id });
    // Reveal the role's tab in the mounted workspace; pushing a route would stack another copy.
    else navigateToAgent({ serverId, agentId: agent.id, workspaceId, pin: true });
  }, [agent.id, agent.labels, external, onOpen, serverId, workspaceId]);
  const label =
    external && agent.title ? `${roleLabel(role, route)} · ${agent.title}` : roleLabel(role, route);
  return (
    <Pressable
      style={styles.agentRow}
      onPress={openThread}
      accessibilityRole="button"
      testID={external ? "orchestration-agent-row-supervisor" : "orchestration-agent-row"}
    >
      <View
        style={[
          styles.statusDot,
          agent.status === "running" ? styles.statusDotActive : styles.statusDotIdle,
        ]}
      />
      <View style={styles.agentRowText}>
        <Text style={styles.agentRole} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.agentMeta} numberOfLines={1}>
          {agent.provider}/{agent.model ?? "default"} · {agent.status}
        </Text>
      </View>
    </Pressable>
  );
}

interface OrchestrationLeadPlanCardProps {
  serverId: string;
  workspaceId: string;
}

/**
 * "Lead plan · N bounded assignments" card. Rendered inside the Supervisor chat
 * (above the composer) so the human sees, in the thread they steer, which bounded
 * Peer assignments the Lead created and which provider/model runs each one (so
 * DeepSeek vs Claude is visible). Renders nothing until the Lead has created a Peer.
 */
export function OrchestrationLeadPlanCard({
  serverId,
  workspaceId,
}: OrchestrationLeadPlanCardProps) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const sessionAgents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const peers = useMemo(
    () =>
      sessionAgents
        ? Array.from(sessionAgents.values()).filter(
            (agent) =>
              agent.workspaceId === workspaceId &&
              agent.labels[ORCHESTRATION_ROLE_LABEL] === "peer",
          )
        : [],
    [sessionAgents, workspaceId],
  );

  if (peers.length === 0) {
    return null;
  }

  return (
    <View style={styles.leadPlanOuter}>
      <View style={styles.leadPlanTrack}>
        <View style={[styles.leadPlanCard, expanded && styles.leadPlanCardExpanded]}>
          <Pressable
            onPress={toggleExpanded}
            style={styles.leadPlanHeader}
            accessibilityRole="button"
            testID="orchestration-lead-plan"
          >
            {expanded ? (
              <ThemedChevronDown size={12} uniProps={mutedColorMapping} />
            ) : (
              <ThemedChevronRight size={12} uniProps={mutedColorMapping} />
            )}
            <Text style={styles.leadPlanTitle} numberOfLines={1}>
              Lead plan · {peers.length} bounded assignment{peers.length === 1 ? "" : "s"}
            </Text>
          </Pressable>
          {expanded ? (
            <View style={styles.leadPlanBody}>
              {peers.map((peer) => {
                const route = peer.labels[ORCHESTRATION_ROUTE_LABEL] ?? "impl";
                return (
                  <View key={peer.id} style={styles.leadPlanRow}>
                    <Text style={styles.leadPlanText} numberOfLines={1}>
                      {peer.title ?? "Peer"} · {route}
                    </Text>
                    <Text style={styles.leadPlanModel} numberOfLines={1}>
                      {peer.provider}/{peer.model ?? "default"}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: MIN_EXPLORER_SIDEBAR_WIDTH,
    height: "100%",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  columnCompact: {
    width: "100%",
    height: undefined,
    maxHeight: 240,
    borderRightWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  headerTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.5,
  },
  headerSubtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  scroll: { padding: theme.spacing[3], gap: theme.spacing[2] },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  agentRowText: { flex: 1, gap: 1 },
  agentRole: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  agentMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  statusDot: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  statusDotActive: { backgroundColor: theme.colors.statusSuccess },
  statusDotIdle: { backgroundColor: theme.colors.border },
  // Lead-plan card in the Supervisor thread: centered + width-capped to match the
  // composer and the SubagentsTrack, and collapsible via its header row.
  leadPlanOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  leadPlanTrack: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  leadPlanCard: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  leadPlanCardExpanded: {},
  leadPlanHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  leadPlanBody: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  leadPlanTitle: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  leadPlanRow: { gap: 1 },
  leadPlanText: { color: theme.colors.foreground, fontSize: theme.fontSize.xs },
  leadPlanModel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
}));
