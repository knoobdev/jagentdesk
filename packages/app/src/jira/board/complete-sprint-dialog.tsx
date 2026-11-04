import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { JiraSprint, JiraSprintDestination } from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useJiraCall } from "../api";
import { useJiraInvalidate, useJiraSprints } from "../queries";
import { ErrorBanner, Field, Input } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { OptionRow } from "./keyed";
import { useAction } from "./use-action";

// Complete sprint (spec 29.3): the user picks where the open issues go; the daemon moves them
// before closing the sprint (Jira's REST complete has no such option).

type Choice = { kind: "backlog" } | { kind: "sprint"; sprintId: number } | { kind: "new_sprint" };

function choiceKey(choice: Choice): string {
  return choice.kind === "sprint" ? `sprint:${choice.sprintId}` : choice.kind;
}

export function CompleteSprintDialog({
  serverId,
  connectionId,
  boardId,
  sprint,
  openIssueCount,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  boardId: number;
  sprint: JiraSprint;
  openIssueCount: number;
  onClose: () => void;
}) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const sprints = useJiraSprints(serverId, connectionId, boardId);
  const { run, pending, error } = useAction();
  const [choice, setChoice] = useState<Choice>({ kind: "backlog" });
  const [newName, setNewName] = useState(`${sprint.name} (continued)`);
  const header = useMemo(() => ({ title: `Complete ${sprint.name}` }), [sprint.name]);
  const choices = useMemo<Array<{ choice: Choice; label: string }>>(() => {
    const future = (sprints.data ?? []).filter((candidate) => candidate.state === "future");
    return [
      { choice: { kind: "backlog" }, label: "Backlog" },
      ...future.map((candidate) => ({
        choice: { kind: "sprint" as const, sprintId: candidate.id },
        label: candidate.name,
      })),
      { choice: { kind: "new_sprint" }, label: "New sprint" },
    ];
  }, [sprints.data]);

  const submit = useCallback(async () => {
    let destination: JiraSprintDestination = { kind: "backlog" };
    if (choice.kind === "sprint") destination = choice;
    if (choice.kind === "new_sprint") destination = { kind: "new_sprint", name: newName.trim() };
    const ok = await run(async () => {
      await call("jira.sprints.complete.request", {
        connectionId,
        boardId,
        sprintId: sprint.id,
        incompleteDestination: destination,
      });
      await invalidate();
    });
    if (ok) onClose();
  }, [run, boardId, call, choice, connectionId, invalidate, newName, onClose, sprint.id]);
  const handleSubmit = useCallback(() => void submit(), [submit]);
  const pickChoice = useCallback(
    (key: string) => {
      const entry = choices.find((candidate) => choiceKey(candidate.choice) === key);
      if (entry) setChoice(entry.choice);
    },
    [choices],
  );

  const footer = useMemo(
    () => (
      <View style={jiraStyles.sheetFooter}>
        <Button variant="ghost" onPress={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="default"
          onPress={handleSubmit}
          loading={pending}
          disabled={choice.kind === "new_sprint" && newName.trim().length === 0}
          testID="jira-complete-sprint-submit"
        >
          Complete sprint
        </Button>
      </View>
    ),
    [pending, choice.kind, handleSubmit, newName, onClose],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      testID="jira-complete-sprint-dialog"
    >
      <View style={jiraStyles.sheetBody}>
        {error ? <ErrorBanner message={error} /> : null}
        <Text style={jiraStyles.text}>
          {openIssueCount === 1 ? "1 open issue" : `${openIssueCount} open issues`} will move to:
        </Text>
        <View style={jiraStyles.card}>
          {choices.map((entry, index) => (
            <OptionRow
              key={choiceKey(entry.choice)}
              value={choiceKey(entry.choice)}
              label={entry.label}
              last={index === choices.length - 1}
              selected={choiceKey(entry.choice) === choiceKey(choice)}
              onPick={pickChoice}
              testID={`jira-complete-destination-${choiceKey(entry.choice)}`}
            />
          ))}
        </View>
        {choice.kind === "new_sprint" ? (
          <Field label="New sprint name">
            <Input value={newName} onChangeText={setNewName} testID="jira-complete-new-sprint" />
          </Field>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}
