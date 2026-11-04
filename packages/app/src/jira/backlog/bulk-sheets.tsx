import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type {
  JiraAssignee,
  JiraIssueCard,
  JiraStatus,
  JiraTransition,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useJiraCall } from "../api";
import { OptionRow } from "../board/keyed";
import { Spinner } from "../board/spinner";
import { ErrorBanner, Input } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// Pickers of the backlog bulk bar (spec 29.3: "chọn nhiều để đổi status/assignee/sprint").

interface AssigneeRow {
  key: string;
  label: string;
  assignee: JiraAssignee;
}

export function AssignSheet({
  serverId,
  connectionId,
  issues,
  onPick,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  issues: JiraIssueCard[];
  onPick: (assignee: JiraAssignee, label: string) => void;
  onClose: () => void;
}) {
  const call = useJiraCall(serverId);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const projectKey = issues[0]?.key.split("-")[0] ?? "";
  const users = useFetchQuery({
    queryKey: ["jira", serverId, connectionId, "assignable", projectKey, submitted],
    queryFn: async () =>
      (await call("jira.users.find.request", { connectionId, query: submitted, projectKey })).users,
    dataShape: "list",
    staleTimeMs: 30_000,
    enabled: submitted.length > 0,
  });
  const header = useMemo(() => ({ title: `Assign ${issues.length} issue(s)` }), [issues.length]);
  const rows = useMemo<AssigneeRow[]>(
    () => [
      { key: "me", label: "Assign to me", assignee: { kind: "me" } },
      { key: "none", label: "Unassigned", assignee: { kind: "none" } },
      ...(users.data ?? []).map((user) => ({
        key: user.ref,
        label: user.displayName,
        assignee: { kind: "user" as const, ref: user.ref },
      })),
    ],
    [users.data],
  );
  const search = useCallback(() => setSubmitted(query.trim()), [query]);
  const pick = useCallback(
    (key: string) => {
      const row = rows.find((candidate) => candidate.key === key);
      if (row) onPick(row.assignee, row.label);
    },
    [onPick, rows],
  );
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="jira-bulk-assign-sheet">
      <View style={jiraStyles.sheetBody}>
        <View style={jiraStyles.row}>
          <View style={jiraStyles.spacer}>
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder="Search people"
              onSubmitEditing={search}
              testID="jira-bulk-assign-query"
            />
          </View>
          <Button variant="outline" onPress={search} disabled={!query.trim()}>
            Search
          </Button>
        </View>
        {users.error ? <ErrorBanner message={users.error.message} /> : null}
        {users.isFetching ? <Spinner size="small" /> : null}
        <View style={jiraStyles.card}>
          {rows.map((row, index) => (
            <OptionRow
              key={row.key}
              value={row.key}
              label={row.label}
              last={index === rows.length - 1}
              onPick={pick}
              testID={`jira-bulk-assign-${row.key}`}
            />
          ))}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

export interface StatusChoice {
  status: JiraStatus;
  /** The transition each issue would run to reach the status; missing = cannot. */
  byIssue: Map<string, JiraTransition>;
}

function statusChoices(
  entries: Array<{ key: string; transitions: JiraTransition[] }>,
): StatusChoice[] {
  const byStatus = new Map<string, StatusChoice>();
  for (const entry of entries) {
    for (const transition of entry.transitions) {
      const choice = byStatus.get(transition.to.id) ?? {
        status: transition.to,
        byIssue: new Map<string, JiraTransition>(),
      };
      if (!choice.byIssue.has(entry.key)) choice.byIssue.set(entry.key, transition);
      byStatus.set(transition.to.id, choice);
    }
  }
  return [...byStatus.values()];
}

export function StatusSheet({
  serverId,
  connectionId,
  issues,
  onPick,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  issues: JiraIssueCard[];
  onPick: (choice: StatusChoice) => void;
  onClose: () => void;
}) {
  const call = useJiraCall(serverId);
  const keys = useMemo(() => issues.map((issue) => issue.key), [issues]);
  const transitions = useFetchQuery({
    queryKey: ["jira", serverId, connectionId, "bulk-transitions", keys],
    queryFn: () =>
      Promise.all(
        keys.map(async (key) => ({
          key,
          transitions: (
            await call("jira.issue.transitions.request", { connectionId, issueKey: key })
          ).transitions,
        })),
      ),
    dataShape: "list",
    staleTimeMs: 10_000,
  });
  const choices = useMemo(() => statusChoices(transitions.data ?? []), [transitions.data]);
  const header = useMemo(
    () => ({ title: `Change status of ${issues.length} issue(s)` }),
    [issues.length],
  );
  const pick = useCallback(
    (statusId: string) => {
      const choice = choices.find((candidate) => candidate.status.id === statusId);
      if (choice) onPick(choice);
    },
    [choices, onPick],
  );
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="jira-bulk-status-sheet">
      <View style={jiraStyles.sheetBody}>
        {transitions.error ? <ErrorBanner message={transitions.error.message} /> : null}
        {transitions.isLoading ? <Spinner size="small" /> : null}
        {!transitions.isLoading && choices.length === 0 ? (
          <Text style={jiraStyles.textMuted}>No transition is available for these issues.</Text>
        ) : null}
        <View style={jiraStyles.card}>
          {choices.map((choice, index) => (
            <OptionRow
              key={choice.status.id}
              value={choice.status.id}
              label={choice.status.name}
              last={index === choices.length - 1}
              onPick={pick}
              status={choice.status}
              detail={`${choice.byIssue.size} of ${issues.length} can move`}
              testID={`jira-bulk-status-${choice.status.id}`}
            />
          ))}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}
