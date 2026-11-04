import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { JiraSprint } from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, Field, Input } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { useAction } from "../board/use-action";

// Create sprint and Start sprint (spec 29.3 backlog: "tạo/bắt đầu/hoàn thành sprint (ngày, goal)").
// Dates are entered as YYYY-MM-DD in the device's time zone.

const DAY_MS = 86_400_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function toDateInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a YYYY-MM-DD string, or null when it is not a date. */
export function parseDateInput(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const ms = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function formatSprintDates(sprint: JiraSprint): string | null {
  if (sprint.startDate_ms === null || sprint.endDate_ms === null) return null;
  const format = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${format(sprint.startDate_ms)} – ${format(sprint.endDate_ms)}`;
}

function DialogFooter({
  pending,
  disabled,
  label,
  onCancel,
  onSubmit,
  testID,
}: {
  pending: boolean;
  disabled: boolean;
  label: string;
  onCancel: () => void;
  onSubmit: () => void;
  testID: string;
}) {
  return (
    <View style={jiraStyles.sheetFooter}>
      <Button variant="ghost" onPress={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button
        variant="default"
        onPress={onSubmit}
        loading={pending}
        disabled={disabled}
        testID={testID}
      >
        {label}
      </Button>
    </View>
  );
}

export function StartSprintDialog({
  serverId,
  connectionId,
  sprint,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  sprint: JiraSprint;
  onClose: () => void;
}) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const { run, pending, error } = useAction();
  const now = Date.now();
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal ?? "");
  const [start, setStart] = useState(toDateInput(sprint.startDate_ms ?? now));
  const [end, setEnd] = useState(toDateInput(sprint.endDate_ms ?? now + 14 * DAY_MS));
  const header = useMemo(() => ({ title: `Start ${sprint.name}` }), [sprint.name]);
  const startMs = parseDateInput(start);
  const endMs = parseDateInput(end);
  const datesValid = startMs !== null && endMs !== null && endMs > startMs;

  const submit = useCallback(async () => {
    if (startMs === null || endMs === null) return;
    const ok = await run(async () => {
      await call("jira.sprints.start.request", {
        connectionId,
        sprintId: sprint.id,
        name: name.trim() || sprint.name,
        goal: goal.trim(),
        startDate_ms: startMs,
        endDate_ms: endMs,
      });
      await invalidate();
    });
    if (ok) onClose();
  }, [
    call,
    connectionId,
    endMs,
    goal,
    invalidate,
    name,
    onClose,
    run,
    sprint.id,
    sprint.name,
    startMs,
  ]);
  const handleSubmit = useCallback(() => void submit(), [submit]);
  const footer = useMemo(
    () => (
      <DialogFooter
        pending={pending}
        disabled={!datesValid}
        label="Start sprint"
        onCancel={onClose}
        onSubmit={handleSubmit}
        testID="jira-start-sprint-submit"
      />
    ),
    [datesValid, handleSubmit, onClose, pending],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      testID="jira-start-sprint-dialog"
    >
      <View style={jiraStyles.sheetBody}>
        {error ? <ErrorBanner message={error} /> : null}
        <Field label="Sprint name">
          <Input value={name} onChangeText={setName} testID="jira-start-sprint-name" />
        </Field>
        <Field label="Start date">
          <Input
            value={start}
            onChangeText={setStart}
            placeholder="YYYY-MM-DD"
            testID="jira-start-sprint-start"
          />
        </Field>
        <Field label="End date">
          <Input
            value={end}
            onChangeText={setEnd}
            placeholder="YYYY-MM-DD"
            testID="jira-start-sprint-end"
          />
        </Field>
        {!datesValid ? (
          <Text style={jiraStyles.errorText}>The end date must come after the start date.</Text>
        ) : null}
        <Field label="Sprint goal">
          <Input value={goal} onChangeText={setGoal} multiline testID="jira-start-sprint-goal" />
        </Field>
      </View>
    </AdaptiveModalSheet>
  );
}

export function CreateSprintDialog({
  serverId,
  connectionId,
  boardId,
  suggestedName,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  boardId: number;
  suggestedName: string;
  onClose: () => void;
}) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const { run, pending, error } = useAction();
  const [name, setName] = useState(suggestedName);
  const [goal, setGoal] = useState("");
  const header = useMemo(() => ({ title: "Create sprint" }), []);

  const submit = useCallback(async () => {
    const ok = await run(async () => {
      await call("jira.sprints.create.request", {
        connectionId,
        boardId,
        name: name.trim(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      });
      await invalidate();
    });
    if (ok) onClose();
  }, [boardId, call, connectionId, goal, invalidate, name, onClose, run]);
  const handleSubmit = useCallback(() => void submit(), [submit]);
  const footer = useMemo(
    () => (
      <DialogFooter
        pending={pending}
        disabled={name.trim().length === 0}
        label="Create"
        onCancel={onClose}
        onSubmit={handleSubmit}
        testID="jira-create-sprint-submit"
      />
    ),
    [handleSubmit, name, onClose, pending],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      testID="jira-create-sprint-dialog"
    >
      <View style={jiraStyles.sheetBody}>
        {error ? <ErrorBanner message={error} /> : null}
        <Field label="Sprint name">
          <Input value={name} onChangeText={setName} testID="jira-create-sprint-name" />
        </Field>
        <Field label="Sprint goal">
          <Input value={goal} onChangeText={setGoal} multiline />
        </Field>
      </View>
    </AdaptiveModalSheet>
  );
}
