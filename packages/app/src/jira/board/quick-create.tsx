import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import type { JiraIssueCard } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import type { Theme } from "@/styles/theme";
import { useJiraCall } from "../api";
import { jiraKeys, useJiraInvalidate } from "../queries";
import { ErrorBanner, Input, tint } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { KeyedChip } from "./keyed";
import { useAction } from "./use-action";

// Quick create at the bottom of a column (spec 29.3 "Tạo nhanh issue trong cột"): summary + type,
// created in the board's project (and the active sprint on Scrum). The caller moves it into the
// column afterwards when the column is not the first one.

const ThemedPlus = withUnistyles(Plus);

function useBoardProject(
  serverId: string,
  connectionId: string,
  boardId: number,
  enabled: boolean,
) {
  const call = useJiraCall(serverId);
  return useFetchQuery({
    queryKey: [...jiraKeys.boardAny(serverId, connectionId, boardId), "create-meta"],
    queryFn: async () => {
      const { board } = await call("jira.boards.get.request", { connectionId, boardId });
      const projectKey = board?.projectKey;
      if (!projectKey) throw new Error("This board has no project to create issues in.");
      const meta = await call("jira.issue.create_meta.request", { connectionId, projectKey });
      const types = meta.issueTypes.filter((type) => !type.subtask && type.name !== "Epic");
      return { projectKey, types };
    },
    dataShape: "value",
    staleTimeMs: 5 * 60_000,
    enabled,
  });
}

interface QuickCreateProps {
  serverId: string;
  connectionId: string;
  boardId: number;
  sprintId: number | null;
  columnIndex: number;
  onCreated: (issue: JiraIssueCard, columnIndex: number) => void;
}

function CreateForm({
  serverId,
  connectionId,
  boardId,
  sprintId,
  columnIndex,
  onCreated,
  onCancel,
}: QuickCreateProps & { onCancel: () => void }) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const project = useBoardProject(serverId, connectionId, boardId, true);
  const { run, pending, error } = useAction();
  const [summary, setSummary] = useState("");
  const [typeId, setTypeId] = useState<string | null>(null);
  const types = project.data?.types ?? [];
  const selectedType = typeId ?? types[0]?.id ?? null;
  const projectKey = project.data?.projectKey ?? null;

  const create = useCallback(() => {
    if (!projectKey || !selectedType || !summary.trim()) return;
    void run(async () => {
      const { issue } = await call("jira.issue.create.request", {
        connectionId,
        projectKey,
        issueTypeId: selectedType,
        summary: summary.trim(),
        ...(sprintId !== null ? { sprintId } : {}),
      });
      await invalidate();
      setSummary("");
      if (issue) onCreated(issue, columnIndex);
    });
  }, [
    call,
    columnIndex,
    connectionId,
    invalidate,
    onCreated,
    projectKey,
    run,
    selectedType,
    sprintId,
    summary,
  ]);

  return (
    <View style={styles.form} testID={`jira-quick-create-form-${columnIndex}`}>
      {project.error ? <ErrorBanner message={project.error.message} /> : null}
      {error ? <ErrorBanner message={error} /> : null}
      <Input
        value={summary}
        onChangeText={setSummary}
        placeholder="What needs to be done?"
        autoFocus
        onSubmitEditing={create}
        testID={`jira-quick-create-summary-${columnIndex}`}
      />
      <View style={jiraStyles.rowWrap}>
        {types.map((type) => (
          <KeyedChip
            key={type.id}
            value={type.id}
            label={type.name}
            active={type.id === selectedType}
            onToggle={setTypeId}
            issueType={type}
          />
        ))}
      </View>
      <View style={jiraStyles.sheetFooter}>
        <Button variant="ghost" size="sm" onPress={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={create}
          loading={pending}
          disabled={!summary.trim() || !selectedType}
          testID={`jira-quick-create-submit-${columnIndex}`}
        >
          Create
        </Button>
      </View>
    </View>
  );
}

export function QuickCreate(props: QuickCreateProps) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  if (open) return <CreateForm {...props} onCancel={hide} />;
  return (
    <Pressable
      style={styles.trigger}
      onPress={show}
      accessibilityRole="button"
      testID={`jira-quick-create-${props.columnIndex}`}
    >
      <ThemedPlus size={14} uniProps={tint.muted} />
      <Text style={jiraStyles.textMuted}>Create issue</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  form: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
}));
