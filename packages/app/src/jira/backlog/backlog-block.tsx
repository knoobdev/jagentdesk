import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { JiraIssueCard, JiraSprint } from "@jagentdesk/protocol/jira/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { Draggable, DropZone } from "../board/dnd";
import { jiraStyles } from "../ui/styles";
import { BacklogRow } from "./backlog-row";
import { SprintActions, type BacklogDialog } from "./backlog-dialogs";
import type { BlockId } from "./move-sheet";

// One block of the backlog page: a sprint (with its actions) or the Backlog itself. On web, rows
// drag within and between blocks (BacklogView handles the drop).

export const BLOCK_DROP_PREFIX = "block:";

export function blockDropId(id: BlockId): string {
  return `${BLOCK_DROP_PREFIX}${id}`;
}

export function parseBlockDropId(dropId: string): BlockId | null {
  if (!dropId.startsWith(BLOCK_DROP_PREFIX)) return null;
  const raw = dropId.slice(BLOCK_DROP_PREFIX.length);
  if (raw === "backlog") return "backlog";
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}

function estimateSum(issues: JiraIssueCard[]): number {
  return issues.reduce((sum, issue) => sum + (issue.estimate ?? 0), 0);
}

export function BacklogBlock({
  id,
  sprint,
  meta,
  issues,
  selected,
  testID,
  onToggle,
  onOpen,
  onMove,
  onDialog,
}: {
  id: BlockId;
  sprint: JiraSprint | null;
  meta: string | null;
  issues: JiraIssueCard[];
  selected: ReadonlySet<string>;
  testID: string;
  onToggle: (issueKey: string) => void;
  onOpen: (issueKey: string) => void;
  onMove: (issue: JiraIssueCard) => void;
  onDialog: (dialog: BacklogDialog) => void;
}) {
  const points = estimateSum(issues);
  const title = sprint ? sprint.name : "Backlog";
  const goal = sprint?.goal ?? null;
  const renderZone = useCallback(
    (isOver: boolean) => (
      <View style={isOver ? styles.blockOver : styles.block} testID={testID}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <View style={jiraStyles.rowWrap}>
              <Text style={jiraStyles.textStrong}>{title}</Text>
              {meta ? <Text style={jiraStyles.textSmall}>{meta}</Text> : null}
              <Text style={jiraStyles.textSmall}>
                {issues.length === 1 ? "1 issue" : `${issues.length} issues`}
                {points > 0 ? ` · ${points} pts` : ""}
              </Text>
            </View>
            {goal ? (
              <Text style={jiraStyles.textMuted} numberOfLines={2}>
                {goal}
              </Text>
            ) : null}
          </View>
          <SprintActions sprint={sprint} issues={issues} onDialog={onDialog} />
        </View>
        {issues.length === 0 ? (
          <Text style={styles.empty}>
            {id === "backlog" ? "The backlog is empty." : "Drag issues here or use Move to…"}
          </Text>
        ) : null}
        {issues.map((issue, index) => (
          <Draggable key={issue.key} id={issue.key}>
            <BacklogRow
              issue={issue}
              selected={selected.has(issue.key)}
              last={index === issues.length - 1}
              onToggle={onToggle}
              onOpen={onOpen}
              onMove={onMove}
            />
          </Draggable>
        ))}
      </View>
    ),
    [
      goal,
      id,
      issues,
      meta,
      onDialog,
      onMove,
      onOpen,
      onToggle,
      points,
      selected,
      sprint,
      testID,
      title,
    ],
  );
  return <DropZone id={blockDropId(id)}>{renderZone}</DropZone>;
}

const block = (theme: Theme) =>
  ({
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  block: block(theme),
  blockOver: { ...block(theme), borderColor: theme.colors.accent },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerText: { flex: 1, minWidth: 0, gap: 2 },
  empty: {
    padding: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface0,
  },
}));
