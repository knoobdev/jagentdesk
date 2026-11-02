import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { SshSnippet, SshSnippetRun } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { SSH_WORKSPACE_MAX_PANES } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SnippetsApi } from "./api";
import { useSaveSnippet, useStartRun } from "./queries";
import type { SnippetServerOption } from "./snippet-editor";
import { serverIdsInGroup, toggleGroupSelection, type PickerGroup } from "./library-model";
import { planSnippetWorkspace, type SnippetWorkspacePlan } from "./snippet-input";
import { SshChip, SshSearchInput, sshStyles } from "./ui";

export interface SnippetRunPickerProps {
  api: SnippetsApi;
  snippet: SshSnippet;
  servers: readonly SnippetServerOption[];
  groups: readonly PickerGroup[];
  /** Termius flow: a new workspace, one terminal pane per server, typing the snippet. */
  onRunInWorkspace: (plan: SnippetWorkspacePlan) => void;
  /** Collect output and exit codes over `exec` instead of terminals. */
  onRunStarted: (run: SshSnippetRun) => void;
  onCancel: () => void;
}

function matches(server: SnippetServerOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [server.label, server.address ?? ""].some((field) => field.toLowerCase().includes(needle));
}

/** Pick the servers a snippet runs on (spec 25.7), optionally saving them as targets. */
export function SnippetRunPicker({
  api,
  snippet,
  servers,
  groups,
  onRunInWorkspace,
  onRunStarted,
  onCancel,
}: SnippetRunPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(() =>
    snippet.defaultTargets.filter((id) => servers.some((server) => server.id === id)),
  );
  const startRun = useStartRun(api);
  const saveTargets = useSaveSnippet(api);
  const visible = useMemo(() => servers.filter((s) => matches(s, query)), [servers, query]);
  const labels = useMemo(
    () => Object.fromEntries(servers.map((server) => [server.id, server.label])),
    [servers],
  );
  const tooMany = selected.length > SSH_WORKSPACE_MAX_PANES;
  const nothingSelected = selected.length === 0;

  const toggleServer = useCallback((id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }, []);

  const selectVisible = useCallback(
    () => setSelected(visible.map((server) => server.id)),
    [visible],
  );
  const clearSelection = useCallback(() => setSelected([]), []);
  // Only groups that hold at least one server (directly or through sub-groups) are offered.
  const groupOptions = useMemo(
    () =>
      groups
        .map((group) => ({ group, serverIds: serverIdsInGroup(group.id, servers, groups) }))
        .filter((option) => option.serverIds.length > 0),
    [groups, servers],
  );
  const toggleGroup = useCallback(
    (groupId: string) => {
      const option = groupOptions.find((candidate) => candidate.group.id === groupId);
      if (!option) return;
      setSelected((current) => toggleGroupSelection(current, option.serverIds));
    },
    [groupOptions],
  );

  const runInWorkspace = useCallback(() => {
    onRunInWorkspace(
      planSnippetWorkspace({
        serverIds: selected,
        labelsByServerId: labels,
        script: snippet.script,
      }),
    );
  }, [onRunInWorkspace, selected, labels, snippet.script]);

  const collectOutput = useCallback(() => {
    startRun.mutate(
      { source: { kind: "snippet", snippetId: snippet.id }, serverIds: selected },
      { onSuccess: onRunStarted },
    );
  }, [startRun, snippet.id, selected, onRunStarted]);

  const storeTargets = useCallback(() => {
    saveTargets.mutate({
      id: snippet.id,
      label: snippet.label,
      script: snippet.script,
      ...(snippet.packageId ? { packageId: snippet.packageId } : {}),
      defaultTargets: selected,
    });
  }, [saveTargets, snippet, selected]);

  return (
    <View style={sshStyles.padded} testID="ssh-snippet-run-picker">
      <View style={sshStyles.stack}>
        <Text style={sshStyles.rowTitle}>{snippet.label}</Text>
        <Text style={sshStyles.mono} numberOfLines={3}>
          {snippet.script}
        </Text>
      </View>
      <SshSearchInput
        value={query}
        onChangeText={setQuery}
        placeholder={t("ssh.snippets.run.searchServers")}
        testID="ssh-snippet-run-search"
      />
      <View style={sshStyles.inlineRow}>
        <Text style={[sshStyles.rowMeta, sshStyles.grow]}>
          {t("ssh.snippets.run.selectedCount", { count: selected.length })}
        </Text>
        <Button size="sm" variant="ghost" onPress={selectVisible}>
          {t("ssh.snippets.run.selectAll")}
        </Button>
        <Button size="sm" variant="ghost" onPress={clearSelection}>
          {t("ssh.snippets.run.clearSelection")}
        </Button>
      </View>
      {groupOptions.length > 0 ? (
        <View style={sshStyles.stack}>
          <Text style={sshStyles.rowMeta}>
            {`${t("ssh.snippets.run.groups")} · ${t("ssh.snippets.run.groupsHint")}`}
          </Text>
          <View style={sshStyles.chips}>
            {groupOptions.map(({ group, serverIds }) => (
              <SshChip
                key={group.id}
                label={`${group.label} (${serverIds.length})`}
                value={group.id}
                active={serverIds.every((id) => selected.includes(id))}
                onSelect={toggleGroup}
                testID={`ssh-snippet-target-group-${group.id}`}
              />
            ))}
          </View>
        </View>
      ) : null}
      <View style={sshStyles.chips}>
        {visible.map((server) => (
          <SshChip
            key={server.id}
            label={server.label}
            value={server.id}
            active={selected.includes(server.id)}
            onSelect={toggleServer}
            testID={`ssh-snippet-target-${server.id}`}
          />
        ))}
      </View>
      {tooMany ? (
        <Text style={sshStyles.warningText}>
          {t("ssh.snippets.run.tooManyForWorkspace", { max: SSH_WORKSPACE_MAX_PANES })}
        </Text>
      ) : null}
      {startRun.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.run.startFailed")}
          description={startRun.error.message}
        />
      ) : null}
      {saveTargets.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.run.saveTargetsFailed")}
          description={saveTargets.error.message}
        />
      ) : null}
      {saveTargets.isSuccess ? (
        <Text style={sshStyles.successText}>{t("ssh.snippets.run.targetsSaved")}</Text>
      ) : null}
      <View style={sshStyles.rowActions}>
        <Button
          variant="default"
          onPress={runInWorkspace}
          disabled={nothingSelected || tooMany}
          testID="ssh-snippet-run-workspace"
        >
          {t("ssh.snippets.run.runInWorkspace")}
        </Button>
        <Button
          variant="outline"
          onPress={collectOutput}
          disabled={nothingSelected}
          loading={startRun.isPending}
          testID="ssh-snippet-run-collect"
        >
          {t("ssh.snippets.run.collectOutput")}
        </Button>
        <Button
          variant="ghost"
          onPress={storeTargets}
          loading={saveTargets.isPending}
          testID="ssh-snippet-save-targets"
        >
          {t("ssh.snippets.run.saveTargets")}
        </Button>
        <Button variant="ghost" onPress={onCancel}>
          {t("common.actions.cancel")}
        </Button>
      </View>
    </View>
  );
}
