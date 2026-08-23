import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useRouter } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { MIN_EXPLORER_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import {
  ORCHESTRATION_ROLE_LABEL,
  ORCHESTRATION_ROUTE_LABEL,
} from "@jagentdesk/protocol/orchestration";

const ROLE_ORDER: Record<string, number> = { supervisor: 0, lead: 1, peer: 2 };

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
  const { theme } = useUnistyles();
  const router = useRouter();
  const sessionAgents = useSessionStore((state) => state.sessions[serverId]?.agents);

  const agents = useMemo(
    () =>
      sessionAgents
        ? Array.from(sessionAgents.values()).filter(
            (agent) => agent.workspaceId === workspaceId && agent.labels[ORCHESTRATION_ROLE_LABEL],
          )
        : [],
    [sessionAgents, workspaceId],
  );

  const roster = useMemo(
    () =>
      [...agents].sort(
        (a, b) =>
          (ROLE_ORDER[a.labels[ORCHESTRATION_ROLE_LABEL]] ?? 9) -
          (ROLE_ORDER[b.labels[ORCHESTRATION_ROLE_LABEL]] ?? 9),
      ),
    [agents],
  );

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
        {roster.map((agent) => {
          const role = agent.labels[ORCHESTRATION_ROLE_LABEL];
          const route = agent.labels[ORCHESTRATION_ROUTE_LABEL];
          const isActive = agent.status === "running";
          return (
            <Pressable
              key={agent.id}
              style={styles.agentRow}
              onPress={() =>
                router.push(buildHostAgentDetailRoute(serverId, agent.id, workspaceId))
              }
              testID="orchestration-agent-row"
            >
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: isActive ? theme.colors.statusSuccess : theme.colors.border },
                ]}
              />
              <View style={styles.agentRowText}>
                <Text style={styles.agentRole} numberOfLines={1}>
                  {roleLabel(role, route)}
                </Text>
                <Text style={styles.agentMeta} numberOfLines={1}>
                  {agent.provider}/{agent.model ?? "default"} · {agent.status}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
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
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = useState(false);
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
            onPress={() => setExpanded((value) => !value)}
            style={styles.leadPlanHeader}
            accessibilityRole="button"
            testID="orchestration-lead-plan"
          >
            {expanded ? (
              <ChevronDown size={12} color={theme.colors.foregroundMuted} />
            ) : (
              <ChevronRight size={12} color={theme.colors.foregroundMuted} />
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
