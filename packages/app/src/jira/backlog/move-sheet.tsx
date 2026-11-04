import { useMemo } from "react";
import { View } from "react-native";
import type { JiraSprint } from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { OptionRow } from "../board/keyed";
import { jiraStyles } from "../ui/styles";

// "Move to…" for backlog rows and the bulk bar: an open sprint or the backlog.

export type BlockId = number | "backlog";

export function MoveToSprintSheet({
  title,
  sprints,
  current,
  onPick,
  onClose,
}: {
  title: string;
  sprints: JiraSprint[];
  current: BlockId | null;
  onPick: (target: BlockId) => void;
  onClose: () => void;
}) {
  const header = useMemo(() => ({ title }), [title]);
  const options = useMemo(() => {
    const targets: Array<{ id: BlockId; label: string }> = [
      ...sprints.map((sprint) => ({ id: sprint.id, label: `${sprint.name} (${sprint.state})` })),
      { id: "backlog", label: "Backlog" },
    ];
    return targets.filter((target) => target.id !== current);
  }, [current, sprints]);
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="jira-move-sprint-sheet">
      <View style={jiraStyles.card}>
        {options.map((target, index) => (
          <OptionRow<BlockId>
            key={String(target.id)}
            value={target.id}
            label={target.label}
            last={index === options.length - 1}
            onPick={onPick}
            testID={`jira-move-sprint-${target.id}`}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}
