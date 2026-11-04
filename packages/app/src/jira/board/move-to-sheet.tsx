import { useMemo } from "react";
import { Text, View } from "react-native";
import type { JiraBoardColumn, JiraIssueCard } from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { jiraStyles } from "../ui/styles";
import { OptionRow } from "./keyed";

// "Move to…" (spec 29.3, criterion 8): the column picker that replaces dragging on mobile and is
// also offered on desktop. Choosing a column runs the same transition flow as a drop.

export function MoveToColumnSheet({
  issue,
  columns,
  onPick,
  onClose,
}: {
  issue: JiraIssueCard;
  columns: JiraBoardColumn[];
  onPick: (columnIndex: number) => void;
  onClose: () => void;
}) {
  const header = useMemo(() => ({ title: `Move ${issue.key} to…` }), [issue.key]);
  const options = useMemo(
    () =>
      columns
        .map((column, index) => ({ column, index }))
        .filter(({ column }) => !column.statusIds.includes(issue.status.id)),
    [columns, issue.status.id],
  );
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="jira-move-to-sheet">
      <View style={jiraStyles.sheetBody}>
        <Text style={jiraStyles.textMuted} numberOfLines={2}>
          {issue.summary}
        </Text>
        <View style={jiraStyles.card}>
          {options.map(({ column, index }, position) => (
            <OptionRow
              key={column.name}
              value={index}
              label={column.name}
              last={position === options.length - 1}
              onPick={onPick}
              testID={`jira-move-to-${index}`}
            />
          ))}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}
