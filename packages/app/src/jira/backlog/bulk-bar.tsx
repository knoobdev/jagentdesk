import { useCallback, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  JiraAssignee,
  JiraIssueCard,
  JiraSprint,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { errorMessage, useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { AssignSheet, StatusSheet, type StatusChoice } from "./bulk-sheets";
import { MoveToSprintSheet, type BlockId } from "./move-sheet";

// Bulk actions on the selected backlog issues (spec 29.3): move to a sprint or the backlog, assign,
// change status. Issues are processed one by one (Jira's per-issue write limits); progress and
// every per-issue failure stay visible.

interface Failure {
  key: string;
  message: string;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; label: string; done: number; total: number; failures: Failure[] }
  | { kind: "finished"; label: string; total: number; failures: Failure[] };

type RunEvent =
  | { type: "start"; label: string; total: number }
  | { type: "step"; failure: Failure | null }
  | { type: "finish" }
  | { type: "reset" };

function reduce(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "start":
      return { kind: "running", label: event.label, done: 0, total: event.total, failures: [] };
    case "step":
      if (state.kind !== "running") return state;
      return {
        ...state,
        done: state.done + 1,
        failures: event.failure ? [...state.failures, event.failure] : state.failures,
      };
    case "finish":
      if (state.kind !== "running") return state;
      return { kind: "finished", label: state.label, total: state.total, failures: state.failures };
    case "reset":
      return { kind: "idle" };
  }
}

type Sheet = "move" | "assign" | "status" | null;

export function BulkBar({
  serverId,
  connectionId,
  boardId,
  selected,
  sprints,
  onClear,
}: {
  serverId: string;
  connectionId: string;
  boardId: number;
  selected: JiraIssueCard[];
  sprints: JiraSprint[];
  onClear: () => void;
}) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const [run, dispatch] = useReducer(reduce, { kind: "idle" });
  const [sheet, setSheet] = useState<Sheet>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  const openMove = useCallback(() => setSheet("move"), []);
  const openAssign = useCallback(() => setSheet("assign"), []);
  const openStatus = useCallback(() => setSheet("status"), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  const perIssue = useCallback(
    async (label: string, task: (issue: JiraIssueCard) => Promise<void>) => {
      setSheet(null);
      dispatch({ type: "start", label, total: selected.length });
      for (const issue of selected) {
        try {
          await task(issue);
          dispatch({ type: "step", failure: null });
        } catch (error) {
          dispatch({ type: "step", failure: { key: issue.key, message: errorMessage(error) } });
        }
      }
      dispatch({ type: "finish" });
      await invalidate();
    },
    [invalidate, selected],
  );

  const move = useCallback(
    async (target: BlockId) => {
      const keys = selected.map((issue) => issue.key);
      setSheet(null);
      dispatch({
        type: "start",
        label: target === "backlog" ? "Moved to the backlog" : "Moved to the sprint",
        total: 1,
      });
      try {
        await call("jira.sprints.move_issues.request", {
          connectionId,
          issueKeys: keys,
          target:
            target === "backlog"
              ? { kind: "backlog", boardId }
              : { kind: "sprint", sprintId: target },
        });
        dispatch({ type: "step", failure: null });
      } catch (error) {
        dispatch({ type: "step", failure: { key: keys.join(", "), message: errorMessage(error) } });
      }
      dispatch({ type: "finish" });
      await invalidate();
    },
    [boardId, call, connectionId, invalidate, selected],
  );
  const handleMove = useCallback((target: BlockId) => void move(target), [move]);

  const changeStatus = useCallback(
    (choice: StatusChoice) =>
      void perIssue(`Moved to ${choice.status.name}`, async (issue) => {
        const transition = choice.byIssue.get(issue.key);
        if (!transition) throw new Error(`No transition to ${choice.status.name}.`);
        if (transition.fields.some((field) => field.required)) {
          throw new Error("This transition asks for fields; open the issue to move it.");
        }
        await call("jira.issue.transition.request", {
          connectionId,
          issueKey: issue.key,
          transitionId: transition.id,
        });
      }),
    [call, connectionId, perIssue],
  );

  const assign = useCallback(
    (assignee: JiraAssignee, label: string) =>
      void perIssue(`Assigned to ${label}`, async (issue) => {
        await call("jira.issue.assign.request", { connectionId, issueKey: issue.key, assignee });
      }),
    [call, connectionId, perIssue],
  );

  const running = run.kind === "running";
  return (
    <View style={styles.bar} testID="jira-bulk-bar">
      <View style={jiraStyles.rowWrap}>
        <Text style={jiraStyles.textStrong}>{selected.length} selected</Text>
        <View style={jiraStyles.spacer} />
        <Button
          size="sm"
          variant="outline"
          onPress={openMove}
          disabled={running}
          testID="jira-bulk-move"
        >
          Move to…
        </Button>
        <Button
          size="sm"
          variant="outline"
          onPress={openAssign}
          disabled={running}
          testID="jira-bulk-assign"
        >
          Assign
        </Button>
        <Button
          size="sm"
          variant="outline"
          onPress={openStatus}
          disabled={running}
          testID="jira-bulk-status"
        >
          Change status
        </Button>
        <Button size="sm" variant="ghost" onPress={onClear} disabled={running}>
          Clear
        </Button>
      </View>
      <RunReport run={run} onDismiss={reset} />
      {sheet === "move" ? (
        <MoveToSprintSheet
          title={`Move ${selected.length} issue(s) to…`}
          sprints={sprints}
          current={null}
          onPick={handleMove}
          onClose={closeSheet}
        />
      ) : null}
      {sheet === "assign" ? (
        <AssignSheet
          serverId={serverId}
          connectionId={connectionId}
          issues={selected}
          onClose={closeSheet}
          onPick={assign}
        />
      ) : null}
      {sheet === "status" ? (
        <StatusSheet
          serverId={serverId}
          connectionId={connectionId}
          issues={selected}
          onClose={closeSheet}
          onPick={changeStatus}
        />
      ) : null}
    </View>
  );
}

function RunReport({ run, onDismiss }: { run: RunState; onDismiss: () => void }) {
  if (run.kind === "running") {
    return (
      <Text style={jiraStyles.textMuted} testID="jira-bulk-progress">
        {run.label}… {run.done}/{run.total}
      </Text>
    );
  }
  if (run.kind !== "finished") return null;
  return (
    <View style={styles.result}>
      <Text style={jiraStyles.textMuted} testID="jira-bulk-result">
        {run.label}: {run.total - run.failures.length} of {run.total} done.
      </Text>
      {run.failures.map((failure) => (
        <ErrorBanner key={failure.key} message={`${failure.key}: ${failure.message}`} />
      ))}
      <Button size="sm" variant="ghost" onPress={onDismiss}>
        Dismiss
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  bar: {
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[4],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface1,
  },
  result: { gap: theme.spacing[2] },
}));
