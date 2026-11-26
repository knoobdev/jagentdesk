import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MemoryRecordWire } from "@jagentdesk/protocol/memory";
import type { MemoryScope } from "../shared/types";
import {
  AdaptiveModalSheet,
  Button,
  Field,
  FormTextInput,
  SegmentedControl,
  Switch,
  type SegmentedControlOption,
  useHostRuntimeClient,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { parseTags } from "./use-memory";

const TEXT_LIMIT = 1_000;

export type MemoryEditorTarget =
  | {
      kind: "create";
      scope: MemoryScope;
      projectId: string | null;
      agentId?: string;
      text?: string;
    }
  | { kind: "edit"; memory: MemoryRecordWire };

/** Add or edit one memory. The daemon refuses secrets; its message shows under the text. */
export function MemoryEditorSheet({
  serverId,
  target,
  onClose,
  onSaved,
}: {
  serverId: string;
  target: MemoryEditorTarget;
  onClose: () => void;
  onSaved?: (memory: MemoryRecordWire) => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const editing = target.kind === "edit" ? target.memory : null;
  // AdaptiveTextInput is uncontrolled on native: it reads initialValue once.
  const [initialText] = useState(
    editing?.text ?? (target.kind === "create" ? (target.text ?? "") : ""),
  );
  const [initialTags] = useState(editing?.tags.join(", ") ?? "");
  const [text, setText] = useState(initialText);
  const [tags, setTags] = useState(initialTags);
  const [pinned, setPinned] = useState(editing?.pinned ?? false);
  const [scope, setScope] = useState<MemoryScope>(
    editing?.scope ?? (target.kind === "create" ? target.scope : "project"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const result = await client.saveMemory(
        editing
          ? { id: editing.id, text, tags: parseTags(tags), pinned }
          : {
              scope,
              text,
              tags: parseTags(tags),
              pinned,
              ...(target.kind === "create" && target.projectId
                ? { projectId: target.projectId }
                : {}),
              ...(target.kind === "create" && target.agentId ? { agentId: target.agentId } : {}),
            },
      );
      onSaved?.(result.memory);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [client, editing, onClose, onSaved, pinned, scope, tags, target, text]);

  const handleSave = useCallback(() => void save(), [save]);
  const saveDisabled = !client || saving || text.trim().length === 0 || text.length > TEXT_LIMIT;
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="ghost" size="sm" onPress={onClose}>
          {t("memory.editor.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={handleSave}
          disabled={saveDisabled}
          testID="memory-editor-save"
        >
          {t("memory.editor.save")}
        </Button>
      </View>
    ),
    [handleSave, onClose, saveDisabled, t],
  );
  const header = useMemo(
    () => ({ title: editing ? t("memory.editor.editTitle") : t("memory.editor.newTitle") }),
    [editing, t],
  );
  const scopeOptions = useMemo<SegmentedControlOption<MemoryScope>[]>(
    () => [
      { value: "project", label: t("memory.tabs.project"), disabled: !hasProject(target) },
      { value: "global", label: t("memory.tabs.global") },
    ],
    [t, target],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={560}
      testID="memory-editor"
    >
      <View style={styles.body}>
        {editing ? null : (
          <Field label={t("memory.editor.scope")}>
            <SegmentedControl
              options={scopeOptions}
              value={scope}
              onValueChange={setScope}
              testID="memory-editor-scope"
            />
          </Field>
        )}
        <Field label={t("memory.editor.text")} hint={t("memory.editor.textHint")} error={error}>
          <FormTextInput
            initialValue={initialText}
            value={text}
            webControlled
            onChangeText={setText}
            multiline
            autoFocus
            maxLength={TEXT_LIMIT}
            style={styles.textInput}
            testID="memory-editor-text"
          />
        </Field>
        <Text style={styles.counter}>
          {text.length}/{TEXT_LIMIT}
        </Text>
        <Field label={t("memory.editor.tags")} hint={t("memory.editor.tagsHint")}>
          <FormTextInput
            initialValue={initialTags}
            value={tags}
            webControlled
            onChangeText={setTags}
            testID="memory-editor-tags"
          />
        </Field>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t("memory.editor.pinned")}</Text>
          <Switch value={pinned} onValueChange={setPinned} testID="memory-editor-pinned" />
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function hasProject(target: MemoryEditorTarget): boolean {
  if (target.kind === "edit") return true;
  return Boolean(target.projectId || target.agentId);
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[3] },
  textInput: { minHeight: 120, textAlignVertical: "top" },
  counter: {
    alignSelf: "flex-end",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: -theme.spacing[2],
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  switchLabel: { fontSize: 14, color: theme.colors.foreground, flexShrink: 1 },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
