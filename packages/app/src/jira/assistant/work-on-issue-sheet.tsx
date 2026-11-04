import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router, type Href } from "expo-router";
import { jiraWorkOnIssuePrompt } from "@jagentdesk/protocol/jira/issue-markdown";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { errorMessage, useJiraCall } from "../api";
import { EmptyState, ErrorBanner, PressableRow } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { issueMarkdownWithContext } from "./issue-attachment";
import { usableWorkspaces, workspaceDirectory } from "./workspaces";

// "Work on this issue" (spec 29.4): pick a workspace; a new agent starts there with a visible
// prompt holding the issue as Markdown (acceptance criteria, text attachments) and the steps to
// branch, open a PR through Forge Hub and report back on the issue.

export const JIRA_ISSUE_AGENT_LABEL = "jagentdesk.jira.issue";

export function WorkOnIssueSheet({
  serverId,
  connectionId,
  issueKey,
  visible,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  issueKey: string;
  visible: boolean;
  onClose: () => void;
}) {
  const call = useJiraCall(serverId);
  const client = useHostRuntimeClient(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const provider = entries?.find((entry) => entry.enabled)?.provider ?? null;
  const workspacesMap = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const workspaces = useMemo(() => usableWorkspaces(workspacesMap), [workspacesMap]);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "starting"; workspaceId: string }
    | { kind: "error"; message: string }
  >({
    kind: "idle",
  });

  const header = useMemo(
    () => ({ title: `Work on ${issueKey}`, subtitle: "Choose the workspace for the agent" }),
    [issueKey],
  );
  const start = useCallback(
    async (workspaceId: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace || !client || !provider) return;
      setState({ kind: "starting", workspaceId });
      try {
        const { issue } = await call("jira.issue.get.request", { connectionId, issueKey });
        if (!issue) throw new Error(`${issueKey} is unavailable.`);
        const issueMarkdown = await issueMarkdownWithContext(call, connectionId, issue);
        const agent = await client.createAgent({
          provider,
          cwd: workspaceDirectory(workspace),
          workspaceId: workspace.id,
          title: `${issue.key}: ${issue.summary}`,
          initialPrompt: jiraWorkOnIssuePrompt({
            connectionId,
            issueKey: issue.key,
            issueMarkdown,
          }),
          labels: { [JIRA_ISSUE_AGENT_LABEL]: `${connectionId}/${issue.key}` },
        });
        setState({ kind: "idle" });
        onClose();
        router.push(buildHostAgentDetailRoute(serverId, agent.id, workspace.id) as Href);
      } catch (error) {
        setState({ kind: "error", message: errorMessage(error) });
      }
    },
    [call, client, connectionId, issueKey, onClose, provider, serverId, workspaces],
  );

  const startById = useCallback((workspaceId: string) => void start(workspaceId), [start]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="jira-work-on-sheet"
    >
      <View style={jiraStyles.sheetBody}>
        {!provider ? (
          <ErrorBanner message="Turn on an AI provider in Host settings first." />
        ) : null}
        {state.kind === "error" ? <ErrorBanner message={state.message} /> : null}
        {workspaces.length === 0 ? (
          <EmptyState
            title="No workspace"
            body="Open a project from the sidebar first; the agent works inside it."
          />
        ) : (
          <View style={jiraStyles.card}>
            {workspaces.map((workspace, index) => (
              <PressableRow
                key={workspace.id}
                value={workspace.id}
                onPick={startById}
                last={index === workspaces.length - 1}
                disabled={state.kind === "starting" || !provider}
                testID={`jira-work-on-workspace-${workspace.id}`}
              >
                <View style={jiraStyles.main}>
                  <Text style={jiraStyles.textStrong}>{workspace.title ?? workspace.name}</Text>
                  <Text style={jiraStyles.mono} numberOfLines={1}>
                    {workspaceDirectory(workspace)}
                  </Text>
                </View>
                {state.kind === "starting" && state.workspaceId === workspace.id ? (
                  <Text style={jiraStyles.textMuted}>Starting…</Text>
                ) : null}
              </PressableRow>
            ))}
          </View>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}
