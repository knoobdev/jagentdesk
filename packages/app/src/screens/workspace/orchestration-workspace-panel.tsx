import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { GitBranch, X } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useOrchestration } from "@/hooks/use-orchestration";
import { startOrchestrationObjective } from "@/orchestration/start-objective";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import {
  ORCHESTRATION_ROLE_LABEL,
  ORCHESTRATION_ROUTE_LABEL,
  type OrchestrationTaskBrief,
} from "@jagentdesk/protocol/orchestration";

interface WorkspaceOrchestrationPanelProps {
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  variant?: "modal" | "dock";
  onClose?: () => void;
  openOnMount?: boolean;
}

const ROLE_ORDER: Record<string, number> = { supervisor: 0, lead: 1, peer: 2 };

function roleLabel(role: string | undefined, route: string | undefined): string {
  if (role === "supervisor") return "Supervisor";
  if (role === "lead") return "Lead";
  if (role === "peer") return route ? `Peer · ${route}` : "Peer";
  return role ?? "Peer";
}

function BriefCard({ brief }: { brief: OrchestrationTaskBrief }) {
  return (
    <View style={styles.briefCard} testID="orchestration-task-brief">
      <Text style={styles.cardTitle}>Task Brief · {brief.status}</Text>
      <Text style={styles.label}>Objective</Text>
      <Text style={styles.body}>{brief.objective}</Text>
      <Text style={styles.label}>Route</Text>
      <Text style={styles.body}>
        {brief.routeCategory} · {brief.selectedRoute.role}/{brief.selectedRoute.profileId}
      </Text>
      {brief.openQuestions.length > 0 ? (
        <View style={styles.questions}>
          <Text style={styles.label}>Needs your decision</Text>
          {brief.openQuestions.map((question) => (
            <Text key={question} style={styles.body}>
              • {question}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.label}>Acceptance</Text>
      {brief.acceptanceCriteria.map((criterion) => (
        <Text key={criterion} style={styles.body}>
          • {criterion}
        </Text>
      ))}
    </View>
  );
}

export function WorkspaceOrchestrationPanel({
  serverId,
  workspaceId,
  cwd,
  variant = "modal",
  onClose,
  openOnMount = false,
}: WorkspaceOrchestrationPanelProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config } = useOrchestration(serverId);
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
  const [visible, setVisible] = useState(false);
  const [request, setRequest] = useState("");
  const [brief, setBrief] = useState<OrchestrationTaskBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (openOnMount) {
      setVisible(true);
    }
  }, [openOnMount]);

  const supervisor = useMemo(
    () => agents.find((agent) => agent.labels[ORCHESTRATION_ROLE_LABEL] === "supervisor"),
    [agents],
  );

  const roster = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const roleA = a.labels[ORCHESTRATION_ROLE_LABEL];
        const roleB = b.labels[ORCHESTRATION_ROLE_LABEL];
        return (ROLE_ORDER[roleA] ?? 9) - (ROLE_ORDER[roleB] ?? 9);
      }),
    [agents],
  );

  const peers = useMemo(
    () => agents.filter((agent) => agent.labels[ORCHESTRATION_ROLE_LABEL] === "peer"),
    [agents],
  );

  const handleSend = useCallback(async () => {
    const rawRequest = request.trim();
    if (!rawRequest || !client || !cwd || !config) {
      setError("Connect to the host and choose a workspace before sending a request.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { brief, started } = await startOrchestrationObjective({
        client,
        config,
        cwd,
        workspaceId,
        supervisor,
        rawRequest,
      });
      setBrief(brief);
      if (!started) return; // needs clarification — keep modal open, show the brief
      setRequest("");
      if (variant === "modal") {
        setVisible(false);
      }
      onClose?.();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to send the request.");
    } finally {
      setPending(false);
    }
  }, [client, config, cwd, request, setVisible, supervisor, variant, onClose, workspaceId]);

  const handleKeyPress = useCallback(
    (event: { nativeEvent: { key: string; shiftKey?: boolean }; preventDefault?: () => void }) => {
      if (event.nativeEvent.key !== "Enter") return;
      if (event.nativeEvent.shiftKey) return;
      if (pending) return;
      if (!request.trim()) return;
      event.preventDefault?.();
      void handleSend();
    },
    [handleSend, pending, request],
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: "Orchestration",
      subtitle: "Human → Supervisor → Lead → Peer",
      leading: <GitBranch size={18} color={theme.colors.foregroundMuted} />,
    }),
    [theme.colors.foregroundMuted],
  );

  const statusBody = (
    <>
      <View style={styles.runtimeCard}>
        <Text style={styles.cardTitle}>Runtime</Text>
        {roster.length === 0 ? (
          <Text style={styles.bodyText}>
            Supervisor:{" "}
            {supervisor
              ? `${supervisor.provider}/${supervisor.model ?? "default"} · ${supervisor.status}`
              : "not started"}
          </Text>
        ) : (
          roster.map((agent) => {
            const role = agent.labels[ORCHESTRATION_ROLE_LABEL];
            const route = agent.labels[ORCHESTRATION_ROUTE_LABEL];
            const isActive = agent.status === "running";
            return (
              <View key={agent.id} style={styles.agentRow} testID="orchestration-agent-row">
                <View style={styles.agentRowLeft}>
                  <View
                    style={[
                      styles.statusDot,
                      {
                        backgroundColor: isActive
                          ? theme.colors.statusSuccess
                          : theme.colors.border,
                      },
                    ]}
                  />
                  <View style={styles.agentRowText}>
                    <Text style={styles.agentRole}>{roleLabel(role, route)}</Text>
                    <Text style={styles.bodyText}>
                      {agent.provider}/{agent.model ?? "default"}
                    </Text>
                  </View>
                </View>
                <View style={styles.agentRowRight}>
                  <Text style={styles.bodyText}>{agent.status}</Text>
                  <Pressable
                    onPress={() =>
                      router.push(buildHostAgentDetailRoute(serverId, agent.id, workspaceId))
                    }
                    hitSlop={8}
                    testID="orchestration-open-thread"
                  >
                    <Text style={styles.openThread}>Open thread</Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </View>
      {peers.length > 0 ? (
        <View style={styles.leadPlanCard} testID="orchestration-lead-plan">
          <Text style={styles.cardTitle}>
            Lead plan · {peers.length} bounded assignment{peers.length === 1 ? "" : "s"}
          </Text>
          {peers.map((peer) => {
            const route = peer.labels[ORCHESTRATION_ROUTE_LABEL] ?? "impl";
            return (
              <View key={peer.id} style={styles.leadPlanRow}>
                <Text style={styles.body} numberOfLines={1}>
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
    </>
  );

  const composerBody = (
    <>
      <Field
        label="What should the team do?"
        hint="Write naturally. The system prepares the complete Supervisor brief automatically."
      >
        <FormTextInput
          value={request}
          onChangeText={setRequest}
          onKeyPress={handleKeyPress}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
          editable={!pending}
          placeholder="Example: Add the Output Format ON/OFF setting to the Use Case form, keep the default OFF, and test both paths."
          testID="orchestration-request-input"
          style={styles.requestInput}
        />
      </Field>
      <Text style={styles.hint}>Enter to send · Shift+Enter for a new line</Text>
      <Button
        variant="default"
        testID="orchestration-send-request"
        onPress={() => void handleSend()}
        loading={pending}
        disabled={!request.trim() || pending}
      >
        Send to Supervisor
      </Button>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {brief ? <BriefCard brief={brief} /> : null}
      {!brief && pending ? (
        <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
      ) : null}
    </>
  );

  const body = (
    <View style={styles.panelBody}>
      {statusBody}
      {composerBody}
    </View>
  );

  if (variant === "dock") {
    return (
      <View style={styles.dockColumn} testID="workspace-orchestration-dock">
        <View style={styles.dockHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Orchestration</Text>
            <Text style={styles.bodyText}>Human → Supervisor → Lead → Peer</Text>
          </View>
          <Pressable onPress={onClose} testID="orchestration-dock-close" hitSlop={8}>
            <X size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.dockScroll}>
          <View style={styles.panelBody}>{statusBody}</View>
        </ScrollView>
      </View>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        leftIcon={GitBranch}
        onPress={() => setVisible(true)}
        disabled={!isConnected}
        testID="workspace-orchestration-open"
      >
        Orchestration
      </Button>
      <AdaptiveModalSheet
        visible={visible}
        header={header}
        onClose={() => setVisible(false)}
        desktopMaxWidth={680}
        testID="workspace-orchestration-panel"
      >
        {body}
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  dockColumn: {
    width: 400,
    height: "100%",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  dockHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  dockScroll: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[12],
  },
  panelBody: { gap: theme.spacing[4], paddingBottom: theme.spacing[2] },
  runtimeCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  bodyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  agentRowLeft: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flex: 1 },
  agentRowText: { gap: 1, flex: 1 },
  agentRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  agentRole: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  statusDot: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  openThread: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  leadPlanCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  leadPlanRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  leadPlanModel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[2],
  },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
  requestInput: { minHeight: 120 },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  briefCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[1],
  },
  questions: { marginTop: theme.spacing[2] },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
