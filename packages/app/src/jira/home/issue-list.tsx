import { Text, View } from "react-native";
import type { JiraIssueCard } from "@jagentdesk/protocol/jira/rpc-schemas";
import {
  IssueTypeIcon,
  PressableRow,
  PriorityIcon,
  StatusLozenge,
  UserAvatar,
} from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// A compact issue table for Your work and Search.

export function IssueList({
  issues,
  onOpenIssue,
  testID,
}: {
  issues: JiraIssueCard[];
  onOpenIssue: (issueKey: string) => void;
  testID?: string;
}) {
  return (
    <View style={jiraStyles.card} testID={testID}>
      {issues.map((issue, index) => (
        <PressableRow
          key={issue.id}
          value={issue.key}
          onPick={onOpenIssue}
          last={index === issues.length - 1}
          testID={`jira-row-${issue.key}`}
        >
          <IssueTypeIcon type={issue.type} />
          <Text style={jiraStyles.mono}>{issue.key}</Text>
          <Text style={jiraStyles.mainText} numberOfLines={1}>
            {issue.summary}
          </Text>
          <PriorityIcon priority={issue.priority} />
          <StatusLozenge status={issue.status} />
          <UserAvatar user={issue.assignee} size={22} />
        </PressableRow>
      ))}
    </View>
  );
}
