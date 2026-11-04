import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, MoreHorizontal } from "lucide-react-native";
import type { JiraIssueCard } from "@jagentdesk/protocol/jira/rpc-schemas";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import {
  IconButton,
  IssueTypeIcon,
  PriorityIcon,
  StatusLozenge,
  UserAvatar,
} from "../ui/primitives";

// One backlog row (spec 29.3): select box, type, key, summary, status, assignee, estimate.

const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedCheck = withUnistyles(Check, (theme) => ({ color: theme.colors.palette.white }));

export const BacklogRow = memo(function BacklogRow({
  issue,
  selected,
  last,
  onToggle,
  onOpen,
  onMove,
}: {
  issue: JiraIssueCard;
  selected: boolean;
  last: boolean;
  onToggle: (issueKey: string) => void;
  onOpen: (issueKey: string) => void;
  onMove: (issue: JiraIssueCard) => void;
}) {
  const toggle = useCallback(() => onToggle(issue.key), [issue.key, onToggle]);
  const open = useCallback(() => onOpen(issue.key), [issue.key, onOpen]);
  const move = useCallback(() => onMove(issue), [issue, onMove]);
  const checkState = useMemo(() => ({ checked: selected }), [selected]);
  // Phones stack the title over the details so the summary stays readable.
  const isCompact = useIsCompactFormFactor();
  return (
    <View style={last ? styles.rowLast : styles.row} testID={`jira-backlog-row-${issue.key}`}>
      <Pressable
        onPress={toggle}
        style={selected ? styles.checkboxOn : styles.checkbox}
        accessibilityRole="checkbox"
        accessibilityState={checkState}
        accessibilityLabel={`Select ${issue.key}`}
        hitSlop={6}
        testID={`jira-backlog-select-${issue.key}`}
      >
        {selected ? <ThemedCheck size={12} /> : null}
      </Pressable>
      <Pressable
        style={isCompact ? styles.mainStacked : styles.main}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`${issue.key} ${issue.summary}`}
      >
        <View style={styles.titleLine}>
          <IssueTypeIcon type={issue.type} />
          <Text style={styles.key}>{issue.key}</Text>
          <Text style={styles.summary} numberOfLines={isCompact ? 2 : 1}>
            {issue.summary}
          </Text>
        </View>
        <View style={styles.metaLine}>
          {issue.parent ? (
            <Text style={styles.parent} numberOfLines={1}>
              {issue.parent.summary}
            </Text>
          ) : null}
          <StatusLozenge status={issue.status} />
          <PriorityIcon priority={issue.priority} />
          <View style={styles.estimate}>
            <Text style={styles.estimateText}>{issue.estimate ?? "–"}</Text>
          </View>
          <UserAvatar user={issue.assignee} size={22} />
        </View>
      </Pressable>
      <IconButton
        icon={ThemedMore}
        label={`Move ${issue.key} to…`}
        onPress={move}
        testID={`jira-backlog-move-${issue.key}`}
      />
    </View>
  );
});

const row = (theme: Theme) =>
  ({
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.surface0,
  }) as const;

const checkbox = (theme: Theme) =>
  ({
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    ...row(theme),
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  rowLast: row(theme),
  checkbox: checkbox(theme),
  checkboxOn: {
    ...checkbox(theme),
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  main: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  mainStacked: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  titleLine: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  key: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  summary: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  parent: {
    maxWidth: 140,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.purple[600],
  },
  estimate: {
    minWidth: 22,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
  },
  estimateText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
}));
