import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import type {
  JiraFieldInput,
  JiraFieldView,
  JiraStatus,
  JiraTransition,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { JiraRpcError, errorMessage, useJiraCall } from "../api";
import { useJiraInvalidate, useJiraTransitions } from "../queries";
import { ErrorBanner, Field, Input, StatusLozenge, tint } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { ValueRow, Spinner } from "./controls";
import { FieldEditor, initialInput, isMissing } from "./field-editor";

const ThemedChevronDown = withUnistyles(ChevronDown);

// The status control of the issue header: the transitions Jira allows now; a transition with a
// screen shows its fields (required first) before it runs (spec 29.3, criterion 4).

type Drafts = Record<string, JiraFieldInput | null>;

interface Props {
  serverId: string;
  connectionId: string;
  issueKey: string;
  status: JiraStatus;
}

function initialDrafts(transition: JiraTransition): Drafts {
  return Object.fromEntries(transition.fields.map((field) => [field.fieldId, initialInput(field)]));
}

function filledFields(drafts: Drafts): Record<string, JiraFieldInput> {
  const entries = Object.entries(drafts).filter(
    (entry): entry is [string, JiraFieldInput] => entry[1] !== null && !isMissing(entry[1]),
  );
  return Object.fromEntries(entries);
}

function ScreenField({
  field,
  drafts,
  onDraft,
  error,
  serverId,
  connectionId,
  issueKey,
}: {
  field: JiraFieldView;
  drafts: Drafts;
  onDraft: (fieldId: string, value: JiraFieldInput) => void;
  error: string | undefined;
  serverId: string;
  connectionId: string;
  issueKey: string;
}) {
  const change = useCallback(
    (value: JiraFieldInput) => onDraft(field.fieldId, value),
    [field.fieldId, onDraft],
  );
  return (
    <Field label={`${field.name}${field.required ? " *" : ""}`}>
      <FieldEditor
        field={field}
        value={drafts[field.fieldId] ?? null}
        onChange={change}
        serverId={serverId}
        connectionId={connectionId}
        issueKey={issueKey}
      />
      {error ? <Text style={jiraStyles.errorText}>{error}</Text> : null}
    </Field>
  );
}

export function TransitionMenu({ serverId, connectionId, issueKey, status }: Props) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<JiraTransition | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const transitions = useJiraTransitions(serverId, connectionId, open ? issueKey : null);

  const show = useCallback(() => setOpen(true), []);
  const back = useCallback(() => setChosen(null), []);
  const close = useCallback(() => {
    setOpen(false);
    setChosen(null);
    setError(null);
    setFieldErrors({});
    setComment("");
  }, []);
  const setDraft = useCallback((fieldId: string, value: JiraFieldInput) => {
    setDrafts((current) => ({ ...current, [fieldId]: value }));
  }, []);

  const run = useCallback(
    async (transition: JiraTransition, fields: Drafts) => {
      setPending(true);
      setError(null);
      setFieldErrors({});
      try {
        const filled = filledFields(fields);
        await call("jira.issue.transition.request", {
          connectionId,
          issueKey,
          transitionId: transition.id,
          ...(Object.keys(filled).length > 0 ? { fields: filled } : {}),
          ...(comment.trim() ? { commentMarkdown: comment.trim() } : {}),
        });
        await invalidate();
        close();
      } catch (caught) {
        if (caught instanceof JiraRpcError) setFieldErrors(caught.fieldErrors);
        setError(errorMessage(caught));
        // A rejected direct transition may need its screen: show it so the user can fill it in.
        setChosen(transition);
      } finally {
        setPending(false);
      }
    },
    [call, close, comment, connectionId, invalidate, issueKey],
  );

  const choose = useCallback(
    (transition: JiraTransition) => {
      const initial = initialDrafts(transition);
      setDrafts(initial);
      if (transition.fields.length === 0) {
        void run(transition, initial);
        return;
      }
      setChosen(transition);
    },
    [run],
  );
  const submit = useCallback(() => {
    if (chosen) void run(chosen, drafts);
  }, [chosen, drafts, run]);

  const header = useMemo(() => ({ title: chosen ? chosen.name : "Change status" }), [chosen]);
  const missingRequired = chosen
    ? chosen.fields.some((field) => field.required && isMissing(drafts[field.fieldId] ?? null))
    : false;

  return (
    <>
      <Pressable
        style={jiraStyles.row}
        onPress={show}
        accessibilityRole="button"
        accessibilityLabel={`Status ${status.name}. Change status`}
        testID="jira-issue-status"
      >
        <StatusLozenge status={status} />
        <ThemedChevronDown size={14} uniProps={tint.muted} />
      </Pressable>
      <AdaptiveModalSheet
        header={header}
        visible={open}
        onClose={close}
        testID="jira-transition-sheet"
      >
        <View style={jiraStyles.sheetBody}>
          {transitions.isLoading ? <Spinner /> : null}
          {transitions.error ? <ErrorBanner message={errorMessage(transitions.error)} /> : null}
          {error ? <ErrorBanner message={error} /> : null}
          {chosen ? (
            <View style={jiraStyles.sheetBody}>
              {chosen.fields.map((field) => (
                <ScreenField
                  key={field.fieldId}
                  field={field}
                  drafts={drafts}
                  onDraft={setDraft}
                  error={fieldErrors[field.fieldId]}
                  serverId={serverId}
                  connectionId={connectionId}
                  issueKey={issueKey}
                />
              ))}
              <Field label="Comment">
                <Input
                  multiline
                  value={comment}
                  onChangeText={setComment}
                  placeholder="Optional, Markdown"
                />
              </Field>
              <View style={jiraStyles.sheetFooter}>
                <Button variant="ghost" onPress={back}>
                  Back
                </Button>
                <Button
                  variant="default"
                  loading={pending}
                  disabled={missingRequired}
                  onPress={submit}
                  testID="jira-transition-submit"
                >
                  {chosen.name}
                </Button>
              </View>
            </View>
          ) : (
            (transitions.data ?? []).map((transition) => (
              <ValueRow
                key={transition.id}
                value={transition}
                onSelect={choose}
                disabled={pending}
                accessibilityLabel={transition.name}
                testID={`jira-transition-${transition.id}`}
              >
                <Text style={jiraStyles.text}>{transition.name}</Text>
                <View style={jiraStyles.spacer} />
                <StatusLozenge status={transition.to} />
              </ValueRow>
            ))
          )}
          {pending && !chosen ? <Spinner /> : null}
        </View>
      </AdaptiveModalSheet>
    </>
  );
}
