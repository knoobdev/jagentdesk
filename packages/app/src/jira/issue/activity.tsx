import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import type { JiraComment } from "@jagentdesk/protocol/jira/rpc-schemas";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { errorMessage, useJiraCall } from "../api";
import { jiraKeys, useJiraChangelog, useJiraComments, useJiraWorklogs } from "../queries";
import { EmptyState, ErrorBanner, Tabs, UserAvatar } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { Spinner } from "./controls";
import { CommentComposer } from "./comment-composer";
import { formatDateTime, handleMarkdownLink } from "./shared";
import { WorklogForm } from "./worklog-form";

// Activity (spec 29.3): Comments (mentions, edit your own), History and Work log.

type ActivityTab = "comments" | "history" | "worklog";

const TABS: ReadonlyArray<{ id: ActivityTab; label: string }> = [
  { id: "comments", label: "Comments" },
  { id: "history", label: "History" },
  { id: "worklog", label: "Work log" },
];

interface Props {
  serverId: string;
  connectionId: string;
  issueKey: string;
}

function useRefreshIssue({ serverId, connectionId, issueKey }: Props): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      queryClient.invalidateQueries({ queryKey: jiraKeys.issue(serverId, connectionId, issueKey) }),
    [connectionId, issueKey, queryClient, serverId],
  );
}

function CommentItem({ comment, ...props }: Props & { comment: JiraComment }) {
  const [editing, setEditing] = useState(false);
  const call = useJiraCall(props.serverId);
  const refresh = useRefreshIssue(props);
  const save = useCallback(
    async (markdown: string) => {
      await call("jira.issue.comments.update.request", {
        connectionId: props.connectionId,
        issueKey: props.issueKey,
        commentId: comment.id,
        bodyMarkdown: markdown,
      });
      await refresh();
      setEditing(false);
    },
    [call, comment.id, props.connectionId, props.issueKey, refresh],
  );
  const startEditing = useCallback(() => setEditing(true), []);
  const stopEditing = useCallback(() => setEditing(false), []);
  return (
    <View style={styles.item} testID={`jira-comment-${comment.id}`}>
      <View style={jiraStyles.row}>
        <UserAvatar user={comment.author} size={22} />
        <Text style={jiraStyles.textStrong}>{comment.author?.displayName ?? "Unknown"}</Text>
        <Text style={jiraStyles.textSmall}>{formatDateTime(comment.created_ms)}</Text>
        <View style={jiraStyles.spacer} />
        {comment.editable && comment.body.editable && !editing ? (
          <Button
            size="xs"
            variant="ghost"
            onPress={startEditing}
            testID={`jira-comment-${comment.id}-edit`}
          >
            Edit
          </Button>
        ) : null}
      </View>
      {editing ? (
        <CommentComposer
          serverId={props.serverId}
          connectionId={props.connectionId}
          issueKey={props.issueKey}
          initialText={comment.body.markdown}
          submitLabel="Save"
          onSubmit={save}
          onCancel={stopEditing}
          testID={`jira-comment-${comment.id}-editor`}
        />
      ) : (
        <View style={styles.body}>
          <MarkdownRenderer text={comment.body.markdown} onLinkPress={handleMarkdownLink} />
        </View>
      )}
    </View>
  );
}

function Comments(props: Props) {
  const comments = useJiraComments(props.serverId, props.connectionId, props.issueKey);
  const call = useJiraCall(props.serverId);
  const refresh = useRefreshIssue(props);
  const add = useCallback(
    async (markdown: string) => {
      await call("jira.issue.comments.add.request", {
        connectionId: props.connectionId,
        issueKey: props.issueKey,
        bodyMarkdown: markdown,
      });
      await refresh();
    },
    [call, props.connectionId, props.issueKey, refresh],
  );
  return (
    <View style={jiraStyles.sheetBody}>
      <CommentComposer {...props} submitLabel="Save" onSubmit={add} testID="jira-comment-new" />
      {comments.isLoading ? <Spinner /> : null}
      {comments.error ? <ErrorBanner message={errorMessage(comments.error)} /> : null}
      {comments.data && comments.data.comments.length === 0 ? (
        <EmptyState title="No comments yet" />
      ) : null}
      {(comments.data?.comments ?? []).map((comment) => (
        <CommentItem key={comment.id} comment={comment} {...props} />
      ))}
    </View>
  );
}

function History(props: Props) {
  const history = useJiraChangelog(props.serverId, props.connectionId, props.issueKey);
  const entries = [...(history.data?.entries ?? [])].sort((a, b) => b.created_ms - a.created_ms);
  return (
    <View style={jiraStyles.sheetBody} testID="jira-history">
      {history.isLoading ? <Spinner /> : null}
      {history.error ? <ErrorBanner message={errorMessage(history.error)} /> : null}
      {history.data && entries.length === 0 ? <EmptyState title="No changes yet" /> : null}
      {entries.flatMap((entry) =>
        entry.items.map((item) => (
          <View key={`${entry.id}-${item.field}-${item.to ?? ""}`} style={styles.historyRow}>
            <UserAvatar user={entry.author} size={20} />
            <Text style={[jiraStyles.text, jiraStyles.spacer]}>
              <Text style={jiraStyles.textStrong}>{entry.author?.displayName ?? "Someone"}</Text>
              {` changed ${item.field} from ${item.from ?? "None"} to ${item.to ?? "None"}`}
            </Text>
            <Text style={jiraStyles.textSmall}>{formatDateTime(entry.created_ms)}</Text>
          </View>
        )),
      )}
    </View>
  );
}

function WorkLog(props: Props) {
  const worklogs = useJiraWorklogs(props.serverId, props.connectionId, props.issueKey);
  const [logging, setLogging] = useState(false);
  const queryClient = useQueryClient();
  const done = useCallback(() => {
    setLogging(false);
    void queryClient.invalidateQueries({
      queryKey: jiraKeys.issue(props.serverId, props.connectionId, props.issueKey),
    });
  }, [props.connectionId, props.issueKey, props.serverId, queryClient]);
  const startLogging = useCallback(() => setLogging(true), []);
  return (
    <View style={jiraStyles.sheetBody} testID="jira-worklog">
      {logging ? (
        <WorklogForm {...props} onDone={done} />
      ) : (
        <View style={jiraStyles.row}>
          <Button size="sm" variant="outline" onPress={startLogging} testID="jira-worklog-add">
            Log work
          </Button>
        </View>
      )}
      {worklogs.isLoading ? <Spinner /> : null}
      {worklogs.error ? <ErrorBanner message={errorMessage(worklogs.error)} /> : null}
      {worklogs.data && worklogs.data.worklogs.length === 0 ? (
        <EmptyState title="No work logged" />
      ) : null}
      {(worklogs.data?.worklogs ?? []).map((worklog) => (
        <View key={worklog.id} style={styles.item}>
          <View style={jiraStyles.row}>
            <UserAvatar user={worklog.author} size={22} />
            <Text style={jiraStyles.textStrong}>{worklog.author?.displayName ?? "Unknown"}</Text>
            <Text style={jiraStyles.text}>{`logged ${worklog.timeSpent}`}</Text>
            <View style={jiraStyles.spacer} />
            <Text style={jiraStyles.textSmall}>{formatDateTime(worklog.started_ms)}</Text>
          </View>
          {worklog.comment ? (
            <View style={styles.body}>
              <MarkdownRenderer text={worklog.comment} onLinkPress={handleMarkdownLink} />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function IssueActivity(props: Props) {
  const [tab, setTab] = useState<ActivityTab>("comments");
  return (
    <View style={jiraStyles.sheetBody} testID="jira-issue-activity">
      <Text style={jiraStyles.sectionLabel}>Activity</Text>
      <Tabs tabs={TABS} value={tab} onChange={setTab} testIDPrefix="jira-activity" />
      {tab === "comments" ? <Comments {...props} /> : null}
      {tab === "history" ? <History {...props} /> : null}
      {tab === "worklog" ? <WorkLog {...props} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  item: {
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  body: { paddingLeft: 30 },
  historyRow: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
}));
