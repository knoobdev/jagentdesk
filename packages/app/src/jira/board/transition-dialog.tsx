import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { JiraTransition } from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { draftToInputs, FieldInput, initialDraft, type FieldDraft } from "./field-inputs";
import { OptionRow } from "./keyed";
import type { TransitionFlow, TransitionTarget } from "./transition-flow";

// The two dialogs of the transition flow: pick one of several transitions into a column, and the
// transition screen with its required fields (spec 29.7 criterion 4).

function ChooseTransitionSheet({
  flow,
  target,
  transitions,
}: {
  flow: TransitionFlow;
  target: TransitionTarget;
  transitions: JiraTransition[];
}) {
  const header = useMemo(
    () => ({ title: `Move ${target.issue.key} to ${target.column.name}` }),
    [target.issue.key, target.column.name],
  );
  const { choose, cancel } = flow;
  const pick = useCallback(
    (transitionId: string) => {
      const transition = transitions.find((candidate) => candidate.id === transitionId);
      if (transition) void choose(target, transition);
    },
    [choose, target, transitions],
  );
  return (
    <AdaptiveModalSheet visible onClose={cancel} header={header} testID="jira-transition-choose">
      <View style={jiraStyles.sheetBody}>
        <Text style={jiraStyles.textMuted}>Several transitions lead to this column. Pick one.</Text>
        <View style={jiraStyles.card}>
          {transitions.map((transition, index) => (
            <OptionRow
              key={transition.id}
              value={transition.id}
              label={transition.name}
              last={index === transitions.length - 1}
              onPick={pick}
              status={transition.to}
              testID={`jira-transition-option-${transition.id}`}
            />
          ))}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function TransitionFieldsSheet({
  flow,
  target,
  transition,
  running,
  error,
  fieldErrors,
}: {
  flow: TransitionFlow;
  target: TransitionTarget;
  transition: JiraTransition;
  running: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
}) {
  const [draft, setDraft] = useState<FieldDraft>(() => initialDraft(transition.fields));
  const [missing, setMissing] = useState<string[]>([]);
  const { submitFields, cancel } = flow;
  const header = useMemo(
    () => ({ title: `${transition.name} · ${target.issue.key}` }),
    [transition.name, target.issue.key],
  );
  const submit = useCallback(() => {
    const result = draftToInputs(transition.fields, draft);
    setMissing(result.missing);
    if (result.missing.length > 0) return;
    void submitFields(result.inputs);
  }, [draft, submitFields, transition.fields]);
  const change = useCallback((fieldId: string, next: string | string[]) => {
    setDraft((current) => ({ ...current, [fieldId]: next }));
  }, []);
  const footer = useMemo(
    () => (
      <View style={jiraStyles.sheetFooter}>
        <Button variant="ghost" onPress={cancel} disabled={running}>
          Cancel
        </Button>
        <Button
          variant="default"
          onPress={submit}
          loading={running}
          testID="jira-transition-submit"
        >
          {transition.name}
        </Button>
      </View>
    ),
    [cancel, running, submit, transition.name],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={cancel}
      header={header}
      footer={footer}
      testID="jira-transition-dialog"
    >
      <View style={jiraStyles.sheetBody}>
        {error ? <ErrorBanner message={error} /> : null}
        {missing.length > 0 ? <ErrorBanner message={`Required: ${missing.join(", ")}`} /> : null}
        {transition.fields.map((field) => (
          <FieldInput
            key={field.fieldId}
            field={field}
            draft={draft[field.fieldId]}
            error={fieldErrors[field.fieldId] ?? null}
            onChange={change}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

export function TransitionDialogs({ flow }: { flow: TransitionFlow }) {
  const { state } = flow;
  if (state.kind === "choose") {
    return (
      <ChooseTransitionSheet flow={flow} target={state.target} transitions={state.transitions} />
    );
  }
  if (state.kind === "fields") {
    return (
      <TransitionFieldsSheet
        key={`${state.target.issue.key}:${state.transition.id}`}
        flow={flow}
        target={state.target}
        transition={state.transition}
        running={state.running}
        error={state.error}
        fieldErrors={state.fieldErrors}
      />
    );
  }
  return null;
}
