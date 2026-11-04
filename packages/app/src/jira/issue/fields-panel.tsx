import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  JiraFieldInput,
  JiraFieldView,
  JiraIssueDetail,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, UserAvatar } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { FieldEditor, fieldDisplay, initialInput } from "./field-editor";
import { useAsyncAction } from "./shared";

// The issue's side fields (spec 29.3): what Jira's editmeta allows to edit, in Jira's order,
// each editable in place. Assignee changes go through the assign endpoint (with "Assign to me").

interface Props {
  serverId: string;
  connectionId: string;
  issue: JiraIssueDetail;
}

function FieldValue({ field }: { field: JiraFieldView }) {
  if (field.value.kind === "user") {
    return (
      <View style={jiraStyles.row}>
        <UserAvatar user={field.value.user} size={20} />
        <Text style={jiraStyles.text}>{field.value.user?.displayName ?? "Unassigned"}</Text>
      </View>
    );
  }
  return <Text style={jiraStyles.text}>{fieldDisplay(field.value) ?? "None"}</Text>;
}

function FieldRow({ serverId, connectionId, issue, field }: Props & { field: JiraFieldView }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<JiraFieldInput | null>(null);
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const isAssignee = field.fieldId === "assignee";

  const save = useAsyncAction(
    useCallback(
      async (input: JiraFieldInput) => {
        if (isAssignee && input.kind === "user") {
          await call("jira.issue.assign.request", {
            connectionId,
            issueKey: issue.key,
            assignee: input.ref === null ? { kind: "none" } : { kind: "user", ref: input.ref },
          });
        } else {
          await call("jira.issue.update.request", {
            connectionId,
            issueKey: issue.key,
            fields: { [field.fieldId]: input },
          });
        }
        await invalidate();
        setEditing(false);
      },
      [call, connectionId, field.fieldId, invalidate, isAssignee, issue.key],
    ),
  );
  const assignToMe = useAsyncAction(
    useCallback(async () => {
      await call("jira.issue.assign.request", {
        connectionId,
        issueKey: issue.key,
        assignee: { kind: "me" },
      });
      await invalidate();
    }, [call, connectionId, invalidate, issue.key]),
  );

  const startEditing = useCallback(() => {
    setDraft(initialInput(field));
    setEditing(true);
  }, [field]);
  const cancel = useCallback(() => setEditing(false), []);
  const saveRun = save.run;
  const submit = useCallback(() => {
    if (draft) void saveRun(draft);
  }, [draft, saveRun]);
  const assignRun = assignToMe.run;
  const assignMe = useCallback(() => void assignRun(), [assignRun]);

  return (
    <View style={styles.fieldRow} testID={`jira-field-${field.fieldId}`}>
      <Text style={jiraStyles.formLabel}>{field.name}</Text>
      {editing ? (
        <View style={jiraStyles.sheetBody}>
          <FieldEditor
            field={field}
            value={draft}
            onChange={setDraft}
            serverId={serverId}
            connectionId={connectionId}
            issueKey={issue.key}
          />
          <View style={jiraStyles.sheetFooter}>
            <Button size="xs" variant="ghost" onPress={cancel}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="default"
              loading={save.pending}
              disabled={draft === null}
              onPress={submit}
              testID={`jira-field-${field.fieldId}-save`}
            >
              Save
            </Button>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={field.editable ? startEditing : undefined}
          disabled={!field.editable}
          accessibilityRole={field.editable ? "button" : undefined}
          accessibilityLabel={field.editable ? `Edit ${field.name}` : undefined}
          style={field.editable ? styles.valueEditable : styles.value}
          testID={`jira-field-${field.fieldId}-value`}
        >
          <FieldValue field={field} />
        </Pressable>
      )}
      {isAssignee && field.editable && !editing ? (
        <Pressable
          onPress={assignMe}
          disabled={assignToMe.pending}
          accessibilityRole="button"
          testID="jira-assign-to-me"
        >
          <Text style={styles.link}>{assignToMe.pending ? "Assigning…" : "Assign to me"}</Text>
        </Pressable>
      ) : null}
      {save.error ? <ErrorBanner message={save.error} /> : null}
      {assignToMe.error ? <ErrorBanner message={assignToMe.error} /> : null}
    </View>
  );
}

export function IssueFieldsPanel({ serverId, connectionId, issue }: Props) {
  const tracking = issue.timeTracking;
  const hasTracking =
    tracking !== null &&
    (tracking.originalEstimate || tracking.remainingEstimate || tracking.timeSpent);
  return (
    <View style={styles.panel} testID="jira-issue-fields">
      <Text style={jiraStyles.sectionLabel}>Details</Text>
      {issue.fields.map((field) => (
        <FieldRow
          key={field.fieldId}
          serverId={serverId}
          connectionId={connectionId}
          issue={issue}
          field={field}
        />
      ))}
      {hasTracking ? (
        <View style={styles.fieldRow}>
          <Text style={jiraStyles.formLabel}>Time tracking</Text>
          <Text style={jiraStyles.text}>
            {[
              tracking?.timeSpent ? `${tracking.timeSpent} logged` : null,
              tracking?.remainingEstimate ? `${tracking.remainingEstimate} remaining` : null,
              tracking?.originalEstimate ? `${tracking.originalEstimate} estimated` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  panel: { gap: theme.spacing[3] },
  fieldRow: { gap: theme.spacing[1] },
  value: { paddingVertical: theme.spacing[1] },
  valueEditable: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    marginHorizontal: -theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  link: { fontSize: theme.fontSize.xs, color: theme.colors.accent },
}));
