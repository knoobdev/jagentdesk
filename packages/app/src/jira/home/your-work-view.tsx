import { ScrollView, Text, View } from "react-native";
import { errorMessage } from "../api";
import { useJiraSearch } from "../queries";
import { EmptyState, ErrorBanner } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { IssueList } from "./issue-list";

// "Your work" (spec 29.3): issues assigned to me and issues I watch.

export const ASSIGNED_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
export const WATCHING_JQL = "watcher = currentUser() ORDER BY updated DESC";

function Section({
  serverId,
  connectionId,
  title,
  jql,
  testID,
  onOpenIssue,
}: {
  serverId: string;
  connectionId: string;
  title: string;
  jql: string;
  testID: string;
  onOpenIssue: (issueKey: string) => void;
}) {
  const result = useJiraSearch(serverId, connectionId, jql);
  const issues = result.data?.issues ?? [];
  return (
    <View style={jiraStyles.formField}>
      <Text style={jiraStyles.sectionLabel}>{title}</Text>
      {result.error ? <ErrorBanner message={errorMessage(result.error)} /> : null}
      {result.isLoading ? <Text style={jiraStyles.textMuted}>Loading…</Text> : null}
      {!result.isLoading && !result.error && issues.length === 0 ? (
        <EmptyState title="Nothing here" />
      ) : null}
      {issues.length > 0 ? (
        <IssueList issues={issues} onOpenIssue={onOpenIssue} testID={testID} />
      ) : null}
    </View>
  );
}

export function YourWorkView({
  serverId,
  connectionId,
  onOpenIssue,
}: {
  serverId: string;
  connectionId: string;
  onOpenIssue: (issueKey: string) => void;
}) {
  return (
    <ScrollView
      style={jiraStyles.scroll}
      contentContainerStyle={jiraStyles.scrollContent}
      testID="jira-your-work"
    >
      <Section
        serverId={serverId}
        connectionId={connectionId}
        title="Assigned to me"
        jql={ASSIGNED_JQL}
        testID="jira-assigned"
        onOpenIssue={onOpenIssue}
      />
      <Section
        serverId={serverId}
        connectionId={connectionId}
        title="Watching"
        jql={WATCHING_JQL}
        testID="jira-watching"
        onOpenIssue={onOpenIssue}
      />
    </ScrollView>
  );
}
