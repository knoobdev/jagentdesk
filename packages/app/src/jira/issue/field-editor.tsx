import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import type {
  JiraUser,
  JiraFieldInput,
  JiraFieldValue,
  JiraFieldView,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { Input, UserAvatar } from "../ui/primitives";
import { ValueChip } from "./controls";
import { jiraStyles } from "../ui/styles";
import { UserPicker } from "./user-picker";

// Editors for one Jira field, by the kind the daemon derived from editmeta / screen metadata
// (text, textarea, number, date, user, labels, option, options). Controlled: the parent holds
// the draft JiraFieldInput and decides when to send it.

export function fieldDisplay(value: JiraFieldValue): string | null {
  switch (value.kind) {
    case "text":
      return value.text;
    case "number":
      return value.number === null ? null : String(value.number);
    case "date":
      return value.date;
    case "user":
      return value.user?.displayName ?? null;
    case "labels":
      return value.labels.length > 0 ? value.labels.join(", ") : null;
    case "option":
      return value.option?.name ?? null;
    case "options":
      return value.options.length > 0
        ? value.options.map((option) => option.name).join(", ")
        : null;
  }
}

// oxlint-disable-next-line complexity
export function initialInput(field: JiraFieldView): JiraFieldInput | null {
  const value = field.value;
  switch (field.kind) {
    case "text":
      return { kind: "text", text: value.kind === "text" ? value.text : null };
    case "textarea":
      return { kind: "markdown", markdown: value.kind === "text" ? (value.text ?? "") : "" };
    case "number":
      return { kind: "number", number: value.kind === "number" ? value.number : null };
    case "date":
      return { kind: "date", date: value.kind === "date" ? value.date : null };
    case "user":
      return { kind: "user", ref: value.kind === "user" ? (value.user?.ref ?? null) : null };
    case "labels":
      return { kind: "labels", labels: value.kind === "labels" ? value.labels : [] };
    case "option":
      return { kind: "option", id: value.kind === "option" ? (value.option?.id ?? null) : null };
    case "options":
      return {
        kind: "options",
        ids: value.kind === "options" ? value.options.map((o) => o.id) : [],
      };
    case "readonly":
      return null;
  }
}

/** True when a required field still has no value in the draft. */
export function isMissing(input: JiraFieldInput | null): boolean {
  if (!input) return true;
  switch (input.kind) {
    case "text":
      return !input.text?.trim();
    case "markdown":
      return !input.markdown.trim();
    case "number":
      return input.number === null;
    case "date":
      return !input.date;
    case "user":
      return input.ref === null;
    case "labels":
      return input.labels.length === 0;
    case "option":
      return input.id === null;
    case "options":
      return input.ids.length === 0;
  }
}

interface EditorProps {
  field: JiraFieldView;
  value: JiraFieldInput | null;
  onChange: (value: JiraFieldInput) => void;
  serverId: string;
  connectionId: string;
  issueKey: string;
}

function OptionEditor({ field, value, onChange }: EditorProps) {
  const selected = value?.kind === "option" ? value.id : null;
  const allowed = field.allowedValues ?? [];
  const testID = `jira-field-${field.fieldId}`;
  const select = useCallback((id: string | null) => onChange({ kind: "option", id }), [onChange]);
  return (
    <View style={jiraStyles.rowWrap}>
      {field.required ? null : (
        <ValueChip
          label="None"
          value={null}
          active={selected === null}
          onSelect={select}
          testID={`${testID}-none`}
        />
      )}
      {allowed.map((option) => (
        <ValueChip
          key={option.id}
          label={option.name}
          value={option.id}
          active={selected === option.id}
          onSelect={select}
          testID={`${testID}-option-${option.id}`}
        />
      ))}
    </View>
  );
}

function OptionsEditor({ field, value, onChange }: EditorProps) {
  const selected = value?.kind === "options" ? value.ids : NO_IDS;
  const toggle = useCallback(
    (id: string) => {
      const next = selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id];
      onChange({ kind: "options", ids: next });
    },
    [onChange, selected],
  );
  return (
    <View style={jiraStyles.rowWrap}>
      {(field.allowedValues ?? []).map((option) => (
        <ValueChip
          key={option.id}
          label={option.name}
          value={option.id}
          active={selected.includes(option.id)}
          onSelect={toggle}
        />
      ))}
    </View>
  );
}

const NO_IDS: string[] = [];

function LabelsEditor({ value, onChange }: EditorProps) {
  const labels = value?.kind === "labels" ? value.labels : NO_IDS;
  const [draft, setDraft] = useState("");
  const add = useCallback(() => {
    const label = draft.trim().replace(/\s+/g, "-");
    if (label && !labels.includes(label)) onChange({ kind: "labels", labels: [...labels, label] });
    setDraft("");
  }, [draft, labels, onChange]);
  const remove = useCallback(
    (label: string) =>
      onChange({ kind: "labels", labels: labels.filter((item) => item !== label) }),
    [labels, onChange],
  );
  return (
    <View style={jiraStyles.sheetBody}>
      <View style={jiraStyles.rowWrap}>
        {labels.map((label) => (
          <ValueChip key={label} label={`${label} ×`} value={label} active onSelect={remove} />
        ))}
      </View>
      <Input
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={add}
        placeholder="Add a label and press Enter"
        testID="jira-labels-input"
      />
    </View>
  );
}

function UserEditor(props: EditorProps) {
  const { field, value, onChange } = props;
  const ref = value?.kind === "user" ? value.ref : null;
  const current = field.value.kind === "user" ? field.value.user : null;
  const [picked, setPicked] = useState(current);
  const shown = ref === null ? null : picked;
  const clear = useCallback(() => onChange({ kind: "user", ref: null }), [onChange]);
  const pick = useCallback(
    (user: JiraUser) => {
      setPicked(user);
      onChange({ kind: "user", ref: user.ref });
    },
    [onChange],
  );
  return (
    <View style={jiraStyles.sheetBody}>
      <View style={jiraStyles.row}>
        <UserAvatar user={shown} size={22} />
        <Text style={jiraStyles.text}>{shown?.displayName ?? "Unassigned"}</Text>
        <View style={jiraStyles.spacer} />
        {field.required ? null : (
          <Button size="sm" variant="ghost" onPress={clear}>
            Clear
          </Button>
        )}
      </View>
      <UserPicker
        serverId={props.serverId}
        connectionId={props.connectionId}
        issueKey={props.issueKey}
        onPick={pick}
        testID={`jira-field-${field.fieldId}-user`}
      />
    </View>
  );
}

function TextEditor({ field, value, onChange }: EditorProps) {
  const testID = `jira-field-${field.fieldId}-input`;
  const isArea = field.kind === "textarea";
  const change = useCallback(
    (text: string) =>
      onChange(isArea ? { kind: "markdown", markdown: text } : { kind: "text", text }),
    [isArea, onChange],
  );
  let text = "";
  if (value?.kind === "markdown") text = value.markdown;
  if (value?.kind === "text") text = value.text ?? "";
  return <Input multiline={isArea} value={text} onChangeText={change} testID={testID} />;
}

function NumberEditor({ field, value, onChange }: EditorProps) {
  const change = useCallback(
    (text: string) => {
      const parsed = Number(text);
      const empty = text.trim() === "" || !Number.isFinite(parsed);
      onChange({ kind: "number", number: empty ? null : parsed });
    },
    [onChange],
  );
  const shown = value?.kind === "number" && value.number !== null ? String(value.number) : "";
  return (
    <Input
      value={shown}
      onChangeText={change}
      keyboardType="decimal-pad"
      testID={`jira-field-${field.fieldId}-input`}
    />
  );
}

function DateEditor({ field, value, onChange }: EditorProps) {
  const change = useCallback(
    (text: string) => onChange({ kind: "date", date: text.trim() === "" ? null : text.trim() }),
    [onChange],
  );
  return (
    <Input
      value={value?.kind === "date" ? (value.date ?? "") : ""}
      onChangeText={change}
      placeholder="YYYY-MM-DD"
      testID={`jira-field-${field.fieldId}-input`}
    />
  );
}

export function FieldEditor(props: EditorProps) {
  switch (props.field.kind) {
    case "text":
    case "textarea":
      return <TextEditor {...props} />;
    case "number":
      return <NumberEditor {...props} />;
    case "date":
      return <DateEditor {...props} />;
    case "user":
      return <UserEditor {...props} />;
    case "labels":
      return <LabelsEditor {...props} />;
    case "option":
      return <OptionEditor {...props} />;
    case "options":
      return <OptionsEditor {...props} />;
    case "readonly":
      return <Text style={jiraStyles.textMuted}>{fieldDisplay(props.field.value) ?? "None"}</Text>;
  }
}
