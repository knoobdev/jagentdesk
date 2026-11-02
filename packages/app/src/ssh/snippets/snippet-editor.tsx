import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  SshSnippet,
  SshSnippetInput,
  SshSnippetPackage,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SnippetsApi } from "./api";
import { useSaveSnippet } from "./queries";
import { SshChip, SshField, sshStyles } from "./ui";

export interface SnippetServerOption {
  id: string;
  label: string;
  address?: string;
}

export interface SnippetEditorProps {
  api: SnippetsApi;
  packages: readonly SshSnippetPackage[];
  servers: readonly SnippetServerOption[];
  /** Absent → new snippet; `script` alone prefills "Save as snippet" from history. */
  initial?: Partial<SshSnippet>;
  onSaved: (snippet: SshSnippet) => void;
  onCancel: () => void;
}

const NO_PACKAGE = "";

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

/** Create or edit a snippet: label, script, package and saved default targets. */
export function SnippetEditor({
  api,
  packages,
  servers,
  initial,
  onSaved,
  onCancel,
}: SnippetEditorProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [script, setScript] = useState(initial?.script ?? "");
  const [packageId, setPackageId] = useState<string | undefined>(initial?.packageId);
  const [targets, setTargets] = useState<string[]>(initial?.defaultTargets ?? []);
  const save = useSaveSnippet(api);
  const canSave = label.trim() !== "" && script.trim() !== "";

  const submit = useCallback(() => {
    const input: SshSnippetInput = {
      ...(initial?.id ? { id: initial.id } : {}),
      label,
      script,
      ...(packageId ? { packageId } : {}),
      defaultTargets: targets,
    };
    save.mutate(input, { onSuccess: onSaved });
  }, [initial?.id, label, script, packageId, targets, save, onSaved]);

  const selectPackage = useCallback(
    (id: string) => setPackageId(id === NO_PACKAGE ? undefined : id),
    [],
  );
  const toggleTarget = useCallback(
    (id: string) => setTargets((current) => toggle(current, id)),
    [],
  );

  return (
    <View style={sshStyles.padded} testID="ssh-snippet-editor">
      <SshField
        label={t("ssh.snippets.editor.label")}
        value={label}
        onChangeText={setLabel}
        placeholder={t("ssh.snippets.editor.labelPlaceholder")}
        testID="ssh-snippet-label"
      />
      <SshField
        label={t("ssh.snippets.editor.script")}
        value={script}
        onChangeText={setScript}
        placeholder={t("ssh.snippets.editor.scriptPlaceholder")}
        multiline
        mono
        testID="ssh-snippet-script"
      />
      <View style={sshStyles.stack}>
        <Text style={sshStyles.rowMeta}>{t("ssh.snippets.editor.package")}</Text>
        <View style={sshStyles.chips}>
          <SshChip
            value={NO_PACKAGE}
            label={t("ssh.snippets.editor.noPackage")}
            active={packageId === undefined}
            onSelect={selectPackage}
          />
          {packages.map((pkg) => (
            <SshChip
              key={pkg.id}
              value={pkg.id}
              label={pkg.label}
              active={packageId === pkg.id}
              onSelect={selectPackage}
            />
          ))}
        </View>
      </View>
      <View style={sshStyles.stack}>
        <Text style={sshStyles.rowMeta}>{t("ssh.snippets.editor.defaultTargets")}</Text>
        <View style={sshStyles.chips}>
          {servers.map((server) => (
            <SshChip
              key={server.id}
              value={server.id}
              label={server.label}
              active={targets.includes(server.id)}
              onSelect={toggleTarget}
            />
          ))}
        </View>
      </View>
      {save.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.editor.saveFailed")}
          description={save.error.message}
        />
      ) : null}
      <View style={sshStyles.rowActions}>
        <Button
          variant="default"
          onPress={submit}
          disabled={!canSave}
          loading={save.isPending}
          testID="ssh-snippet-save"
        >
          {t("ssh.snippets.editor.save")}
        </Button>
        <Button variant="ghost" onPress={onCancel}>
          {t("common.actions.cancel")}
        </Button>
      </View>
    </View>
  );
}
