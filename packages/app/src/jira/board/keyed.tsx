import { useCallback, useMemo } from "react";
import type { JiraIssueType, JiraStatus } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Pressable, Text } from "react-native";
import { Chip, IssueTypeIcon, StatusLozenge } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// List rows and chips that report which value was picked, so lists pass one stable handler
// instead of a closure per item.

export function OptionRow<T extends string | number>({
  value,
  label,
  last,
  selected,
  onPick,
  status,
  detail,
  testID,
}: {
  value: T;
  label: string;
  last: boolean;
  selected?: boolean;
  onPick: (value: T) => void;
  /** Shown as a lozenge at the end of the row. */
  status?: JiraStatus;
  /** Muted text at the end of the row. */
  detail?: string;
  testID?: string;
}) {
  const handlePress = useCallback(() => onPick(value), [onPick, value]);
  const state = useMemo(() => ({ selected: selected === true }), [selected]);
  return (
    <Pressable
      style={last ? jiraStyles.listRowLast : jiraStyles.listRow}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={state}
      testID={testID}
    >
      <Text style={[selected ? jiraStyles.textStrong : jiraStyles.text, jiraStyles.spacer]}>
        {label}
      </Text>
      {detail ? <Text style={jiraStyles.textSmall}>{detail}</Text> : null}
      {status ? <StatusLozenge status={status} /> : null}
    </Pressable>
  );
}

export function KeyedChip<T extends string | number>({
  value,
  label,
  active,
  onToggle,
  issueType,
  testID,
}: {
  value: T;
  label: string;
  active: boolean;
  onToggle: (value: T) => void;
  /** Shows the issue type icon before the label. */
  issueType?: JiraIssueType;
  testID?: string;
}) {
  const handlePress = useCallback(() => onToggle(value), [onToggle, value]);
  const leading = useMemo(
    () => (issueType ? <IssueTypeIcon type={issueType} size={12} /> : undefined),
    [issueType],
  );
  return (
    <Chip label={label} active={active} onPress={handlePress} leading={leading} testID={testID} />
  );
}
