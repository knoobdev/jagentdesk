import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import type { JiraRemainingEstimate } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, Field, Input } from "../ui/primitives";
import { ValueChip } from "./controls";
import { jiraStyles } from "../ui/styles";
import { useAsyncAction } from "./shared";

// "Log work" (spec 29.3): time spent in Jira duration syntax, when it started, how the remaining
// estimate changes, and an optional Markdown comment.

const REMAINING_CHOICES: ReadonlyArray<{ kind: JiraRemainingEstimate["kind"]; label: string }> = [
  { kind: "auto", label: "Adjust automatically" },
  { kind: "leave", label: "Leave as is" },
  { kind: "new", label: "Set to" },
];

const DURATION = /^(\d+(\.\d+)?[wdhm])(\s+\d+(\.\d+)?[wdhm])*$/;

function localDateTimeText(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalDateTime(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function WorklogForm({
  serverId,
  connectionId,
  issueKey,
  onDone,
}: {
  serverId: string;
  connectionId: string;
  issueKey: string;
  onDone: () => void;
}) {
  const [timeSpent, setTimeSpent] = useState("");
  const [started, setStarted] = useState(() => localDateTimeText(Date.now()));
  const [remainingKind, setRemainingKind] = useState<JiraRemainingEstimate["kind"]>("auto");
  const [remainingValue, setRemainingValue] = useState("");
  const [comment, setComment] = useState("");
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const startedMs = parseLocalDateTime(started);
  const validSpent = DURATION.test(timeSpent.trim());
  const validRemaining = remainingKind !== "new" || DURATION.test(remainingValue.trim());

  const save = useAsyncAction(
    useCallback(async () => {
      if (startedMs === null) throw new Error("Use the form YYYY-MM-DD HH:MM for the start.");
      const remainingEstimate: JiraRemainingEstimate =
        remainingKind === "new"
          ? { kind: "new", value: remainingValue.trim() }
          : { kind: remainingKind };
      await call("jira.issue.worklog.add.request", {
        connectionId,
        issueKey,
        timeSpent: timeSpent.trim(),
        started_ms: startedMs,
        remainingEstimate,
        ...(comment.trim() ? { commentMarkdown: comment.trim() } : {}),
      });
      await invalidate();
      onDone();
    }, [
      call,
      comment,
      connectionId,
      invalidate,
      issueKey,
      onDone,
      remainingKind,
      remainingValue,
      startedMs,
      timeSpent,
    ]),
  );

  const { run } = save;
  const submit = useCallback(() => void run(), [run]);

  return (
    <View style={jiraStyles.sheetBody} testID="jira-worklog-form">
      <Field label="Time spent">
        <Input
          value={timeSpent}
          onChangeText={setTimeSpent}
          placeholder="e.g. 1h 30m"
          testID="jira-worklog-time"
        />
      </Field>
      <Field label="Started">
        <Input
          value={started}
          onChangeText={setStarted}
          placeholder="YYYY-MM-DD HH:MM"
          testID="jira-worklog-started"
        />
      </Field>
      <Field label="Remaining estimate">
        <View style={jiraStyles.rowWrap}>
          {REMAINING_CHOICES.map((choice) => (
            <ValueChip
              key={choice.kind}
              label={choice.label}
              value={choice.kind}
              active={remainingKind === choice.kind}
              onSelect={setRemainingKind}
            />
          ))}
        </View>
        {remainingKind === "new" ? (
          <Input value={remainingValue} onChangeText={setRemainingValue} placeholder="e.g. 2h" />
        ) : null}
      </Field>
      <Field label="Comment">
        <Input
          multiline
          value={comment}
          onChangeText={setComment}
          placeholder="Optional, Markdown"
        />
      </Field>
      {!validSpent && timeSpent.trim() ? (
        <Text style={jiraStyles.errorText}>Use Jira durations such as 45m, 1h 30m or 2d.</Text>
      ) : null}
      {save.error ? <ErrorBanner message={save.error} /> : null}
      <View style={jiraStyles.sheetFooter}>
        <Button size="sm" variant="ghost" onPress={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="default"
          loading={save.pending}
          disabled={!validSpent || !validRemaining || startedMs === null}
          onPress={submit}
          testID="jira-worklog-save"
        >
          Log work
        </Button>
      </View>
    </View>
  );
}
