import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FolderOpen, Save, Trash2 } from "lucide-react-native";
import type { SshWorkspaceTemplate } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SnippetsApi } from "./api";
import { useDeleteWorkspace, useSaveWorkspace, useWorkspaceTemplates } from "./queries";
import {
  fromTemplateLayout,
  paneIds,
  getPane,
  toTemplateLayout,
  type SplitWorkspace,
} from "./split-layout";
import { SshEmpty, SshField, SshRow, SshSection, sshStyles } from "./ui";

export interface WorkspaceTemplatesListProps {
  api: SnippetsApi;
  serverLabels: Readonly<Record<string, string>>;
  /** The open workspace, offered for "Save as template". */
  current?: SplitWorkspace;
  /** The owner opens one connection per server pane of the reopened workspace. */
  onOpen: (workspace: SplitWorkspace, template: SshWorkspaceTemplate) => void;
}

function describePanes(
  template: SshWorkspaceTemplate,
  serverLabels: Readonly<Record<string, string>>,
  localLabel: string,
): string {
  const workspace = fromTemplateLayout(template.layout);
  return paneIds(workspace)
    .map((id) => {
      const pane = getPane(workspace, id);
      if (pane.tabTitle) return pane.tabTitle;
      return pane.target.kind === "server"
        ? (serverLabels[pane.target.serverId] ?? pane.target.serverId)
        : localLabel;
    })
    .join(", ");
}

/** Workspace templates (spec 25.4): save the layout + server of each pane, reopen it. */
export function WorkspaceTemplatesList({
  api,
  serverLabels,
  current,
  onOpen,
}: WorkspaceTemplatesListProps) {
  const { t } = useTranslation();
  const templates = useWorkspaceTemplates(api);
  const save = useSaveWorkspace(api);
  const [label, setLabel] = useState("");
  const { mutate: mutateSave } = save;
  const saveCurrent = useCallback(() => {
    if (!current) return;
    mutateSave({ label, layout: toTemplateLayout(current) }, { onSuccess: () => setLabel("") });
  }, [mutateSave, label, current]);

  return (
    <ScrollView contentContainerStyle={sshStyles.padded} testID="ssh-workspace-templates">
      {current ? (
        <View style={sshStyles.stack}>
          <SshField
            label={t("ssh.snippets.templates.name")}
            value={label}
            onChangeText={setLabel}
            testID="ssh-workspace-template-label"
          />
          {save.error ? (
            <Alert
              variant="error"
              title={t("ssh.snippets.templates.saveFailed")}
              description={save.error.message}
            />
          ) : null}
          {save.isSuccess ? (
            <Text style={sshStyles.successText}>{t("ssh.snippets.templates.saved")}</Text>
          ) : null}
          <View style={sshStyles.rowActions}>
            <Button
              size="sm"
              variant="default"
              leftIcon={Save}
              disabled={label.trim() === ""}
              loading={save.isPending}
              onPress={saveCurrent}
              testID="ssh-workspace-template-save"
            >
              {t("ssh.snippets.templates.saveCurrent")}
            </Button>
          </View>
        </View>
      ) : null}
      <SshSection title={t("ssh.snippets.templates.title")}>
        {templates.error ? (
          <Alert
            variant="error"
            title={t("ssh.snippets.templates.loadFailed")}
            description={templates.error.message}
          />
        ) : null}
        {templates.isPending ? <SshEmpty text={t("common.loading")} /> : null}
        {templates.isSuccess && templates.data.length === 0 ? (
          <SshEmpty text={t("ssh.snippets.templates.empty")} />
        ) : null}
        {(templates.data ?? []).map((template) => (
          <TemplateRow
            key={template.id}
            api={api}
            template={template}
            summary={describePanes(
              template,
              serverLabels,
              t("ssh.snippets.templates.localTerminal"),
            )}
            onOpen={onOpen}
          />
        ))}
      </SshSection>
    </ScrollView>
  );
}

function TemplateRow({
  api,
  template,
  summary,
  onOpen,
}: {
  api: SnippetsApi;
  template: SshWorkspaceTemplate;
  summary: string;
  onOpen: (workspace: SplitWorkspace, template: SshWorkspaceTemplate) => void;
}) {
  const { t } = useTranslation();
  const remove = useDeleteWorkspace(api);
  const { mutate: mutateRemove } = remove;
  const open = useCallback(
    () => onOpen(fromTemplateLayout(template.layout), template),
    [onOpen, template],
  );
  const removeTemplate = useCallback(() => mutateRemove(template.id), [mutateRemove, template.id]);
  const count = paneIds(fromTemplateLayout(template.layout)).length;
  return (
    <SshRow testID={`ssh-workspace-template-${template.id}`}>
      <Text style={sshStyles.rowTitle}>{template.label}</Text>
      <Text style={sshStyles.rowMeta} numberOfLines={2}>
        {t("ssh.snippets.templates.panes", { count, summary })}
      </Text>
      <View style={sshStyles.rowActions}>
        <Button size="xs" variant="outline" leftIcon={FolderOpen} onPress={open}>
          {t("ssh.snippets.templates.open")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={Trash2}
          loading={remove.isPending}
          onPress={removeTemplate}
        >
          {t("ssh.snippets.library.delete")}
        </Button>
      </View>
      {remove.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.templates.deleteFailed")}
          description={remove.error.message}
        />
      ) : null}
    </SshRow>
  );
}
