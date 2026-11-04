import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowLeft, Bot, ExternalLink, Eye, EyeOff, Hammer, Pencil, X } from "lucide-react-native";
import type { JiraIssueDetail } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, IconButton, Input, IssueTypeIcon, tint } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { openExternal, useAsyncAction } from "./shared";
import { TransitionMenu } from "./transition-menu";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedX = withUnistyles(X);
const ThemedPencil = withUnistyles(Pencil);
const ThemedExternalLink = withUnistyles(ExternalLink);

// Issue header (spec 29.3): parent breadcrumb, type + key, status, watch, Ask AI, Work on this
// issue, Open in Jira, and the summary (editable in place).

interface Props {
  serverId: string;
  connectionId: string;
  issue: JiraIssueDetail;
  isCompact: boolean;
  onClose: () => void;
  onOpenIssue: (issueKey: string) => void;
  onAskAi: (issueKey: string) => void;
  onWorkOn: (issueKey: string) => void;
}

type IssueProps = Pick<Props, "serverId" | "connectionId" | "issue">;

function WatchToggle({ serverId, connectionId, issue }: IssueProps) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const toggle = useAsyncAction(
    useCallback(async () => {
      await call("jira.issue.watchers.set.request", {
        connectionId,
        issueKey: issue.key,
        watching: !issue.watching,
      });
      await invalidate();
    }, [call, connectionId, invalidate, issue.key, issue.watching]),
  );
  const { run } = toggle;
  const press = useCallback(() => void run(), [run]);
  return (
    <View style={jiraStyles.row}>
      <Button
        size="sm"
        variant="ghost"
        loading={toggle.pending}
        leftIcon={issue.watching ? EyeOff : Eye}
        onPress={press}
        accessibilityLabel={issue.watching ? "Stop watching" : "Watch"}
        testID="jira-issue-watch"
      >
        {`${issue.watching ? "Watching" : "Watch"} · ${issue.watchCount}`}
      </Button>
      {toggle.error ? <ErrorBanner message={toggle.error} /> : null}
    </View>
  );
}

function SummaryEditor({ serverId, connectionId, issue }: IssueProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.summary);
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const save = useAsyncAction(
    useCallback(async () => {
      await call("jira.issue.update.request", {
        connectionId,
        issueKey: issue.key,
        summary: draft.trim(),
      });
      await invalidate();
      setEditing(false);
    }, [call, connectionId, draft, invalidate, issue.key]),
  );
  const { run } = save;
  const startEditing = useCallback(() => {
    setDraft(issue.summary);
    setEditing(true);
  }, [issue.summary]);
  const cancel = useCallback(() => setEditing(false), []);
  const submit = useCallback(() => void run(), [run]);

  if (!editing) {
    return (
      <View style={styles.summaryRow}>
        <Text style={styles.summary} testID="jira-issue-summary">
          {issue.summary}
        </Text>
        {issue.canEdit ? (
          <Pressable
            onPress={startEditing}
            accessibilityRole="button"
            accessibilityLabel="Edit summary"
            testID="jira-issue-summary-edit"
            hitSlop={6}
          >
            <ThemedPencil size={14} uniProps={tint.muted} />
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <View style={jiraStyles.sheetBody}>
      <Input value={draft} onChangeText={setDraft} autoFocus testID="jira-issue-summary-input" />
      {save.error ? <ErrorBanner message={save.error} /> : null}
      <View style={jiraStyles.sheetFooter}>
        <Button size="sm" variant="ghost" onPress={cancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="default"
          loading={save.pending}
          disabled={draft.trim().length === 0}
          onPress={submit}
          testID="jira-issue-summary-save"
        >
          Save
        </Button>
      </View>
    </View>
  );
}

export function IssueHeader(props: Props) {
  const { issue, isCompact, onOpenIssue, onAskAi, onWorkOn } = props;
  const CloseIcon = isCompact ? ThemedArrowLeft : ThemedX;
  const parentKey = issue.parent?.key ?? null;
  const openParent = useCallback(() => {
    if (parentKey) onOpenIssue(parentKey);
  }, [onOpenIssue, parentKey]);
  const openWeb = useCallback(() => openExternal(issue.webUrl), [issue.webUrl]);
  const askAi = useCallback(() => onAskAi(issue.key), [issue.key, onAskAi]);
  const workOn = useCallback(() => onWorkOn(issue.key), [issue.key, onWorkOn]);
  return (
    <View style={styles.header}>
      <View style={jiraStyles.row}>
        <IconButton
          icon={CloseIcon}
          label={isCompact ? "Back" : "Close issue"}
          onPress={props.onClose}
          testID="jira-issue-close"
        />
        {issue.parent ? (
          <Pressable onPress={openParent} accessibilityRole="link" testID="jira-issue-parent">
            <Text style={jiraStyles.textSmall} numberOfLines={1}>
              {`${issue.parent.key} ${issue.parent.summary} /`}
            </Text>
          </Pressable>
        ) : null}
        <IssueTypeIcon type={issue.type} />
        <Text style={jiraStyles.mono} testID="jira-issue-key">
          {issue.key}
        </Text>
        <View style={jiraStyles.spacer} />
        <IconButton
          icon={ThemedExternalLink}
          label="Open in Jira"
          onPress={openWeb}
          testID="jira-issue-open-web"
        />
      </View>
      <SummaryEditor serverId={props.serverId} connectionId={props.connectionId} issue={issue} />
      <View style={jiraStyles.rowWrap}>
        <TransitionMenu
          serverId={props.serverId}
          connectionId={props.connectionId}
          issueKey={issue.key}
          status={issue.status}
        />
        <WatchToggle serverId={props.serverId} connectionId={props.connectionId} issue={issue} />
        <View style={jiraStyles.spacer} />
        <Button
          size="sm"
          variant="outline"
          leftIcon={Bot}
          onPress={askAi}
          testID="jira-issue-ask-ai"
        >
          Ask AI
        </Button>
        <Button
          size="sm"
          variant="default"
          leftIcon={Hammer}
          onPress={workOn}
          testID="jira-issue-work-on"
        >
          Work on this issue
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  header: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  summaryRow: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  summary: {
    flex: 1,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
}));
