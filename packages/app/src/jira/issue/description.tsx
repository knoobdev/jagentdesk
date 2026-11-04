import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import type { JiraIssueDetail } from "@jagentdesk/protocol/jira/rpc-schemas";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, Input } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { handleMarkdownLink, openExternal, useAsyncAction } from "./shared";

// Description (spec 29.3): written in Markdown, stored as ADF (Cloud) or wiki markup (DC) by the
// daemon. Content Markdown cannot round-trip (panels, macros, complex tables, media) is shown
// read-only with "Open in Jira" instead of an editor.

export function IssueDescription({
  serverId,
  connectionId,
  issue,
}: {
  serverId: string;
  connectionId: string;
  issue: JiraIssueDetail;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.description.markdown);
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const save = useAsyncAction(
    useCallback(async () => {
      await call("jira.issue.update.request", {
        connectionId,
        issueKey: issue.key,
        descriptionMarkdown: draft,
      });
      await invalidate();
      setEditing(false);
    }, [call, connectionId, draft, invalidate, issue.key]),
  );
  const { description } = issue;
  const canEdit = issue.canEdit && description.editable;
  const { run } = save;
  const startEditing = useCallback(() => {
    setDraft(description.markdown);
    setEditing(true);
  }, [description.markdown]);
  const cancel = useCallback(() => setEditing(false), []);
  const submit = useCallback(() => void run(), [run]);
  const openWeb = useCallback(() => openExternal(issue.webUrl), [issue.webUrl]);

  return (
    <View style={jiraStyles.sheetBody} testID="jira-issue-description">
      <View style={jiraStyles.row}>
        <Text style={jiraStyles.sectionLabel}>Description</Text>
        <View style={jiraStyles.spacer} />
        {canEdit && !editing ? (
          <Button
            size="xs"
            variant="ghost"
            onPress={startEditing}
            testID="jira-issue-description-edit"
          >
            Edit
          </Button>
        ) : null}
      </View>
      {editing ? (
        <View style={jiraStyles.sheetBody}>
          <Input
            multiline
            value={draft}
            onChangeText={setDraft}
            placeholder="Describe the issue in Markdown"
            testID="jira-issue-description-input"
          />
          {save.error ? <ErrorBanner message={save.error} /> : null}
          <View style={jiraStyles.sheetFooter}>
            <Button size="sm" variant="ghost" onPress={cancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="default"
              loading={save.pending}
              onPress={submit}
              testID="jira-issue-description-save"
            >
              Save
            </Button>
          </View>
        </View>
      ) : (
        <View>
          {description.markdown.trim() ? (
            <MarkdownRenderer text={description.markdown} onLinkPress={handleMarkdownLink} />
          ) : (
            <Text style={jiraStyles.textMuted}>No description.</Text>
          )}
        </View>
      )}
      {description.editable ? null : (
        <View style={jiraStyles.row} testID="jira-issue-description-readonly">
          <Text style={[jiraStyles.textSmall, jiraStyles.spacer]}>
            {`This description contains ${description.unsupported.join(", ")} that JAgentDesk cannot edit safely.`}
          </Text>
          <Button size="xs" variant="outline" onPress={openWeb}>
            Open in Jira
          </Button>
        </View>
      )}
    </View>
  );
}
