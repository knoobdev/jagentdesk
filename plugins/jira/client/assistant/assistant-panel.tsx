import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { ArrowLeft, MessageSquare, Plus, X } from "lucide-react-native";
import {
  AgentConversationPanel,
  EmbeddedAgentPaneProvider,
  useHostRuntimeClient,
  useProvidersSnapshot,
  useSessionStore,
  EmptyState,
  IconButton,
  tint,
  jiraStyles,
  firstWorkspaceDirectory,
} from "../../../../packages/app/src/plugins/builtin/host-api";
import type { Agent } from "../../../../packages/app/src/plugins/builtin/host-api";
import { JiraAssistantDraft } from "./assistant-draft";
import {
  JIRA_ASSISTANT_LABEL,
  JIRA_ASSISTANT_SCOPE_LABEL,
  jiraAssistantScope,
  type JiraAssistantContext,
} from "./context";

// "Ask AI" (spec 29.4): a chat bound to the Jira connection and what is on screen. One assistant
// per scope (connection + issue/project/board) is reused across opens, like the Forge assistant.

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedMessage = withUnistyles(MessageSquare);
const ThemedPlus = withUnistyles(Plus);
const ThemedX = withUnistyles(X);

function findAssistant(agents: Map<string, Agent> | undefined, scope: string): Agent | null {
  let latest: Agent | null = null;
  for (const agent of agents?.values() ?? []) {
    if (agent.archivedAt) continue;
    if (agent.labels?.[JIRA_ASSISTANT_LABEL] !== "true") continue;
    if (agent.labels?.[JIRA_ASSISTANT_SCOPE_LABEL] !== scope) continue;
    if (!latest || agent.lastActivityAt > latest.lastActivityAt) latest = agent;
  }
  return latest;
}

export function JiraAssistantPanel({
  serverId,
  context,
  isCompact,
  onClose,
}: {
  serverId: string;
  context: JiraAssistantContext;
  isCompact: boolean;
  onClose: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const provider = entries?.find((entry) => entry.enabled)?.provider ?? null;
  const cwd = useMemo(() => firstWorkspaceDirectory(workspaces), [workspaces]);
  const ready = Boolean(client && provider && cwd);
  const scope = jiraAssistantScope(context);
  const [agent, setAgent] = useState<{ agentId: string; workspaceId: string | null } | null>(null);

  const resolvedScope = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || resolvedScope.current === scope) return;
    resolvedScope.current = scope;
    const existing = findAssistant(agents, scope);
    setAgent(existing ? { agentId: existing.id, workspaceId: existing.workspaceId ?? null } : null);
  }, [agents, ready, scope]);

  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  useEffect(() => {
    if (!viewedTimelineSync) return;
    const source = `jira-assistant:${serverId}`;
    viewedTimelineSync.replaceVisibleAgentIds(source, agent ? [agent.agentId] : []);
    return () => viewedTimelineSync.replaceVisibleAgentIds(source, []);
  }, [viewedTimelineSync, serverId, agent]);

  const newChat = useCallback(() => setAgent(null), []);
  const handleCreated = useCallback(
    (created: { agentId: string; workspaceId: string | null }) => setAgent(created),
    [],
  );

  let body: React.ReactNode;
  if (agent) {
    body = (
      <EmbeddedAgentPaneProvider
        serverId={serverId}
        workspaceId={agent.workspaceId}
        agentId={agent.agentId}
        tabId={`jira-assistant-${agent.agentId}`}
        onClose={onClose}
      >
        <AgentConversationPanel />
      </EmbeddedAgentPaneProvider>
    );
  } else if (ready && cwd) {
    body = (
      <JiraAssistantDraft
        serverId={serverId}
        context={context}
        cwd={cwd}
        onCreated={handleCreated}
      />
    );
  } else {
    body = (
      <EmptyState
        title="Ask the Jira assistant"
        body={
          provider
            ? "Open a project first — the assistant runs inside a project's workspace."
            : "Turn on an AI provider in Host settings."
        }
      />
    );
  }

  const subtitle = [context.siteLabel, context.issueKey ?? context.projectKey]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={jiraStyles.screen} testID="jira-assistant-panel">
      <View style={jiraStyles.listRow}>
        {isCompact ? (
          <IconButton icon={ThemedArrowLeft} label="Back" onPress={onClose} />
        ) : (
          <ThemedMessage size={15} uniProps={tint.muted} />
        )}
        <View style={jiraStyles.main}>
          <Text style={jiraStyles.textStrong}>Jira assistant</Text>
          <Text style={jiraStyles.textSmall} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <IconButton
          icon={ThemedPlus}
          label="New chat"
          onPress={newChat}
          testID="jira-assistant-new"
        />
        {isCompact ? null : (
          <IconButton
            icon={ThemedX}
            label="Close assistant"
            onPress={onClose}
            testID="jira-assistant-close"
          />
        )}
      </View>
      <View style={jiraStyles.scroll}>{body}</View>
    </View>
  );
}
