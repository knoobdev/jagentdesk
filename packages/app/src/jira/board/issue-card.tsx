import { memo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MoreHorizontal } from "lucide-react-native";
import type { JiraIssueCard } from "@jagentdesk/protocol/jira/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { Spinner } from "./spinner";
import { FlagIcon, IconButton, IssueTypeIcon, PriorityIcon, UserAvatar } from "../ui/primitives";

// A board card (spec 29.3): key, summary, type, priority, assignee, estimate, epic/parent, labels.

const ThemedMore = withUnistyles(MoreHorizontal);

export const IssueCard = memo(function IssueCard({
  issue,
  busy,
  onOpen,
  onMove,
}: {
  issue: JiraIssueCard;
  busy: boolean;
  onOpen: (issueKey: string) => void;
  onMove: (issue: JiraIssueCard) => void;
}) {
  const open = useCallback(() => onOpen(issue.key), [issue.key, onOpen]);
  const move = useCallback(() => onMove(issue), [issue, onMove]);
  return (
    <Pressable
      style={issue.flagged ? styles.cardFlagged : styles.card}
      onPress={open}
      onLongPress={move}
      accessibilityRole="button"
      accessibilityLabel={`${issue.key} ${issue.summary}`}
      testID={`jira-card-${issue.key}`}
    >
      <Text style={styles.summary} numberOfLines={2}>
        {issue.summary}
      </Text>
      {issue.parent ? (
        <View style={styles.parent}>
          <Text style={styles.parentText} numberOfLines={1}>
            {issue.parent.key} {issue.parent.summary}
          </Text>
        </View>
      ) : null}
      {issue.labels.length > 0 ? (
        <View style={styles.labels}>
          {issue.labels.slice(0, 3).map((label) => (
            <View key={label} style={styles.label}>
              <Text style={styles.labelText} numberOfLines={1}>
                {label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.footer}>
        <IssueTypeIcon type={issue.type} />
        <Text style={styles.key}>{issue.key}</Text>
        {issue.flagged ? <FlagIcon /> : null}
        <View style={styles.spacer} />
        {busy ? <Spinner size="small" /> : null}
        <PriorityIcon priority={issue.priority} />
        {issue.estimate !== null ? (
          <View style={styles.estimate}>
            <Text style={styles.estimateText}>{issue.estimate}</Text>
          </View>
        ) : null}
        <UserAvatar user={issue.assignee} size={22} />
        <IconButton
          icon={ThemedMore}
          label={`Move ${issue.key} to…`}
          onPress={move}
          testID={`jira-card-move-${issue.key}`}
        />
      </View>
    </Pressable>
  );
});

// The card renders as a <button> on web, which shrinks to its content unless given a width.
const card = (theme: Theme) =>
  ({
    width: "100%",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  card: card(theme),
  cardFlagged: { ...card(theme), borderColor: theme.colors.palette.amber[500], borderLeftWidth: 3 },
  summary: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  parent: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  parentText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.purple[600],
  },
  labels: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  label: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  labelText: { fontSize: 11, color: theme.colors.foregroundMuted },
  footer: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  key: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  spacer: { flex: 1 },
  estimate: {
    minWidth: 20,
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
