import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import {
  isValidSkillName,
  SKILL_DESCRIPTION_MAX_LENGTH,
  type SkillEntry,
} from "@jagentdesk/protocol/native-skills";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { refreshSkillCatalogs } from "@/stores/skills-store";
import {
  skillErrorCode,
  skillErrorMessage,
  type SkillProjectOption,
} from "@/skills/native-skill-logic";
import {
  ScopePicker,
  scopeIsComplete,
  scopeRequest,
  type ScopeValue,
} from "@/skills/ui/scope-picker";
import type { Theme } from "@/styles/theme";

export interface SkillDraftInput {
  name: string;
  description: string;
  body: string;
}

export interface SkillDraftErrors {
  name: string | null;
  description: string | null;
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** Spec 22.6 "Create skill" validation (Agent Skills naming + description length). */
export function validateSkillDraft(
  draft: SkillDraftInput,
  isEdit: boolean,
  t: Translate,
): SkillDraftErrors {
  const name =
    isEdit || isValidSkillName(draft.name.trim()) ? null : t("skillsHub.editor.nameInvalid");
  const description = draft.description.trim();
  const descriptionError =
    description.length === 0 || description.length > SKILL_DESCRIPTION_MAX_LENGTH
      ? t("skillsHub.editor.descriptionRequired")
      : null;
  return { name, description: descriptionError };
}

interface EditorFormProps {
  initial: SkillDraftInput;
  isEdit: boolean;
  resetKey: string;
  scope: ScopeValue;
  onScopeChange: (value: ScopeValue) => void;
  projects: SkillProjectOption[];
  saving: boolean;
  serverError: string | null;
  onSave: (draft: SkillDraftInput) => void;
  onCancel: () => void;
}

function EditorForm(props: EditorFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SkillDraftInput>(props.initial);
  const [submitted, setSubmitted] = useState(false);
  const errors = validateSkillDraft(draft, props.isEdit, t);
  const setName = useCallback((name: string) => setDraft((prev) => ({ ...prev, name })), []);
  const setDescription = useCallback(
    (description: string) => setDraft((prev) => ({ ...prev, description })),
    [],
  );
  const setBody = useCallback((body: string) => setDraft((prev) => ({ ...prev, body })), []);
  const { onSave } = props;
  const handleSave = useCallback(() => {
    setSubmitted(true);
    const current = validateSkillDraft(draft, props.isEdit, t);
    if (current.name || current.description) return;
    onSave(draft);
  }, [draft, onSave, props.isEdit, t]);
  const canSave = scopeIsComplete(props.scope) && !props.saving;
  return (
    <View style={styles.form}>
      {props.isEdit ? null : (
        <Field
          label={t("skillsHub.editor.name")}
          hint={t("skillsHub.editor.nameHint")}
          error={submitted ? errors.name : null}
        >
          <FormTextInput
            initialValue={props.initial.name}
            resetKey={`name-${props.resetKey}`}
            onChangeText={setName}
            placeholder="release-notes"
            autoCapitalize="none"
            autoCorrect={false}
            testID="skills-editor-name"
          />
        </Field>
      )}
      <Field
        label={t("skillsHub.editor.description")}
        hint={t("skillsHub.editor.descriptionHint")}
        error={submitted ? errors.description : null}
      >
        <FormTextInput
          initialValue={props.initial.description}
          resetKey={`description-${props.resetKey}`}
          onChangeText={setDescription}
          testID="skills-editor-description"
        />
      </Field>
      <Field label={t("skillsHub.editor.body")}>
        <FormTextInput
          initialValue={props.initial.body}
          resetKey={`body-${props.resetKey}`}
          onChangeText={setBody}
          placeholder={t("skillsHub.editor.bodyPlaceholder")}
          multiline
          style={styles.bodyInput}
          testID="skills-editor-body"
        />
      </Field>
      {props.isEdit ? null : (
        <ScopePicker
          label={t("skillsHub.editor.scope")}
          value={props.scope}
          onChange={props.onScopeChange}
          projects={props.projects}
        />
      )}
      {props.serverError ? <Text style={styles.error}>{props.serverError}</Text> : null}
      <View style={styles.footer}>
        <Button variant="outline" size="sm" onPress={props.onCancel}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={handleSave}
          loading={props.saving}
          disabled={!canSave}
          testID="skills-editor-save"
        >
          {props.isEdit ? t("skillsHub.editor.save") : t("skillsHub.editor.create")}
        </Button>
      </View>
    </View>
  );
}

export interface SkillEditorSheetProps {
  serverId: string;
  client: DaemonClient | null;
  /** The owned skill to edit; null creates a new skill. */
  entry: SkillEntry | null;
  projects: SkillProjectOption[];
  defaultProjectPath: string | null;
  onClose: () => void;
  onSaved?: (entry: SkillEntry) => void;
}

const EMPTY_DRAFT: SkillDraftInput = { name: "", description: "", body: "" };

function useSaveSkill(props: SkillEditorSheetProps, scope: ScopeValue) {
  const { t } = useTranslation();
  const toast = useToast();
  const { client, entry, onClose, onSaved } = props;
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const save = useCallback(
    async (draft: SkillDraftInput) => {
      if (!client) return;
      setSaving(true);
      setServerError(null);
      const target = entry
        ? {
            skillId: entry.skillId,
            scope: entry.scope,
            ...(entry.projectRoot ? { cwd: entry.projectRoot } : {}),
          }
        : scopeRequest(scope);
      try {
        const { skill } = await client.authorSkill({
          ...target,
          name: entry ? entry.name : draft.name.trim(),
          description: draft.description.trim(),
          body: draft.body,
        });
        toast.show(
          t(entry ? "skillsHub.editor.saved" : "skillsHub.editor.created", { name: skill.name }),
          {
            variant: "success",
          },
        );
        refreshSkillCatalogs();
        onClose();
        onSaved?.(skill);
      } catch (error) {
        setServerError(
          skillErrorCode(error) === "skill_name_conflict"
            ? t("skillsHub.editor.conflict")
            : skillErrorMessage(error),
        );
      } finally {
        setSaving(false);
      }
    },
    [client, entry, onClose, onSaved, scope, t, toast],
  );
  return { saving, serverError, save };
}

/** Create a SKILL.md skill, or edit an owned one's description and instructions. */
export function SkillEditorSheet(props: SkillEditorSheetProps) {
  const { t } = useTranslation();
  const { serverId, client, entry, onClose } = props;
  const [scope, setScope] = useState<ScopeValue>({
    scope: "global",
    projectPath: props.defaultProjectPath,
  });
  const { saving, serverError, save } = useSaveSkill(props, scope);
  const existing = useFetchQuery({
    queryKey: ["skills-editor", serverId, entry?.skillId ?? ""],
    queryFn: async () => {
      if (!client || !entry) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getNativeSkill(
        entry.skillId,
        entry.projectRoot ? { cwd: entry.projectRoot } : {},
      );
    },
    enabled: Boolean(client && entry),
    dataShape: "value",
    staleTimeMs: 0,
  });
  const header = useMemo<SheetHeader>(
    () => ({
      title: entry
        ? t("skillsHub.editor.editTitle", { name: entry.name })
        : t("skillsHub.editor.createTitle"),
      back: { onPress: onClose },
    }),
    [entry, onClose, t],
  );
  const initial = useMemo<SkillDraftInput | null>(() => {
    if (!entry) return EMPTY_DRAFT;
    if (!existing.data) return null;
    return { name: entry.name, description: entry.description, body: existing.data.body };
  }, [entry, existing.data]);
  const handleSave = useCallback((draft: SkillDraftInput) => void save(draft), [save]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="skills-editor-sheet"
      contentStyle={styles.body}
      desktopMaxWidth={640}
    >
      {initial ? (
        <EditorForm
          initial={initial}
          isEdit={Boolean(entry)}
          resetKey={entry?.skillId ?? "new"}
          scope={scope}
          onScopeChange={setScope}
          projects={props.projects}
          saving={saving}
          serverError={serverError}
          onSave={handleSave}
          onCancel={onClose}
        />
      ) : (
        <Text style={styles.muted}>{t("skillsHub.detail.loading")}</Text>
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[6] },
  form: { gap: theme.spacing[3] },
  bodyInput: { minHeight: 180, textAlignVertical: "top" },
  error: { fontSize: theme.fontSize.xs, color: theme.colors.statusDanger },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
