import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import type {
  JiraFieldInput,
  JiraFieldValue,
  JiraFieldView,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { Field, Input } from "../ui/primitives";
import { KeyedChip } from "./keyed";
import { jiraStyles } from "../ui/styles";

// Inputs for the fields of a transition screen (spec 29.3: "transition có màn hình bắt buộc →
// hộp thoại field bắt buộc"). A draft holds what the user typed; it becomes JiraFieldInput values
// only for the fields the user filled.

export type FieldDraft = Record<string, string | string[]>;

function valueToDraft(value: JiraFieldValue): string | string[] {
  switch (value.kind) {
    case "text":
      return value.text ?? "";
    case "number":
      return value.number === null ? "" : String(value.number);
    case "date":
      return value.date ?? "";
    case "user":
      return value.user?.ref ?? "";
    case "labels":
      return value.labels.join(", ");
    case "option":
      return value.option?.id ?? "";
    case "options":
      return value.options.map((option) => option.id);
  }
}

export function initialDraft(fields: JiraFieldView[]): FieldDraft {
  return Object.fromEntries(fields.map((field) => [field.fieldId, valueToDraft(field.value)]));
}

function single(draft: string | string[] | undefined): string {
  return typeof draft === "string" ? draft.trim() : "";
}

function many(draft: string | string[] | undefined): string[] {
  return Array.isArray(draft) ? draft : [];
}

// oxlint-disable-next-line complexity
function toInput(
  field: JiraFieldView,
  draft: string | string[] | undefined,
): JiraFieldInput | null {
  const text = single(draft);
  switch (field.kind) {
    case "text":
      return text ? { kind: "text", text } : null;
    case "textarea":
      return text ? { kind: "markdown", markdown: text } : null;
    case "number":
      return text && Number.isFinite(Number(text))
        ? { kind: "number", number: Number(text) }
        : null;
    case "date":
      return text ? { kind: "date", date: text } : null;
    case "user":
      return text ? { kind: "user", ref: text } : null;
    case "labels": {
      const labels = text
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean);
      return labels.length > 0 ? { kind: "labels", labels } : null;
    }
    case "option":
      return text ? { kind: "option", id: text } : null;
    case "options":
      return many(draft).length > 0 ? { kind: "options", ids: many(draft) } : null;
    case "readonly":
      return null;
  }
}

export interface DraftResult {
  inputs: Record<string, JiraFieldInput>;
  /** Names of required fields left empty. */
  missing: string[];
}

export function draftToInputs(fields: JiraFieldView[], draft: FieldDraft): DraftResult {
  const inputs: Record<string, JiraFieldInput> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const input = toInput(field, draft[field.fieldId]);
    if (input) inputs[field.fieldId] = input;
    else if (field.required && field.kind !== "readonly") missing.push(field.name);
  }
  return { inputs, missing };
}

const PLACEHOLDERS: Partial<Record<JiraFieldView["kind"], string>> = {
  date: "YYYY-MM-DD",
  labels: "label-one, label-two",
  user: "User ref (accountId or username)",
  number: "0",
};

function OptionChoices({
  field,
  draft,
  onChange,
}: {
  field: JiraFieldView;
  draft: string | string[] | undefined;
  onChange: (fieldId: string, next: string | string[]) => void;
}) {
  const selected = useMemo(
    () => (field.kind === "options" ? many(draft) : [single(draft)]),
    [draft, field.kind],
  );
  const toggle = useCallback(
    (optionId: string) => {
      const active = selected.includes(optionId);
      if (field.kind !== "options") {
        onChange(field.fieldId, active ? "" : optionId);
        return;
      }
      const next = active ? selected.filter((id) => id !== optionId) : [...selected, optionId];
      onChange(field.fieldId, next);
    },
    [field.fieldId, field.kind, onChange, selected],
  );
  return (
    <View style={jiraStyles.rowWrap}>
      {(field.allowedValues ?? []).map((option) => (
        <KeyedChip
          key={option.id}
          value={option.id}
          label={option.name}
          active={selected.includes(option.id)}
          onToggle={toggle}
          testID={`jira-field-${field.fieldId}-${option.id}`}
        />
      ))}
    </View>
  );
}

export function FieldInput({
  field,
  draft,
  error,
  onChange,
}: {
  field: JiraFieldView;
  draft: string | string[] | undefined;
  error: string | null;
  onChange: (fieldId: string, next: string | string[]) => void;
}) {
  const label = field.required ? `${field.name} *` : field.name;
  const choice = field.kind === "option" || field.kind === "options";
  const handleText = useCallback(
    (text: string) => onChange(field.fieldId, text),
    [field.fieldId, onChange],
  );
  return (
    <Field label={label}>
      {choice ? <OptionChoices field={field} draft={draft} onChange={onChange} /> : null}
      {!choice && field.kind !== "readonly" ? (
        <Input
          value={single(draft)}
          onChangeText={handleText}
          multiline={field.kind === "textarea"}
          placeholder={PLACEHOLDERS[field.kind]}
          keyboardType={field.kind === "number" ? "numeric" : "default"}
          testID={`jira-field-${field.fieldId}`}
        />
      ) : null}
      {field.kind === "readonly" ? (
        <Text style={jiraStyles.textMuted}>{single(draft) || "—"}</Text>
      ) : null}
      {error ? <Text style={jiraStyles.errorText}>{error}</Text> : null}
    </Field>
  );
}
